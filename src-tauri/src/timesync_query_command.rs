//! Plan 2026-06-24-001 U11：`query_timesync` Tauri command（前端 UI 读路径）。
//!
//! time-sync 阶段画布渲染时钟树时，UI 调本命令拉一个 session 的时钟同步配置切片
//! （domain + 每节点端口角色 + 同步参数），不走 sidecar HTTP，直接 sqlx in-process
//! 读 main pool（与 `query_topology` 同范式）。端口角色由 Rust 确定性算好并落库
//! （U5/U7），前端只读渲染、不参与计算。

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::session_store::SessionStore;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTimesyncRequest {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTimesyncResponse {
    pub session_id: String,
    /// 无 timesync_domain 行（还没设过 GM）时为 None，前端据此显示「未配置」。
    pub domain: Option<TimesyncDomainRow>,
    pub nodes: Vec<TimesyncNodeRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimesyncDomainRow {
    /// 时钟主节点 mid；未设时为 None。
    pub gm_mid: Option<String>,
    pub one_step_mode: i64,
    pub fre_switch: i64,
    pub disabled_link_seqs: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimesyncNodeRow {
    pub mid: String,
    /// 朝子端口（master 角色），确定性衍生。
    pub master_port: Vec<i64>,
    /// 朝父端口（slave 角色），确定性衍生。
    pub slave_port: Vec<i64>,
    /// 参与时钟树的端口（master ∪ slave）。
    pub port_ptp_enabled: Vec<i64>,
    pub sync_period: Option<i64>,
    pub measure_period: Option<i64>,
    pub report_enable: Option<i64>,
    pub mean_link_delay_thresh: Option<i64>,
    pub offset_threshold: Option<i64>,
}

/// JSON-in-TEXT 数组列 → Vec<i64>，解析失败按空数组（与 sidecar inspect 同容错）。
fn parse_seq_array(raw: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(raw).unwrap_or_default()
}

#[tauri::command]
pub async fn query_timesync(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: QueryTimesyncRequest,
) -> Result<QueryTimesyncResponse, String> {
    let pool = store.pool(&app).await?;

    let domain_row = sqlx::query(
        "SELECT gm_mid, one_step_mode, fre_switch, disabled_link_seqs \
         FROM timesync_domain WHERE session_id = ?",
    )
    .bind(&request.session_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("查询时钟同步域失败：{e}"))?;

    let domain = domain_row.map(|r| TimesyncDomainRow {
        gm_mid: r.get("gm_mid"),
        one_step_mode: r.get("one_step_mode"),
        fre_switch: r.get("fre_switch"),
        disabled_link_seqs: parse_seq_array(&r.get::<String, _>("disabled_link_seqs")),
    });

    let node_rows = sqlx::query(
        "SELECT mid, master_port, slave_port, port_ptp_enabled, \
         sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold \
         FROM timesync_nodes WHERE session_id = ? ORDER BY mid",
    )
    .bind(&request.session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询时钟同步节点失败：{e}"))?;

    let nodes = node_rows
        .into_iter()
        .map(|r| TimesyncNodeRow {
            mid: r.get("mid"),
            master_port: parse_seq_array(&r.get::<String, _>("master_port")),
            slave_port: parse_seq_array(&r.get::<String, _>("slave_port")),
            port_ptp_enabled: parse_seq_array(&r.get::<String, _>("port_ptp_enabled")),
            sync_period: r.get("sync_period"),
            measure_period: r.get("measure_period"),
            report_enable: r.get("report_enable"),
            mean_link_delay_thresh: r.get("mean_link_delay_thresh"),
            offset_threshold: r.get("offset_threshold"),
        })
        .collect();

    Ok(QueryTimesyncResponse {
        session_id: request.session_id,
        domain,
        nodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
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
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}')")
            .execute(&pool).await.unwrap();
        pool
    }

    async fn read_query(pool: &sqlx::Pool<sqlx::Sqlite>, session_id: &str) -> QueryTimesyncResponse {
        let domain_row = sqlx::query(
            "SELECT gm_mid, one_step_mode, fre_switch, disabled_link_seqs FROM timesync_domain WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .unwrap();
        let domain = domain_row.map(|r| TimesyncDomainRow {
            gm_mid: r.get("gm_mid"),
            one_step_mode: r.get("one_step_mode"),
            fre_switch: r.get("fre_switch"),
            disabled_link_seqs: parse_seq_array(&r.get::<String, _>("disabled_link_seqs")),
        });
        let node_rows = sqlx::query(
            "SELECT mid, master_port, slave_port, port_ptp_enabled, sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold FROM timesync_nodes WHERE session_id = ? ORDER BY mid",
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .unwrap();
        let nodes = node_rows
            .into_iter()
            .map(|r| TimesyncNodeRow {
                mid: r.get("mid"),
                master_port: parse_seq_array(&r.get::<String, _>("master_port")),
                slave_port: parse_seq_array(&r.get::<String, _>("slave_port")),
                port_ptp_enabled: parse_seq_array(&r.get::<String, _>("port_ptp_enabled")),
                sync_period: r.get("sync_period"),
                measure_period: r.get("measure_period"),
                report_enable: r.get("report_enable"),
                mean_link_delay_thresh: r.get("mean_link_delay_thresh"),
                offset_threshold: r.get("offset_threshold"),
            })
            .collect();
        QueryTimesyncResponse {
            session_id: session_id.to_string(),
            domain,
            nodes,
        }
    }

    #[test]
    fn returns_none_domain_and_empty_nodes_when_unconfigured() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            let resp = read_query(&pool, "s1").await;
            assert!(resp.domain.is_none());
            assert!(resp.nodes.is_empty());
        });
    }

    #[test]
    fn returns_domain_and_node_roles_when_configured() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid, one_step_mode, fre_switch, disabled_link_seqs) VALUES ('s1', '0', 1, 0, '[2]')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port, port_ptp_enabled, sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold) VALUES ('s1', '1', '[1]', '[0]', '[0,1]', 128, 1024, 1, 64, 1000)")
                .execute(&pool).await.unwrap();

            let resp = read_query(&pool, "s1").await;
            let domain = resp.domain.expect("domain present");
            assert_eq!(domain.gm_mid.as_deref(), Some("0"));
            assert_eq!(domain.one_step_mode, 1);
            assert_eq!(domain.disabled_link_seqs, vec![2]);
            assert_eq!(resp.nodes.len(), 1);
            let n = &resp.nodes[0];
            assert_eq!(n.mid, "1");
            assert_eq!(n.master_port, vec![1]);
            assert_eq!(n.slave_port, vec![0]);
            assert_eq!(n.port_ptp_enabled, vec![0, 1]);
            assert_eq!(n.sync_period, Some(128));
            assert_eq!(n.offset_threshold, Some(1000));
        });
    }
}
