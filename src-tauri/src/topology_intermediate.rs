//! Plan v3 U4a-2：Rust 端 IntermediateTopology DTO + 排序 / 派生工具，
//! 1:1 镜像 `src/topology/intermediate.ts`。
//!
//! 这些类型只承担 sidecar 入口反序列化与 compute 模块共享类型职责；
//! 不与 P0 SQLite 表绑定（U4a-1 walker 已经把 canonical 落到 topology_nodes/_links）。
//!
//! MCP 工具调用 `build_artifacts` / `inspect` / `validate` 时 agent 在 args 里传
//! topology，MCP handler 透传到 sidecar。sidecar 内反序列化为这些类型后跑算法。
//! initialize 则只接受 `(templateId, params)` 在 sidecar 端原地生成 topology。

use serde::{Deserialize, Serialize};

pub const INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION: &str = "tsn-agent.topology.intermediate.v0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediatePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediatePort {
    pub id: String,
    pub name: String,
    pub index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateNode {
    pub id: String,
    pub numeric_id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: IntermediateNodeType,
    pub ports: Vec<IntermediatePort>,
    pub position: IntermediatePosition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntermediateNodeType {
    Switch,
    EndSystem,
    Server,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateLinkEndpoint {
    pub node_id: String,
    pub port_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateLink {
    pub id: String,
    pub numeric_id: i64,
    pub source: IntermediateLinkEndpoint,
    pub target: IntermediateLinkEndpoint,
    pub medium: IntermediateLinkMedium,
    pub data_rate_mbps: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntermediateLinkMedium {
    Ethernet,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateTopologyMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyDiagnostic {
    pub code: String,
    pub message: String,
    pub severity: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateTopology {
    pub schema_version: String,
    #[serde(default)]
    pub metadata: IntermediateTopologyMetadata,
    pub nodes: Vec<IntermediateNode>,
    pub links: Vec<IntermediateLink>,
    #[serde(default)]
    pub diagnostics: Vec<TopologyDiagnostic>,
}

impl IntermediateTopology {
    pub fn switch_count(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| n.node_type == IntermediateNodeType::Switch)
            .count()
    }
    pub fn end_system_count(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| n.node_type == IntermediateNodeType::EndSystem)
            .count()
    }
    pub fn server_count(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| n.node_type == IntermediateNodeType::Server)
            .count()
    }
}

/// 与 TS `sortNodesByNumericId` 完全一致：先按 numericId 升序，再按 id 字典序。
pub fn sort_nodes_by_numeric_id(nodes: &[IntermediateNode]) -> Vec<IntermediateNode> {
    let mut sorted: Vec<IntermediateNode> = nodes.to_vec();
    sorted.sort_by(|a, b| match a.numeric_id.cmp(&b.numeric_id) {
        std::cmp::Ordering::Equal => a.id.cmp(&b.id),
        other => other,
    });
    sorted
}

pub fn sort_links_by_numeric_id(links: &[IntermediateLink]) -> Vec<IntermediateLink> {
    let mut sorted: Vec<IntermediateLink> = links.to_vec();
    sorted.sort_by(|a, b| match a.numeric_id.cmp(&b.numeric_id) {
        std::cmp::Ordering::Equal => a.id.cmp(&b.id),
        other => other,
    });
    sorted
}

pub fn create_ports(count: usize) -> Vec<IntermediatePort> {
    (0..count)
        .map(|i| IntermediatePort {
            id: format!("p{}", i + 1),
            name: format!("eth{}", i),
            index: i as i64,
        })
        .collect()
}

pub fn derive_mac_address(ordinal: i64) -> String {
    format!("00:1B:44:11:3A:{:02X}", ordinal & 0xff)
}

pub fn derive_legacy_mac(numeric_id: i64) -> String {
    let high = (numeric_id >> 8) & 0xff;
    let low = numeric_id & 0xff;
    format!("00:00:23:00:{:02X}:{:02X}", high, low)
}

pub fn derive_legacy_ip(numeric_id: i64) -> String {
    let high = (numeric_id >> 8) & 0xff;
    let low = numeric_id & 0xff;
    format!("192.168.{}.{}", high, low)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_basic_topology_json() {
        let raw = serde_json::json!({
            "schemaVersion": "tsn-agent.topology.intermediate.v0",
            "metadata": { "templateId": "generic-line", "layout": "line", "source": "template" },
            "nodes": [{
                "id": "sw1", "numericId": 0, "name": "SW-1", "type": "switch",
                "ports": [{ "id": "p1", "name": "eth0", "index": 0 }],
                "position": { "x": 1.0, "y": 2.0 }
            }],
            "links": [],
            "diagnostics": []
        });
        let topo: IntermediateTopology = serde_json::from_value(raw).unwrap();
        assert_eq!(topo.schema_version, INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION);
        assert_eq!(topo.nodes.len(), 1);
        assert_eq!(topo.nodes[0].id, "sw1");
        assert_eq!(topo.nodes[0].node_type, IntermediateNodeType::Switch);
    }

    #[test]
    fn sort_nodes_by_numeric_id_breaks_ties_with_id() {
        let nodes = vec![
            IntermediateNode {
                id: "b".into(),
                numeric_id: 1,
                name: "B".into(),
                node_type: IntermediateNodeType::Switch,
                ports: vec![],
                position: IntermediatePosition { x: 0.0, y: 0.0 },
                mac_address: None,
                ip_address: None,
            },
            IntermediateNode {
                id: "a".into(),
                numeric_id: 1,
                name: "A".into(),
                node_type: IntermediateNodeType::Switch,
                ports: vec![],
                position: IntermediatePosition { x: 0.0, y: 0.0 },
                mac_address: None,
                ip_address: None,
            },
        ];
        let sorted = sort_nodes_by_numeric_id(&nodes);
        assert_eq!(sorted[0].id, "a");
        assert_eq!(sorted[1].id, "b");
    }

    #[test]
    fn create_ports_yields_p_prefixed_zero_indexed() {
        let p = create_ports(3);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].id, "p1");
        assert_eq!(p[0].name, "eth0");
        assert_eq!(p[0].index, 0);
        assert_eq!(p[2].id, "p3");
        assert_eq!(p[2].index, 2);
    }

    #[test]
    fn derive_legacy_mac_and_ip_match_ts() {
        assert_eq!(derive_legacy_mac(0), "00:00:23:00:00:00");
        assert_eq!(derive_legacy_mac(258), "00:00:23:00:01:02");
        assert_eq!(derive_legacy_ip(258), "192.168.1.2");
    }
}
