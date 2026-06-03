//! Plan v3 U6：`get_topology_mutations_since` Tauri command + 事件 emit helper。
//!
//! UI 端走 Tauri command 拉缺失的 mutation 列表；Tauri event `session_db_changed`
//! 仅作 wake-up 信号，载荷极小（{sessionId, domain, mutationId}）以避免高频
//! emit crash（Tauri issue #8177）。真正的数据切片走 `query_topology` 拉
//! （U4a-1 后续实现）。

use serde::Deserialize;
use tauri::Emitter;

use crate::topology_mutation_buffer::{
    CatchUpResponse, MutationRecord, TopologyMutationBuffer,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTopologyMutationsRequest {
    session_id: String,
    last_seen: u64,
}

#[tauri::command]
pub async fn get_topology_mutations_since(
    buffer: tauri::State<'_, TopologyMutationBuffer>,
    request: GetTopologyMutationsRequest,
) -> Result<CatchUpResponse, String> {
    Ok(buffer.since(&request.session_id, request.last_seen))
}

/// 在 sidecar route apply commit 后调用：push buffer + emit Tauri event。
/// 限定 `emit_to("main", ...)` 避免跨 webview 泄露。
pub fn push_and_emit(
    app: &tauri::AppHandle,
    buffer: &TopologyMutationBuffer,
    session_id: &str,
    domain: &str,
) -> MutationRecord {
    let record = buffer.push(session_id.to_string(), domain.to_string());
    let payload = serde_json::json!({
        "sessionId": record.session_id,
        "domain": record.domain,
        "mutationId": record.mutation_id,
    });
    // emit_to("main", ...) 不存在时回退到全局 emit；忽略 emit 失败（UI 端有 watchdog 兜底）。
    if let Err(error) = app.emit_to("main", "session_db_changed", payload.clone()) {
        let _ = app.emit("session_db_changed", payload);
        // 写到 stderr 用于诊断（不致命）
        eprintln!("session_db_changed emit_to(main) 失败：{error}");
    }
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_mutations_returns_buffer_response() {
        let buffer = TopologyMutationBuffer::default();
        buffer.push("s1".to_string(), "topology".to_string());
        let resp = buffer.since("s1", 0);
        assert_eq!(resp.mutations.len(), 1);
        assert_eq!(resp.latest, 1);
    }
}
