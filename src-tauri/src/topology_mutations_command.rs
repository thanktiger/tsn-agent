//! Plan v3 U6：`get_topology_mutations_since` Tauri command + 事件 emit helper。
//!
//! UI 端走 Tauri command 拉缺失的 mutation 列表；Tauri event `session_db_changed`
//! 仅作 wake-up 信号，载荷极小（{sessionId, domain, mutationId}）以避免高频
//! emit crash（Tauri issue #8177）。真正的数据切片走 `query_topology` 拉
//! （U4a-1 后续实现）。

use serde::Deserialize;

use crate::topology_mutation_buffer::{CatchUpResponse, TopologyMutationBuffer};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTopologyMutationsRequest {
    session_id: String,
    last_seen: u64,
}

#[tauri::command]
pub async fn get_topology_mutations_since(
    buffer: tauri::State<'_, std::sync::Arc<TopologyMutationBuffer>>,
    request: GetTopologyMutationsRequest,
) -> Result<CatchUpResponse, String> {
    Ok(buffer.since(&request.session_id, request.last_seen))
}

// emit closure 现在由 `topology_sidecar::launch` 的调用方注入到 RouteState，
// 不再需要本模块内的 push_and_emit helper（refactor: 解耦 Tauri Runtime 类型，
// 让 sidecar route 单测可以零依赖 AppHandle 跑通）。

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
