//! Plan 2026-06-11-001 U1：`update_node_position` Tauri command。
//!
//! 用户拖动节点的坐标持久化通道（R5/R11）。不走 sidecar HTTP——Bearer token
//! 按设计仅在 Rust 内存流转，不暴露 webview；本命令与 `query_topology` 同款
//! in-process sqlx 写 main pool，复用 mutation buffer + `session_db_changed`
//! 既有通知链（与 sidecar mutation 同构，消费方无需区分来源）。

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::session_store::SessionStore;
use crate::topology_mutation_buffer::TopologyMutationBuffer;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNodePositionRequest {
    session_id: String,
    imac: i64,
    /// 整数坐标契约：前端 Math.round 后提交。x/y 列为 REAL，但整数值的 f64
    /// 表示无损；前端 overlay 写入确认依赖快照坐标与提交值严格相等，
    /// 放开小数坐标前必须同步改前端比对逻辑。
    x: i64,
    y: i64,
    /// 前端拖动开始时记录的最近 mutationId；用于陈旧写检测（R11）。
    expected_mutation_id: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNodePositionResponse {
    pub mutation_id: u64,
}

/// 该 session 在 buffer 中的最大 mutationId。禁用 `since().latest`——那是跨
/// session 全局值，会被其他 session 的 mutation 误触发 stale；记录被 ring
/// buffer 逐出时回退 0（fail-open，与进程重启清零同向）。
fn session_max_mutation_id(buffer: &TopologyMutationBuffer, session_id: &str) -> u64 {
    buffer
        .since(session_id, 0)
        .mutations
        .last()
        .map(|r| r.mutation_id)
        .unwrap_or(0)
}

async fn apply_position_update(
    pool: &SqlitePool,
    buffer: &TopologyMutationBuffer,
    request: &UpdateNodePositionRequest,
) -> Result<crate::topology_mutation_buffer::MutationRecord, String> {
    // R11：严格小于才拒绝——相等放行；重启清零后（buffer max 回 0）首拖不误拒。
    let session_max = session_max_mutation_id(buffer, &request.session_id);
    if request.expected_mutation_id < session_max {
        return Err(format!(
            "stale: topology changed since drag started (expected {}, current {})",
            request.expected_mutation_id, session_max
        ));
    }

    let result = sqlx::query(
        "UPDATE topology_nodes SET x = ?, y = ? WHERE session_id = ? AND imac = ?",
    )
    .bind(request.x)
    .bind(request.y)
    .bind(&request.session_id)
    .bind(request.imac)
    .execute(pool)
    .await
    .map_err(|e| format!("update node position failed: {e}"))?;

    if result.rows_affected() == 0 {
        return Err(format!(
            "node imac {} not found in session {}",
            request.imac, request.session_id
        ));
    }

    Ok(buffer.push(request.session_id.clone(), "topology".into()))
}

/// `session_db_changed` 事件桥：emit_to("main") 失败回退全局 emit。
/// lib.rs 的 sidecar MutationEmitFn 与本命令共用，防 payload 形状双处漂移。
pub fn emit_session_db_changed(
    app: &tauri::AppHandle,
    record: &crate::topology_mutation_buffer::MutationRecord,
) {
    let payload = serde_json::json!({
        "sessionId": record.session_id,
        "domain": record.domain,
        "mutationId": record.mutation_id,
    });
    use tauri::Emitter;
    if app.emit_to("main", "session_db_changed", payload.clone()).is_err() {
        let _ = app.emit("session_db_changed", payload);
    }
}

#[tauri::command]
pub async fn update_node_position(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    buffer: tauri::State<'_, std::sync::Arc<TopologyMutationBuffer>>,
    request: UpdateNodePositionRequest,
) -> Result<UpdateNodePositionResponse, String> {
    let pool = store.pool(&app).await?;
    let record = apply_position_update(&pool, buffer.inner(), &request).await?;
    emit_session_db_changed(&app, &record);
    Ok(UpdateNodePositionResponse { mutation_id: record.mutation_id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool_with_node() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql()).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, imac, sync_name, x, y, sync_type, insert_order) VALUES ('s1', 100, '1', 120, 300, '{}', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn request(expected: u64) -> UpdateNodePositionRequest {
        UpdateNodePositionRequest {
            session_id: "s1".into(),
            imac: 100,
            x: 480,
            y: 96,
            expected_mutation_id: expected,
        }
    }

    #[test]
    fn updates_position_and_pushes_mutation() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool_with_node().await;
            let buffer = TopologyMutationBuffer::default();

            let record = apply_position_update(&pool, &buffer, &request(0)).await.unwrap();
            assert_eq!(record.session_id, "s1");
            assert_eq!(record.domain, "topology");

            let row: (f64, f64) = sqlx::query_as(
                "SELECT x, y FROM topology_nodes WHERE session_id = 's1' AND imac = 100",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row, (480.0, 96.0));
            assert_eq!(buffer.since("s1", 0).mutations.len(), 1);
        });
    }

    #[test]
    fn rejects_stale_expected_mutation_id() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool_with_node().await;
            let buffer = TopologyMutationBuffer::default();
            // 推进该 session 的 mutationId（模拟 initialize 已重建）。
            buffer.push("s1".into(), "topology".into());

            let err = apply_position_update(&pool, &buffer, &request(0)).await.unwrap_err();
            assert!(err.contains("stale"), "expected stale error, got: {err}");
            let row: (f64, f64) = sqlx::query_as(
                "SELECT x, y FROM topology_nodes WHERE session_id = 's1' AND imac = 100",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(row, (120.0, 300.0), "stale write must not mutate coordinates");
        });
    }

    #[test]
    fn other_session_mutations_do_not_trigger_stale() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool_with_node().await;
            let buffer = TopologyMutationBuffer::default();
            // 其他 session 推进全局 mutationId —— per-session 语义下不影响 s1。
            buffer.push("other".into(), "topology".into());
            buffer.push("other".into(), "topology".into());

            apply_position_update(&pool, &buffer, &request(0)).await.unwrap();
        });
    }

    #[test]
    fn unknown_imac_returns_error_without_pushing_mutation() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool_with_node().await;
            let buffer = TopologyMutationBuffer::default();
            let mut req = request(0);
            req.imac = 999;

            let err = apply_position_update(&pool, &buffer, &req).await.unwrap_err();
            assert!(err.contains("not found"));
            assert!(buffer.since("s1", 0).mutations.is_empty(), "failed write must not mint mutation");
        });
    }

    #[test]
    fn db_write_failure_returns_err_without_pushing_mutation() {
        // AE5（后端半）：DB 层失败 → Err、坐标未更新、buffer 未推进。
        // 用缺表的裸库注入失败（表不存在 → UPDATE 报错）。
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            let buffer = TopologyMutationBuffer::default();

            let err = apply_position_update(&pool, &buffer, &request(0)).await.unwrap_err();
            assert!(err.contains("update node position failed"));
            assert!(buffer.since("s1", 0).mutations.is_empty());
        });
    }
}
