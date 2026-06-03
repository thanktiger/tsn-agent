//! Plan v3 U6：mutationId ring buffer + catch-up 查询。
//!
//! `topology_sidecar_routes` 在 apply commit 后 push 一条记录，并 emit Tauri
//! event `session_db_changed`。UI 收到 event 后调用 `get_topology_mutations_since`
//! 拉缺失增量；ring buffer 满时丢最早，UI 通过 `outOfRange` flag 触发全量 refetch。

use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// ring buffer 容量；超过后 push 时丢最早 entry。
pub const MUTATION_BUFFER_CAP: usize = 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationRecord {
    pub session_id: String,
    pub domain: String,
    pub mutation_id: u64,
    pub timestamp_ms: u64,
}

#[derive(Debug, Default)]
pub struct TopologyMutationBuffer {
    inner: Mutex<BufferInner>,
}

#[derive(Debug, Default)]
struct BufferInner {
    /// 单调递增 mutation_id。进程重启清零（plan v3：受 ring buffer 同进程局限）。
    next_id: u64,
    /// 容量受限循环队列；新 entry append，旧 entry 在头部丢弃。
    records: std::collections::VecDeque<MutationRecord>,
}

impl TopologyMutationBuffer {
    /// 生成新 mutation_id 并 append。返回新 record 供 emit。
    pub fn push(&self, session_id: String, domain: String) -> MutationRecord {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut inner = self.inner.lock().expect("mutation buffer poisoned");
        inner.next_id += 1;
        let record = MutationRecord {
            session_id,
            domain,
            mutation_id: inner.next_id,
            timestamp_ms,
        };
        if inner.records.len() >= MUTATION_BUFFER_CAP {
            inner.records.pop_front();
        }
        inner.records.push_back(record.clone());
        record
    }

    /// 返回指定 session 在 `last_seen` 之后的 mutation。`out_of_range=true`
    /// 表示 last_seen 比 buffer 头还旧，调用方应做全量 refetch。
    pub fn since(&self, session_id: &str, last_seen: u64) -> CatchUpResponse {
        let inner = self.inner.lock().expect("mutation buffer poisoned");
        let latest = inner.next_id;
        let buffer_start = inner
            .records
            .front()
            .map(|r| r.mutation_id)
            .unwrap_or(latest.saturating_add(1));
        let out_of_range = last_seen > 0 && last_seen + 1 < buffer_start;
        let mutations: Vec<MutationRecord> = inner
            .records
            .iter()
            .filter(|r| r.session_id == session_id && r.mutation_id > last_seen)
            .cloned()
            .collect();
        CatchUpResponse {
            mutations,
            latest,
            out_of_range,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchUpResponse {
    pub mutations: Vec<MutationRecord>,
    pub latest: u64,
    pub out_of_range: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_emits_monotonically_increasing_ids() {
        let buf = TopologyMutationBuffer::default();
        let a = buf.push("s1".to_string(), "topology".to_string());
        let b = buf.push("s1".to_string(), "topology".to_string());
        assert_eq!(a.mutation_id, 1);
        assert_eq!(b.mutation_id, 2);
    }

    #[test]
    fn since_returns_only_records_after_last_seen_for_session() {
        let buf = TopologyMutationBuffer::default();
        buf.push("s1".to_string(), "topology".to_string()); // 1
        buf.push("s2".to_string(), "topology".to_string()); // 2 (other session)
        buf.push("s1".to_string(), "topology".to_string()); // 3
        let resp = buf.since("s1", 1);
        assert_eq!(resp.latest, 3);
        assert!(!resp.out_of_range);
        assert_eq!(resp.mutations.len(), 1);
        assert_eq!(resp.mutations[0].mutation_id, 3);
    }

    #[test]
    fn since_signals_out_of_range_when_last_seen_predates_buffer_head() {
        let buf = TopologyMutationBuffer::default();
        // 模拟 buffer 已经丢掉前几条：通过手动 pop_front 实现等价测试条件。
        for _ in 0..3 {
            buf.push("s1".to_string(), "topology".to_string());
        }
        {
            let mut inner = buf.inner.lock().unwrap();
            inner.records.pop_front(); // 丢 id=1
            inner.records.pop_front(); // 丢 id=2，buffer 头 id=3
        }
        let resp = buf.since("s1", 1);
        assert!(resp.out_of_range, "{resp:?}");
        assert_eq!(resp.latest, 3);
    }

    #[test]
    fn since_with_zero_last_seen_returns_all_session_records_without_out_of_range() {
        let buf = TopologyMutationBuffer::default();
        buf.push("s1".to_string(), "topology".to_string());
        buf.push("s1".to_string(), "topology".to_string());
        let resp = buf.since("s1", 0);
        assert!(!resp.out_of_range);
        assert_eq!(resp.mutations.len(), 2);
    }

    #[test]
    fn push_evicts_oldest_when_capacity_reached() {
        let buf = TopologyMutationBuffer::default();
        for _ in 0..(MUTATION_BUFFER_CAP + 5) {
            buf.push("s1".to_string(), "topology".to_string());
        }
        let inner = buf.inner.lock().unwrap();
        assert_eq!(inner.records.len(), MUTATION_BUFFER_CAP);
        // 头 id 应该是 5 + 1 = 6（丢了前 5 个）
        assert_eq!(inner.records.front().unwrap().mutation_id, 6);
    }
}
