//! Plan 2026-06-23-001 U5：`undo_topology` Tauri command（画布「撤销」按钮入口）。
//!
//! 按钮路径不绕 sidecar HTTP——与 `update_node_position` 同款 in-process sqlx，
//! 调同一个纯 Rust 撤销核心 `topology_undo::restore_pre_image`，有快照则复用
//! mutation buffer + `session_db_changed` 既有通知链（与 sidecar undo route 同构，
//! 消费方无需区分来源）。

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::session_store::SessionStore;
use crate::topology_mutation_buffer::TopologyMutationBuffer;
use crate::topology_position_command::emit_session_db_changed;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoTopologyRequest {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoTopologyResponse {
    pub undone: bool,
}

/// 撤销核心调用 + push 决策（不含 emit，便于无 AppHandle 单测）。
/// 有快照（restore 返 true）则盖回 + push 一条 mutation 返回该记录；
/// 无快照返回 None，不 push。
async fn apply_undo(
    pool: &SqlitePool,
    buffer: &TopologyMutationBuffer,
    request: &UndoTopologyRequest,
) -> Result<Option<crate::topology_mutation_buffer::MutationRecord>, String> {
    let restored = crate::topology_undo::restore_pre_image(pool, &request.session_id)
        .await
        .map_err(|e| format!("undo topology failed: {e}"))?;

    if !restored {
        return Ok(None);
    }

    Ok(Some(
        buffer.push(request.session_id.clone(), "topology".into()),
    ))
}

#[tauri::command]
pub async fn undo_topology(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    buffer: tauri::State<'_, std::sync::Arc<TopologyMutationBuffer>>,
    request: UndoTopologyRequest,
) -> Result<UndoTopologyResponse, String> {
    let pool = store.pool(&app).await?;
    match apply_undo(pool, buffer.inner(), &request).await? {
        Some(record) => {
            emit_session_db_changed(&app, &record);
            Ok(UndoTopologyResponse { undone: true })
        }
        None => Ok(UndoTopologyResponse { undone: false }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn fresh_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sessions (id, title, created_at, updated_at, payload) \
             VALUES ('s1', 't', 'now', 'now', '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    /// 写一行节点并对当前态做一次写前快照（pre-image 存在）。
    async fn seed_with_snapshot(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, sync_name, name, x, y, node_type, insert_order) \
             VALUES ('s1', '0', 'ES-1', 10.0, 20.0, 'endSystem', 0)",
        )
        .execute(pool)
        .await
        .unwrap();
        let mut tx = pool.begin().await.unwrap();
        crate::topology_undo::snapshot_pre_image(&mut tx, "s1")
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    fn request() -> UndoTopologyRequest {
        UndoTopologyRequest {
            session_id: "s1".into(),
        }
    }

    #[test]
    fn undo_restores_and_pushes_mutation_when_pre_image_present() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let buffer = TopologyMutationBuffer::default();
            seed_with_snapshot(&pool).await;

            // 快照后改库，撤销应盖回。
            sqlx::query("UPDATE topology_nodes SET x = 999.0 WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();

            let record = apply_undo(&pool, &buffer, &request())
                .await
                .unwrap()
                .expect("有快照应返回 mutation 记录");
            assert_eq!(record.session_id, "s1");
            assert_eq!(record.domain, "topology");

            let x: f64 = sqlx::query_scalar(
                "SELECT x FROM topology_nodes WHERE session_id='s1' AND sync_name='0'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(x, 10.0, "撤销盖回快照态");
            assert_eq!(
                buffer.since("s1", 0).mutations.len(),
                1,
                "盖回须 push 一条 mutation"
            );
        });
    }

    #[test]
    fn undo_returns_none_without_pushing_when_no_pre_image() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let buffer = TopologyMutationBuffer::default();
            // 无快照。

            let outcome = apply_undo(&pool, &buffer, &request()).await.unwrap();
            assert!(outcome.is_none(), "无 pre-image 返回 None（undone=false）");
            assert!(
                buffer.since("s1", 0).mutations.is_empty(),
                "无可撤销不得 push mutation"
            );
        });
    }
}
