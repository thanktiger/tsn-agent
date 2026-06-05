//! Plan v3 U4a-2：sidecar 端的 topology compute 模块。
//!
//! 1:1 镜像 `src/topology/{templates,initialize,inspect,validate,artifacts}.ts` 的核心算法，
//! 由 sidecar 8 routes 在 axum handler 中调用。
//!
//! 范围（与 U4a-2 plan section 一致）：
//! - `describe_templates`：静态 3-template catalog
//! - `build_artifacts`：4 件套构建（topology.json / topo_feature.json / data-server.json /
//!   mac-forwarding-table.json，含 BFS）
//! - `describe_artifacts`：summary
//! - `validate_artifacts`：4 件套结构校验
//!
//! Phase A 边界 (Boss 已批准)：
//! - `initialize` 只支持 generic-line / generic-ring；dual-plane-redundant 返
//!   `INVALID_TEMPLATE_PARAM` 含 "Phase B" 提示，UI / agent 提示用户后续版本支持。
//!   理由：dual-plane 参数验证 + 拓扑生成 ≥600 LOC，是独立工作量，Phase A 不阻塞。
//! - `inspect` / `validate` 实现核心校验 + selector 解析，与 TS 保持 byte-equal
//!   summary。adjacency / portUsage 在 full 模式仍输出，但 sidecar 默认 summary。

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::topology_intermediate::{
    create_ports, derive_legacy_ip, derive_legacy_mac, derive_mac_address, sort_links_by_numeric_id,
    sort_nodes_by_numeric_id, IntermediateLink, IntermediateLinkEndpoint, IntermediateLinkMedium,
    IntermediateNode, IntermediateNodeType, IntermediatePosition, IntermediateTopology,
    IntermediateTopologyMetadata, INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION,
};

// ============================================================================
// Topology limits（与 src/topology/limits.ts 同步）
// ============================================================================

pub const MAX_NODES: usize = 200;
pub const MAX_LINKS: usize = 600;
pub const MAX_PORTS_PER_NODE: usize = 64;
pub const MAX_INGRESS_PAYLOAD_BYTES: usize = 512_000;
pub const MAX_ARTIFACT_BYTES: usize = 2_000_000;

// ============================================================================
// Errors / Result envelope（与 src/topology/tool-result.ts 同步，summary-only）
// ============================================================================

#[derive(Debug, Clone, Serialize)]
pub struct TopologyErrorOut {
    pub code: String,
    pub message: String,
    pub path: String,
    pub severity: String,
    #[serde(skip_serializing_if = "serde_json::Value::is_null")]
    pub details: Value,
    pub retryable: bool,
    #[serde(rename = "requiresUserClarification")]
    pub requires_user_clarification: bool,
}

impl TopologyErrorOut {
    pub fn new(code: &str, message: impl Into<String>, path: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            path: path.into(),
            severity: "error".into(),
            details: Value::Null,
            retryable: false,
            requires_user_clarification: false,
        }
    }
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
    pub fn requires_clarification(mut self) -> Self {
        self.requires_user_clarification = true;
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TopologyWarningOut {
    pub code: String,
    pub message: String,
    pub path: String,
}

// ============================================================================
// describe_templates: 静态目录
// ============================================================================

pub fn describe_templates_catalog() -> Value {
    json!({
        "templateCount": 3,
        "templateIds": ["generic-line", "generic-ring", "dual-plane-redundant"],
        "templates": [
            generic_line_descriptor(),
            generic_ring_descriptor(),
            dual_plane_descriptor(),
        ],
    })
}

fn generic_line_descriptor() -> Value {
    json!({
        "id": "generic-line",
        "name": "通用线型拓扑",
        "description": "多台交换机线型互联，每台交换机接入固定数量端系统。",
        "tags": ["generic", "line", "beginner"],
        "params": generic_distributed_params(),
        "example": {
            "switchCount": 4,
            "endSystemsPerSwitch": 2,
            "dataRateMbps": 1000,
        },
    })
}

fn generic_ring_descriptor() -> Value {
    json!({
        "id": "generic-ring",
        "name": "通用环形拓扑",
        "description": "多台交换机环形互联，每台交换机接入固定数量端系统。",
        "tags": ["generic", "ring", "redundant"],
        "params": generic_distributed_params(),
        "example": {
            "switchCount": 4,
            "endSystemsPerSwitch": 2,
            "dataRateMbps": 1000,
        },
    })
}

fn dual_plane_descriptor() -> Value {
    json!({
        "id": "dual-plane-redundant",
        "name": "通用双平面冗余拓扑",
        "description": "A/B 两个交换机平面，端系统显式双归属接入成对 switch group。",
        "tags": ["generic", "dual-plane", "dual-homed", "redundant"],
        "params": [
            { "name": "planes", "type": "tuple", "required": true,
              "description": "固定两个平面，P0 只支持 A/B。",
              "itemShape": { "id": "A | B", "name": "string?" } },
            { "name": "switches", "type": "array", "required": true,
              "description": "显式交换机列表，每台交换机声明所属平面、groupId 和可选端口数。",
              "itemShape": {
                  "id": "string", "name": "string?", "plane": "A | B",
                  "groupId": "string", "portCount": "integer?"
              } },
            { "name": "switchGroups", "type": "array", "required": true,
              "description": "成对 A/B 交换机故障域，每个 group 必须引用一台 A 平面和一台 B 平面交换机。",
              "itemShape": {
                  "id": "string", "name": "string?",
                  "planeSwitches": { "A": "switchId", "B": "switchId" }
              } },
            { "name": "endSystems", "type": "array", "required": true,
              "description": "显式端系统列表，每个端系统必须声明 primary/backup 接入。",
              "itemShape": {
                  "id": "string", "name": "string?", "groupId": "string",
                  "attachment": {
                      "primary": { "switchId": "string", "plane": "A | B" },
                      "backup":  { "switchId": "string", "plane": "A | B" }
                  }
              } },
            { "name": "backbone", "type": "object", "required": true,
              "description": "平面内骨干连接策略，P0 支持 line/ring。",
              "itemShape": { "mode": "line | ring", "withinPlane": "boolean" } },
            { "name": "crossPlaneLinks", "type": "object", "required": true,
              "description": "跨平面桥接策略，none 表示隔离平面，paired 表示每个 group 内 A/B 成对互联。",
              "itemShape": { "mode": "none | paired" } },
            data_rate_param(),
        ],
        "example": {
            "planes": [{ "id": "A" }, { "id": "B" }],
            "switches": [
                { "id": "sw1", "plane": "A", "groupId": "g1" },
                { "id": "sw2", "plane": "B", "groupId": "g1" },
                { "id": "sw3", "plane": "A", "groupId": "g2" },
                { "id": "sw4", "plane": "B", "groupId": "g2" }
            ],
            "switchGroups": [
                { "id": "g1", "planeSwitches": { "A": "sw1", "B": "sw2" } },
                { "id": "g2", "planeSwitches": { "A": "sw3", "B": "sw4" } }
            ],
            "endSystems": [
                { "id": "es1-1", "groupId": "g1", "attachment": { "primary": { "switchId": "sw1", "plane": "A" }, "backup": { "switchId": "sw2", "plane": "B" } } },
                { "id": "es1-2", "groupId": "g1", "attachment": { "primary": { "switchId": "sw1", "plane": "A" }, "backup": { "switchId": "sw2", "plane": "B" } } },
                { "id": "es2-1", "groupId": "g2", "attachment": { "primary": { "switchId": "sw3", "plane": "A" }, "backup": { "switchId": "sw4", "plane": "B" } } },
                { "id": "es2-2", "groupId": "g2", "attachment": { "primary": { "switchId": "sw3", "plane": "A" }, "backup": { "switchId": "sw4", "plane": "B" } } }
            ],
            "backbone": { "mode": "line", "withinPlane": true },
            "crossPlaneLinks": { "mode": "none" },
            "dataRateMbps": 1000,
        },
    })
}

fn generic_distributed_params() -> Value {
    json!([
        { "name": "switchCount", "type": "integer", "default": 4, "minimum": 1, "maximum": 12,
          "description": "交换机数量。" },
        { "name": "endSystemsPerSwitch", "type": "integer", "default": 2, "minimum": 1, "maximum": 24,
          "description": "每台交换机接入的端系统数量。" },
        data_rate_param()
    ])
}

fn data_rate_param() -> Value {
    json!({
        "name": "dataRateMbps", "type": "enum", "default": 1000,
        "values": [10, 100, 1000, 10000],
        "description": "链路速率，单位 Mbps。",
    })
}

const SUPPORTED_DATA_RATES: [i64; 4] = [10, 100, 1000, 10000];

// ============================================================================
// initialize: generic-line / generic-ring (dual-plane → INVALID_TEMPLATE_PARAM)
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeIntent {
    pub template_id: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeSummary {
    pub template_id: String,
    pub node_count: usize,
    pub link_count: usize,
    pub switch_count: usize,
    pub end_system_count: usize,
    pub server_count: usize,
}

pub fn initialize_topology(
    intent: &InitializeIntent,
) -> Result<(IntermediateTopology, InitializeSummary), Vec<TopologyErrorOut>> {
    if intent.template_id != "generic-line"
        && intent.template_id != "generic-ring"
        && intent.template_id != "dual-plane-redundant"
    {
        return Err(vec![TopologyErrorOut::new(
            "UNKNOWN_TEMPLATE_ID",
            format!("Unknown topology templateId: {}", intent.template_id),
            "$.templateId",
        )
        .requires_clarification()]);
    }

    let params_obj = if intent.params.is_object() {
        intent.params.clone()
    } else {
        Value::Object(serde_json::Map::new())
    };

    let data_rate = normalize_data_rate(params_obj.get("dataRateMbps"))?;

    if intent.template_id == "dual-plane-redundant" {
        // Phase A 边界：dual-plane 路径较复杂（~600 LOC port），Phase A 不阻塞，
        // Phase B 或后续 polish PR 接入。当前明确告知用户使用 generic-line / generic-ring。
        return Err(vec![TopologyErrorOut::new(
            "INVALID_TEMPLATE_PARAM",
            "Phase A 暂只支持 generic-line / generic-ring 模板；dual-plane-redundant 将在 Phase B 回归。",
            "$.templateId",
        )
        .with_details(json!({
            "phase": "A",
            "supportedTemplateIds": ["generic-line", "generic-ring"],
            "deferredTo": "Phase B"
        }))
        .requires_clarification()]);
    }

    let switch_count = normalize_integer_param(
        params_obj.get("switchCount"),
        4,
        1,
        12,
        "$.params.switchCount",
    )?;
    let end_systems_per_switch = normalize_integer_param(
        params_obj.get("endSystemsPerSwitch"),
        2,
        1,
        24,
        "$.params.endSystemsPerSwitch",
    )?;
    let topology = create_generic_distributed_topology(
        &intent.template_id,
        switch_count as usize,
        end_systems_per_switch as usize,
        data_rate,
    );

    let summary = InitializeSummary {
        template_id: intent.template_id.clone(),
        node_count: topology.nodes.len(),
        link_count: topology.links.len(),
        switch_count: topology.switch_count(),
        end_system_count: topology.end_system_count(),
        server_count: topology.server_count(),
    };

    Ok((topology, summary))
}

fn normalize_integer_param(
    value: Option<&Value>,
    default: i64,
    min: i64,
    max: i64,
    path: &str,
) -> Result<i64, Vec<TopologyErrorOut>> {
    let n = match value {
        None | Some(Value::Null) => default,
        Some(v) => v.as_i64().or_else(|| v.as_f64().and_then(|f| {
            if f.fract() == 0.0 { Some(f as i64) } else { None }
        })).ok_or_else(|| {
            vec![TopologyErrorOut::new(
                "INVALID_TEMPLATE_PARAM",
                format!("{} must be an integer in [{}, {}].", path, min, max),
                path,
            )
            .with_details(json!({"minimum": min, "maximum": max, "actual": v.to_string()}))
            .requires_clarification()]
        })?,
    };
    if n < min || n > max {
        return Err(vec![TopologyErrorOut::new(
            "INVALID_TEMPLATE_PARAM",
            format!("{} must be an integer in [{}, {}].", path, min, max),
            path,
        )
        .with_details(json!({"minimum": min, "maximum": max, "actual": n.to_string()}))
        .requires_clarification()]);
    }
    Ok(n)
}

fn normalize_data_rate(value: Option<&Value>) -> Result<i64, Vec<TopologyErrorOut>> {
    let n = match value {
        None | Some(Value::Null) => 1000,
        Some(v) => v.as_i64().or_else(|| v.as_f64().and_then(|f| {
            if f.fract() == 0.0 { Some(f as i64) } else { None }
        })).ok_or_else(|| {
            vec![TopologyErrorOut::new(
                "INVALID_TEMPLATE_PARAM",
                format!(
                    "$.params.dataRateMbps must be one of {:?}.",
                    SUPPORTED_DATA_RATES
                ),
                "$.params.dataRateMbps",
            )
            .with_details(json!({
                "allowed": SUPPORTED_DATA_RATES,
                "actual": v.to_string()
            }))
            .requires_clarification()]
        })?,
    };
    if !SUPPORTED_DATA_RATES.contains(&n) {
        return Err(vec![TopologyErrorOut::new(
            "INVALID_TEMPLATE_PARAM",
            format!(
                "$.params.dataRateMbps must be one of {:?}.",
                SUPPORTED_DATA_RATES
            ),
            "$.params.dataRateMbps",
        )
        .with_details(json!({
            "allowed": SUPPORTED_DATA_RATES,
            "actual": n.to_string()
        }))
        .requires_clarification()]);
    }
    Ok(n)
}

fn create_generic_distributed_topology(
    template_id: &str,
    switch_count: usize,
    end_systems_per_switch: usize,
    data_rate: i64,
) -> IntermediateTopology {
    let mut nodes: Vec<IntermediateNode> = Vec::new();
    let mut links: Vec<IntermediateLink> = Vec::new();
    let mut switch_ids: Vec<String> = Vec::new();
    let mut numeric_node_id: i64 = 0;
    let mut numeric_link_id: i64 = 0;

    for switch_index in 1..=switch_count {
        let switch_id = format!("sw{}", switch_index);
        let switch_x = 80.0 + 300.0 * (switch_index as f64 - 1.0);
        switch_ids.push(switch_id.clone());
        nodes.push(IntermediateNode {
            id: switch_id,
            numeric_id: numeric_node_id,
            name: format!("SW-{}", switch_index),
            node_type: IntermediateNodeType::Switch,
            ports: create_ports(end_systems_per_switch + 2),
            position: IntermediatePosition { x: switch_x, y: 220.0 },
            mac_address: None,
            ip_address: None,
        });
        numeric_node_id += 1;
    }

    for switch_index in 1..=switch_count {
        let switch_id = format!("sw{}", switch_index);
        for host_index in 1..=end_systems_per_switch {
            let host_id = format!("es{}-{}", switch_index, host_index);
            let host_ordinal = ((switch_index - 1) * end_systems_per_switch + host_index) as i64;
            let switch_x = 80.0 + 300.0 * (switch_index as f64 - 1.0);
            let y_offset = if host_index % 2 == 0 { 390.0 } else { 70.0 };
            let mid = ((end_systems_per_switch as f64) / 2.0).ceil();
            let x_jitter = (host_index as f64 - mid) * 62.0;

            nodes.push(IntermediateNode {
                id: host_id.clone(),
                numeric_id: numeric_node_id,
                name: format!("ES-{}-{}", switch_index, host_index),
                node_type: IntermediateNodeType::EndSystem,
                ports: create_ports(1),
                position: IntermediatePosition {
                    x: switch_x + x_jitter,
                    y: y_offset,
                },
                mac_address: Some(derive_mac_address(host_ordinal)),
                ip_address: Some(format!("10.0.{}.{}", switch_index, host_index)),
            });
            numeric_node_id += 1;

            links.push(create_link(
                numeric_link_id,
                &host_id,
                "p1",
                &switch_id,
                &format!("p{}", host_index),
                data_rate,
            ));
            numeric_link_id += 1;
        }
    }

    let switch_interconnect_port_offset = end_systems_per_switch;
    for index in 0..switch_ids.len().saturating_sub(1) {
        links.push(create_link(
            numeric_link_id,
            &switch_ids[index],
            &format!("p{}", switch_interconnect_port_offset + 1),
            &switch_ids[index + 1],
            &format!("p{}", switch_interconnect_port_offset + 2),
            data_rate,
        ));
        numeric_link_id += 1;
    }

    if template_id == "generic-ring" && switch_ids.len() > 2 {
        links.push(create_link(
            numeric_link_id,
            &switch_ids[switch_ids.len() - 1],
            &format!("p{}", switch_interconnect_port_offset + 1),
            &switch_ids[0],
            &format!("p{}", switch_interconnect_port_offset + 2),
            data_rate,
        ));
    }

    IntermediateTopology {
        schema_version: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION.to_string(),
        metadata: IntermediateTopologyMetadata {
            template_id: Some(template_id.to_string()),
            template_params: Some(json!({
                "switchCount": switch_count,
                "endSystemsPerSwitch": end_systems_per_switch,
                "dataRateMbps": data_rate,
            })),
            layout: Some(if template_id == "generic-ring" { "ring".into() } else { "line".into() }),
            source: Some("template".into()),
        },
        nodes,
        links,
        diagnostics: Vec::new(),
    }
}

fn create_link(
    numeric_id: i64,
    source_node_id: &str,
    source_port_id: &str,
    target_node_id: &str,
    target_port_id: &str,
    data_rate_mbps: i64,
) -> IntermediateLink {
    IntermediateLink {
        id: format!("link-{}", numeric_id),
        numeric_id,
        source: IntermediateLinkEndpoint {
            node_id: source_node_id.into(),
            port_id: source_port_id.into(),
        },
        target: IntermediateLinkEndpoint {
            node_id: target_node_id.into(),
            port_id: target_port_id.into(),
        },
        medium: IntermediateLinkMedium::Ethernet,
        data_rate_mbps,
    }
}

// ============================================================================
// validate（结构校验 + 端口去重）
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateSummary {
    pub valid: bool,
    pub schema_version: String,
    pub node_count: usize,
    pub link_count: usize,
    pub switch_count: usize,
    pub end_system_count: usize,
    pub server_count: usize,
    pub warning_count: usize,
    pub error_count: usize,
    pub error_codes: Vec<String>,
}

pub struct ValidationReport {
    pub ok: bool,
    pub errors: Vec<TopologyErrorOut>,
    pub warnings: Vec<TopologyWarningOut>,
    pub summary: ValidateSummary,
}

/// Validate a candidate raw JSON value as IntermediateTopology.
/// 不要求已反序列化成 `IntermediateTopology` —— 入参常是 agent 直接传入的 unknown 树。
pub fn validate_intermediate_topology(candidate: &Value) -> ValidationReport {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    let obj = match candidate.as_object() {
        Some(o) => o,
        None => {
            errors.push(TopologyErrorOut::new(
                "INVALID_INTERMEDIATE",
                "IntermediateTopology must be an object.",
                "$",
            ));
            return finalize_validation(candidate, errors, warnings);
        }
    };

    let schema_version = obj.get("schemaVersion").and_then(Value::as_str).unwrap_or("");
    if schema_version != INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION {
        errors.push(TopologyErrorOut::new(
            "UNSUPPORTED_SCHEMA_VERSION",
            format!("Unsupported topology schemaVersion: {}", schema_version),
            "$.schemaVersion",
        ));
    }

    if obj.get("metadata").and_then(Value::as_object).is_none() {
        errors.push(TopologyErrorOut::new(
            "MISSING_METADATA",
            "IntermediateTopology.metadata must be an object.",
            "$.metadata",
        ));
    }

    let nodes = obj.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default();
    let links = obj.get("links").and_then(Value::as_array).cloned().unwrap_or_default();

    if obj.get("nodes").and_then(Value::as_array).is_none() {
        errors.push(TopologyErrorOut::new(
            "INVALID_NODES",
            "IntermediateTopology.nodes must be an array.",
            "$.nodes",
        ));
    } else if nodes.is_empty() {
        errors.push(TopologyErrorOut::new(
            "MISSING_NODES",
            "IntermediateTopology.nodes must not be empty.",
            "$.nodes",
        ));
    }
    if obj.get("links").and_then(Value::as_array).is_none() {
        errors.push(TopologyErrorOut::new(
            "INVALID_LINKS",
            "IntermediateTopology.links must be an array.",
            "$.links",
        ));
    }
    if obj.get("diagnostics").and_then(Value::as_array).is_none() {
        errors.push(TopologyErrorOut::new(
            "INVALID_DIAGNOSTICS",
            "IntermediateTopology.diagnostics must be an array.",
            "$.diagnostics",
        ));
    }

    if nodes.len() > MAX_NODES {
        errors.push(limit_error("maxNodes", "$.nodes", nodes.len()));
    }
    if links.len() > MAX_LINKS {
        errors.push(limit_error("maxLinks", "$.links", links.len()));
    }

    let mut node_ids: HashSet<String> = HashSet::new();
    let mut node_numeric_ids: HashSet<i64> = HashSet::new();
    let mut port_ids_by_node: HashMap<String, HashSet<String>> = HashMap::new();
    let mut node_types_by_id: HashMap<String, String> = HashMap::new();

    for (index, node) in nodes.iter().enumerate() {
        validate_node_value(
            node,
            index,
            &mut errors,
            &mut node_ids,
            &mut node_numeric_ids,
            &mut port_ids_by_node,
            &mut node_types_by_id,
        );
    }
    validate_link_values(&links, &mut errors, &node_ids, &port_ids_by_node);

    if nodes
        .iter()
        .any(|n| n.get("type").and_then(Value::as_str) == Some("server"))
    {
        warnings.push(TopologyWarningOut {
            code: "SERVER_NODE_COMPATIBILITY_ONLY".into(),
            message:
                "server nodes are allowed for legacy artifact compatibility but are not supported by the canonical project bridge."
                    .into(),
            path: "$.nodes".into(),
        });
    }

    finalize_validation(candidate, errors, warnings)
}

fn limit_error(limit: &str, path: &str, actual: usize) -> TopologyErrorOut {
    let maximum = match limit {
        "maxNodes" => MAX_NODES,
        "maxLinks" => MAX_LINKS,
        "maxPortsPerNode" => MAX_PORTS_PER_NODE,
        "maxArtifactBytes" => MAX_ARTIFACT_BYTES,
        "maxIngressPayloadBytes" => MAX_INGRESS_PAYLOAD_BYTES,
        _ => 0,
    };
    TopologyErrorOut::new(
        "LIMIT_EXCEEDED",
        format!("{} exceeded: {} > {}", limit, actual, maximum),
        path,
    )
    .with_details(json!({ "limit": limit, "actual": actual, "maximum": maximum }))
}

fn validate_node_value(
    node: &Value,
    index: usize,
    errors: &mut Vec<TopologyErrorOut>,
    node_ids: &mut HashSet<String>,
    node_numeric_ids: &mut HashSet<i64>,
    port_ids_by_node: &mut HashMap<String, HashSet<String>>,
    node_types_by_id: &mut HashMap<String, String>,
) {
    let path = format!("$.nodes[{}]", index);
    let id_value = node.get("id").and_then(Value::as_str).map(str::to_string);
    match &id_value {
        Some(id) if !id.trim().is_empty() => {
            if node_ids.contains(id) {
                errors.push(TopologyErrorOut::new(
                    "DUPLICATE_NODE_ID",
                    format!("Duplicate node id: {}", id),
                    &format!("{}.id", path),
                ));
            } else {
                node_ids.insert(id.clone());
                let type_str = node
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                node_types_by_id.insert(id.clone(), type_str);
            }
        }
        _ => errors.push(TopologyErrorOut::new(
            "MISSING_NODE_ID",
            "Node id must be a non-empty string.",
            &format!("{}.id", path),
        )),
    }

    match node.get("numericId").and_then(Value::as_i64) {
        Some(n) if n >= 0 => {
            if node_numeric_ids.contains(&n) {
                errors.push(TopologyErrorOut::new(
                    "DUPLICATE_NODE_NUMERIC_ID",
                    format!("Duplicate node numericId: {}", n),
                    &format!("{}.numericId", path),
                ));
            } else {
                node_numeric_ids.insert(n);
            }
        }
        _ => errors.push(TopologyErrorOut::new(
            "INVALID_NODE_NUMERIC_ID",
            "Node numericId must be a non-negative integer.",
            &format!("{}.numericId", path),
        )),
    }

    match node.get("name").and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => {}
        _ => errors.push(TopologyErrorOut::new(
            "INVALID_NODE_NAME",
            "Node name must be a non-empty string.",
            &format!("{}.name", path),
        )),
    }

    let valid_types = ["switch", "endSystem", "server"];
    match node.get("type").and_then(Value::as_str) {
        Some(t) if valid_types.contains(&t) => {}
        other => errors.push(TopologyErrorOut::new(
            "UNSUPPORTED_NODE_TYPE",
            format!("Unsupported node type: {}", other.unwrap_or("")),
            &format!("{}.type", path),
        )),
    }

    let ports = node.get("ports").and_then(Value::as_array);
    match ports {
        Some(p) if !p.is_empty() => {
            if p.len() > MAX_PORTS_PER_NODE {
                errors.push(limit_error(
                    "maxPortsPerNode",
                    &format!("{}.ports", path),
                    p.len(),
                ));
            }
            let mut port_ids: HashSet<String> = HashSet::new();
            for (pi, port) in p.iter().enumerate() {
                let pp = format!("{}.ports[{}]", path, pi);
                match port.get("id").and_then(Value::as_str) {
                    Some(s) if !s.trim().is_empty() => {
                        if port_ids.contains(s) {
                            errors.push(TopologyErrorOut::new(
                                "DUPLICATE_PORT_ID",
                                format!(
                                    "Duplicate port id on node {}: {}",
                                    id_value.as_deref().unwrap_or(""),
                                    s
                                ),
                                &format!("{}.id", pp),
                            ));
                        } else {
                            port_ids.insert(s.to_string());
                        }
                    }
                    _ => errors.push(TopologyErrorOut::new(
                        "MISSING_PORT_ID",
                        "Port id must be a non-empty string.",
                        &format!("{}.id", pp),
                    )),
                }
                match port.get("index").and_then(Value::as_i64) {
                    Some(idx) if idx >= 0 => {}
                    _ => errors.push(TopologyErrorOut::new(
                        "INVALID_PORT_INDEX",
                        "Port index must be a non-negative integer.",
                        &format!("{}.index", pp),
                    )),
                }
            }
            if let Some(id) = &id_value {
                port_ids_by_node.insert(id.clone(), port_ids);
            }
        }
        _ => errors.push(TopologyErrorOut::new(
            "MISSING_NODE_PORTS",
            "Node ports must be a non-empty array.",
            &format!("{}.ports", path),
        )),
    }

    let pos_x = node
        .get("position")
        .and_then(|p| p.get("x"))
        .and_then(Value::as_f64);
    let pos_y = node
        .get("position")
        .and_then(|p| p.get("y"))
        .and_then(Value::as_f64);
    if pos_x.is_none() || pos_y.is_none() {
        errors.push(TopologyErrorOut::new(
            "INVALID_NODE_POSITION",
            "Node position must contain numeric x and y.",
            &format!("{}.position", path),
        ));
    }
}

fn validate_link_values(
    links: &[Value],
    errors: &mut Vec<TopologyErrorOut>,
    node_ids: &HashSet<String>,
    port_ids_by_node: &HashMap<String, HashSet<String>>,
) {
    let mut link_ids: HashSet<String> = HashSet::new();
    let mut link_numeric_ids: HashSet<i64> = HashSet::new();
    let mut used_ports: HashMap<String, String> = HashMap::new();

    for (index, link) in links.iter().enumerate() {
        let path = format!("$.links[{}]", index);

        let id_str = link.get("id").and_then(Value::as_str).map(str::to_string);
        match &id_str {
            Some(s) if !s.trim().is_empty() => {
                if link_ids.contains(s) {
                    errors.push(TopologyErrorOut::new(
                        "DUPLICATE_LINK_ID",
                        format!("Duplicate link id: {}", s),
                        &format!("{}.id", path),
                    ));
                } else {
                    link_ids.insert(s.clone());
                }
            }
            _ => errors.push(TopologyErrorOut::new(
                "MISSING_LINK_ID",
                "Link id must be a non-empty string.",
                &format!("{}.id", path),
            )),
        }

        match link.get("numericId").and_then(Value::as_i64) {
            Some(n) if n >= 0 => {
                if link_numeric_ids.contains(&n) {
                    errors.push(TopologyErrorOut::new(
                        "DUPLICATE_LINK_NUMERIC_ID",
                        format!("Duplicate link numericId: {}", n),
                        &format!("{}.numericId", path),
                    ));
                } else {
                    link_numeric_ids.insert(n);
                }
            }
            _ => errors.push(TopologyErrorOut::new(
                "INVALID_LINK_NUMERIC_ID",
                "Link numericId must be a non-negative integer.",
                &format!("{}.numericId", path),
            )),
        }

        match link.get("medium").and_then(Value::as_str) {
            Some("ethernet") => {}
            other => errors.push(TopologyErrorOut::new(
                "UNSUPPORTED_LINK_MEDIUM",
                format!("Unsupported link medium: {}", other.unwrap_or("")),
                &format!("{}.medium", path),
            )),
        }

        match link.get("dataRateMbps").and_then(Value::as_i64) {
            Some(n) if n > 0 => {}
            _ => errors.push(TopologyErrorOut::new(
                "INVALID_LINK_RATE",
                "Link dataRateMbps must be a positive integer.",
                &format!("{}.dataRateMbps", path),
            )),
        }

        validate_endpoint(
            link.get("source"),
            &format!("{}.source", path),
            errors,
            node_ids,
            port_ids_by_node,
            &mut used_ports,
            id_str.as_deref(),
        );
        validate_endpoint(
            link.get("target"),
            &format!("{}.target", path),
            errors,
            node_ids,
            port_ids_by_node,
            &mut used_ports,
            id_str.as_deref(),
        );

        let src_node = link
            .get("source")
            .and_then(|s| s.get("nodeId"))
            .and_then(Value::as_str);
        let dst_node = link
            .get("target")
            .and_then(|t| t.get("nodeId"))
            .and_then(Value::as_str);
        if let (Some(a), Some(b)) = (src_node, dst_node) {
            if a == b {
                errors.push(TopologyErrorOut::new(
                    "SELF_LINK",
                    format!("Link {} cannot connect a node to itself.", id_str.as_deref().unwrap_or("")),
                    &path,
                ));
            }
        }
    }
}

fn validate_endpoint(
    endpoint: Option<&Value>,
    path: &str,
    errors: &mut Vec<TopologyErrorOut>,
    node_ids: &HashSet<String>,
    port_ids_by_node: &HashMap<String, HashSet<String>>,
    used_ports: &mut HashMap<String, String>,
    link_id: Option<&str>,
) {
    let Some(endpoint) = endpoint.filter(|v| v.is_object()) else {
        errors.push(TopologyErrorOut::new(
            "MISSING_LINK_ENDPOINT",
            "Link endpoint must be an object.",
            path,
        ));
        return;
    };

    let node_id = endpoint.get("nodeId").and_then(Value::as_str);
    match node_id {
        Some(n) if node_ids.contains(n) => {}
        _ => {
            errors.push(TopologyErrorOut::new(
                "UNKNOWN_ENDPOINT_NODE",
                format!(
                    "Endpoint node does not exist: {}",
                    node_id.unwrap_or("")
                ),
                &format!("{}.nodeId", path),
            ));
            return;
        }
    }
    let node_id = node_id.unwrap();
    let port_id = endpoint.get("portId").and_then(Value::as_str);
    let known_ports = port_ids_by_node.get(node_id);
    match (port_id, known_ports) {
        (Some(p), Some(ports)) if ports.contains(p) => {
            let port_key = format!("{}:{}", node_id, p);
            let current_link = link_id.unwrap_or("").to_string();
            if let Some(prev) = used_ports.get(&port_key) {
                errors.push(TopologyErrorOut::new(
                    "PORT_ALREADY_USED",
                    format!(
                        "Port {} is used by both {} and {}.",
                        port_key, prev, current_link
                    ),
                    path,
                ));
            } else {
                used_ports.insert(port_key, current_link);
            }
        }
        _ => errors.push(TopologyErrorOut::new(
            "UNKNOWN_ENDPOINT_PORT",
            format!(
                "Endpoint port does not exist: {}.{}",
                node_id,
                port_id.unwrap_or("")
            ),
            &format!("{}.portId", path),
        )),
    }
}

fn finalize_validation(
    candidate: &Value,
    errors: Vec<TopologyErrorOut>,
    warnings: Vec<TopologyWarningOut>,
) -> ValidationReport {
    let nodes = candidate
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let links = candidate
        .get("links")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let schema_version = candidate
        .get("schemaVersion")
        .and_then(Value::as_str)
        .unwrap_or(INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION)
        .to_string();

    let mut switch_count = 0usize;
    let mut end_system_count = 0usize;
    let mut server_count = 0usize;
    for n in &nodes {
        match n.get("type").and_then(Value::as_str) {
            Some("switch") => switch_count += 1,
            Some("endSystem") => end_system_count += 1,
            Some("server") => server_count += 1,
            _ => {}
        }
    }

    let mut codes: BTreeSet<String> = BTreeSet::new();
    for e in &errors {
        codes.insert(e.code.clone());
    }

    let ok = errors.is_empty();
    let summary = ValidateSummary {
        valid: ok,
        schema_version,
        node_count: nodes.len(),
        link_count: links.len(),
        switch_count,
        end_system_count,
        server_count,
        warning_count: warnings.len(),
        error_count: errors.len(),
        error_codes: codes.into_iter().collect(),
    };
    ValidationReport {
        ok,
        errors,
        warnings,
        summary,
    }
}

// ============================================================================
// inspect
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRequestBody {
    pub topology: Value,
    #[serde(default)]
    pub selectors: Vec<Value>,
    #[serde(default = "default_true")]
    pub include_adjacency: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectAdjacency {
    pub node_id: String,
    pub used_ports: Vec<String>,
    pub neighbor_node_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectSummary {
    pub node_count: usize,
    pub link_count: usize,
    pub selected_node_ids: Vec<String>,
    pub selected_link_ids: Vec<String>,
    pub adjacency: Vec<InspectAdjacency>,
}

pub fn inspect_topology(
    req: &InspectRequestBody,
) -> Result<(InspectSummary, Vec<TopologyWarningOut>), Vec<TopologyErrorOut>> {
    let report = validate_intermediate_topology(&req.topology);
    if !report.ok {
        return Err(report.errors);
    }

    let nodes = req
        .topology
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let links = req
        .topology
        .get("links")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut selected_nodes: HashMap<String, Value> = HashMap::new();
    let mut selected_links: HashMap<String, Value> = HashMap::new();

    for (index, selector) in req.selectors.iter().enumerate() {
        let kind = selector
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind == "node" {
            let matches: Vec<Value> = nodes
                .iter()
                .filter(|n| selector_matches_node(selector, n))
                .cloned()
                .collect();
            if matches.len() != 1 {
                return Err(vec![selector_failure(
                    "node",
                    &matches,
                    index,
                )]);
            }
            for m in matches {
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    selected_nodes.insert(id.to_string(), m.clone());
                }
            }
        } else if kind == "link" {
            let matches: Vec<Value> = links
                .iter()
                .filter(|l| selector_matches_link(selector, l))
                .cloned()
                .collect();
            if matches.len() != 1 {
                return Err(vec![selector_failure(
                    "link",
                    &matches,
                    index,
                )]);
            }
            for m in matches {
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    selected_links.insert(id.to_string(), m.clone());
                }
            }
        } else {
            return Err(vec![TopologyErrorOut::new(
                "INVALID_SELECTOR",
                "selector.kind must be 'node' or 'link'.",
                &format!("$.selectors[{}].kind", index),
            )]);
        }
    }

    let port_usage = build_port_usage(&nodes, &links);
    let adjacency_source: Vec<Value> = if !selected_nodes.is_empty() {
        selected_nodes.values().cloned().collect()
    } else {
        nodes.clone()
    };

    let adjacency = if req.include_adjacency {
        adjacency_source
            .iter()
            .map(|node| {
                let nid = node
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let edges = port_usage.get(&nid).cloned().unwrap_or_default();
                let mut used_ports: Vec<String> =
                    edges.iter().map(|e| e.port_id.clone()).collect();
                used_ports.sort();
                let mut neighbors: Vec<String> = edges
                    .iter()
                    .map(|e| e.neighbor_node_id.clone())
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .collect();
                neighbors.sort();
                InspectAdjacency {
                    node_id: nid,
                    used_ports,
                    neighbor_node_ids: neighbors,
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut sn_ids: Vec<String> = selected_nodes.keys().cloned().collect();
    sn_ids.sort();
    let mut sl_ids: Vec<String> = selected_links.keys().cloned().collect();
    sl_ids.sort();

    Ok((
        InspectSummary {
            node_count: nodes.len(),
            link_count: links.len(),
            selected_node_ids: sn_ids,
            selected_link_ids: sl_ids,
            adjacency,
        },
        report.warnings,
    ))
}

fn selector_matches_node(selector: &Value, node: &Value) -> bool {
    let sel_id = selector.get("id").and_then(Value::as_str);
    let sel_name = selector.get("name").and_then(Value::as_str);
    let sel_type = selector.get("type").and_then(Value::as_str);
    let node_id = node.get("id").and_then(Value::as_str);
    let node_name = node.get("name").and_then(Value::as_str);
    let node_type = node.get("type").and_then(Value::as_str);
    let id_ok = sel_id.is_none() || sel_id == node_id;
    let name_ok = sel_name.is_none() || sel_name == node_name;
    let type_ok = sel_type.is_none() || sel_type == node_type;
    id_ok && name_ok && type_ok
}

fn selector_matches_link(selector: &Value, link: &Value) -> bool {
    let sel_id = selector.get("id").and_then(Value::as_str);
    let link_id = link.get("id").and_then(Value::as_str);
    sel_id.is_none() || sel_id == link_id
}

fn selector_failure(kind: &str, matches: &[Value], index: usize) -> TopologyErrorOut {
    if matches.is_empty() {
        TopologyErrorOut::new(
            "SELECTOR_NOT_FOUND",
            format!("No {} matched the selector.", kind),
            &format!("$.selectors[{}]", index),
        )
        .with_details(json!({ "candidateCount": 0 }))
    } else {
        TopologyErrorOut::new(
            "AMBIGUOUS_SELECTOR",
            format!("{} {} candidates matched the selector.", matches.len(), kind),
            &format!("$.selectors[{}]", index),
        )
        .with_details(json!({ "candidateCount": matches.len() }))
        .requires_clarification()
    }
}

#[derive(Debug, Clone)]
struct PortUsageEntry {
    port_id: String,
    #[allow(dead_code)]
    link_id: String,
    neighbor_node_id: String,
}

fn build_port_usage(
    nodes: &[Value],
    links: &[Value],
) -> HashMap<String, Vec<PortUsageEntry>> {
    let mut usage: HashMap<String, Vec<PortUsageEntry>> = nodes
        .iter()
        .filter_map(|n| n.get("id").and_then(Value::as_str).map(|s| (s.to_string(), Vec::new())))
        .collect();
    for link in links {
        let src = link.get("source");
        let dst = link.get("target");
        let lid = link.get("id").and_then(Value::as_str).unwrap_or("");
        if let (Some(s), Some(t)) = (src, dst) {
            let sn = s.get("nodeId").and_then(Value::as_str);
            let sp = s.get("portId").and_then(Value::as_str);
            let tn = t.get("nodeId").and_then(Value::as_str);
            let tp = t.get("portId").and_then(Value::as_str);
            if let (Some(sn), Some(sp), Some(tn)) = (sn, sp, tn) {
                usage
                    .entry(sn.to_string())
                    .or_default()
                    .push(PortUsageEntry {
                        port_id: sp.to_string(),
                        link_id: lid.to_string(),
                        neighbor_node_id: tn.to_string(),
                    });
            }
            if let (Some(tn), Some(tp), Some(sn)) = (tn, tp, sn) {
                usage
                    .entry(tn.to_string())
                    .or_default()
                    .push(PortUsageEntry {
                        port_id: tp.to_string(),
                        link_id: lid.to_string(),
                        neighbor_node_id: sn.to_string(),
                    });
            }
        }
    }
    usage
}

// ============================================================================
// build_artifacts (artifacts.ts 4 件套，含 BFS)
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsSummary {
    pub artifact_count: usize,
    pub artifact_names: Vec<String>,
    pub total_bytes: usize,
    pub topology_node_count: usize,
    pub topology_link_count: usize,
    pub mac_entry_count: usize,
    pub contains_html: bool,
}

pub struct BuildArtifactsResult {
    pub artifacts: Value, // {"topology.json": {...wrapper}, ...} 与 TS shape 一致
    pub summary: ArtifactsSummary,
    #[allow(dead_code)] // route only surfaces summary/full；保留字段供未来接 sidecar 路径
    pub warnings: Vec<TopologyWarningOut>,
}

pub fn build_topology_artifacts(
    topology_value: &Value,
) -> Result<BuildArtifactsResult, Vec<TopologyErrorOut>> {
    let report = validate_intermediate_topology(topology_value);
    if !report.ok {
        return Err(report.errors);
    }
    let topology: IntermediateTopology = serde_json::from_value(topology_value.clone())
        .map_err(|e| {
            vec![TopologyErrorOut::new(
                "INVALID_INTERMEDIATE",
                format!("Failed to deserialize IntermediateTopology: {}", e),
                "$",
            )]
        })?;

    let topology_json = build_legacy_topology_json(&topology);
    let topo_feature = build_legacy_topo_feature(&topology);
    let data_server = build_legacy_data_server(&topology);
    let mac_table = build_legacy_mac_forwarding_table(&topology);

    let artifacts = json!({
        "topology.json": wrap_artifact("topology.json", &topology_json),
        "topo_feature.json": wrap_artifact("topo_feature.json", &topo_feature),
        "data-server.json": wrap_artifact("data-server.json", &data_server),
        "mac-forwarding-table.json": wrap_artifact("mac-forwarding-table.json", &mac_table),
    });

    let total_bytes = artifact_byte_length(&topology_json)
        + artifact_byte_length(&topo_feature)
        + artifact_byte_length(&data_server)
        + artifact_byte_length(&mac_table);

    if total_bytes > MAX_ARTIFACT_BYTES {
        return Err(vec![limit_error("maxArtifactBytes", "$.artifacts", total_bytes)]);
    }

    let topology_nodes_count = topology_json
        .get("node")
        .and_then(|n| n.get("nodes"))
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    let topology_links_count = topology_json
        .get("node")
        .and_then(|n| n.get("links"))
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    let mac_entry_count = mac_table
        .get("entries")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);

    Ok(BuildArtifactsResult {
        artifacts,
        summary: ArtifactsSummary {
            artifact_count: 4,
            artifact_names: vec![
                "topology.json".into(),
                "topo_feature.json".into(),
                "data-server.json".into(),
                "mac-forwarding-table.json".into(),
            ],
            total_bytes,
            topology_node_count: topology_nodes_count,
            topology_link_count: topology_links_count,
            mac_entry_count,
            contains_html: false,
        },
        warnings: report.warnings,
    })
}

fn wrap_artifact(name: &str, data: &Value) -> Value {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(data).unwrap_or_else(|_| "null".to_string())
    );
    let byte_length = artifact_byte_length(data);
    json!({
        "name": name,
        "mediaType": "application/json",
        "data": data,
        "text": text,
        "byteLength": byte_length,
    })
}

fn artifact_byte_length(value: &Value) -> usize {
    serde_json::to_string(value).map(|s| s.len()).unwrap_or(0)
}

fn imac_by_node_id_map(sorted_nodes: &[IntermediateNode]) -> HashMap<String, i64> {
    sorted_nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.clone(), 100 + i as i64))
        .collect()
}

fn legacy_node_type(t: IntermediateNodeType) -> &'static str {
    match t {
        IntermediateNodeType::Switch => "switch",
        IntermediateNodeType::EndSystem => "networkcard",
        IntermediateNodeType::Server => "server",
    }
}

fn legacy_class_path(t: IntermediateNodeType) -> &'static str {
    match t {
        IntermediateNodeType::Switch => "Q.Graphs.exchanger2",
        IntermediateNodeType::Server => "Q.Graphs.server",
        IntermediateNodeType::EndSystem => "Q.Graphs.node",
    }
}

fn legacy_port_number(node: &IntermediateNode, port_id: &str) -> Result<i64, String> {
    node.ports
        .iter()
        .find(|p| p.id == port_id)
        .map(|p| p.index)
        .ok_or_else(|| format!("Port {}.{} does not exist.", node.id, port_id))
}

fn node_by_id<'a>(
    topology: &'a IntermediateTopology,
    node_id: &str,
) -> Result<&'a IntermediateNode, String> {
    topology
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .ok_or_else(|| format!("Node {} does not exist.", node_id))
}

fn build_legacy_topology_json(topology: &IntermediateTopology) -> Value {
    let sorted_nodes = sort_nodes_by_numeric_id(&topology.nodes);
    let imac_by_node_id = imac_by_node_id_map(&sorted_nodes);
    let sorted_links = sort_links_by_numeric_id(&topology.links);

    let nodes_out: Vec<Value> = sorted_nodes
        .iter()
        .map(|node| {
            let imac = *imac_by_node_id.get(&node.id).unwrap_or(&100);
            json!({
                "imac": imac,
                "sync_name": node.numeric_id.to_string(),
                "x": node.position.x.round() as i64,
                "y": node.position.y.round() as i64,
                "sync_type": { "_classPath": legacy_class_path(node.node_type) },
                "node_type": legacy_node_type(node.node_type),
            })
        })
        .collect();

    let links_out: Vec<Value> = sorted_links
        .iter()
        .map(|link| {
            let source_node = node_by_id(topology, &link.source.node_id).unwrap_or_else(|_| &topology.nodes[0]);
            let target_node = node_by_id(topology, &link.target.node_id).unwrap_or_else(|_| &topology.nodes[0]);
            let source_port = legacy_port_number(source_node, &link.source.port_id).unwrap_or(0);
            let target_port = legacy_port_number(target_node, &link.target.port_id).unwrap_or(0);
            json!({
                "name": format!(
                    "{}:{}-{}:{}",
                    source_node.numeric_id, source_port, target_node.numeric_id, target_port
                ),
                "styles": {
                    "leftLabel": source_port.to_string(),
                    "rightLabel": target_port.to_string(),
                    "speed": link.data_rate_mbps,
                },
                "imac": *imac_by_node_id.get(&source_node.id).unwrap_or(&100),
                "addr": *imac_by_node_id.get(&target_node.id).unwrap_or(&100),
            })
        })
        .collect();

    json!({
        "node": { "nodes": nodes_out, "links": links_out },
        "refs": {},
    })
}

fn build_legacy_topo_feature(topology: &IntermediateTopology) -> Value {
    let node_types_by_id: HashMap<String, IntermediateNodeType> = topology
        .nodes
        .iter()
        .map(|n| (n.id.clone(), n.node_type))
        .collect();
    let mut entries: Vec<Value> = Vec::new();
    let mut link_id: i64 = 0;
    for link in sort_links_by_numeric_id(&topology.links) {
        let source = match node_by_id(topology, &link.source.node_id) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let target = match node_by_id(topology, &link.target.node_id) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let src_is_server = node_types_by_id.get(&source.id) == Some(&IntermediateNodeType::Server);
        let dst_is_server = node_types_by_id.get(&target.id) == Some(&IntermediateNodeType::Server);
        if src_is_server || dst_is_server {
            continue;
        }
        let source_port = legacy_port_number(source, &link.source.port_id).unwrap_or(0);
        let target_port = legacy_port_number(target, &link.target.port_id).unwrap_or(0);
        entries.push(json!({
            "link_id": link_id,
            "src_node": source.numeric_id,
            "src_port": source_port,
            "dst_node": target.numeric_id,
            "dst_port": target_port,
            "speed": link.data_rate_mbps,
            "st_queues": 3,
        }));
        link_id += 1;
        entries.push(json!({
            "link_id": link_id,
            "src_node": target.numeric_id,
            "src_port": target_port,
            "dst_node": source.numeric_id,
            "dst_port": source_port,
            "speed": link.data_rate_mbps,
            "st_queues": 3,
        }));
        link_id += 1;
    }
    Value::Array(entries)
}

fn build_legacy_data_server(topology: &IntermediateTopology) -> Value {
    let sorted_nodes = sort_nodes_by_numeric_id(&topology.nodes);
    let imac_by_node_id = imac_by_node_id_map(&sorted_nodes);
    let mut datas: Vec<Value> = Vec::new();

    for node in &sorted_nodes {
        let legacy_type = legacy_node_type(node.node_type);
        let imac = *imac_by_node_id.get(&node.id).unwrap_or(&100);
        let mut item = serde_json::Map::new();
        item.insert("_className".into(), json!("Q.Node"));
        item.insert(
            "json".into(),
            json!({
                "name": node.numeric_id.to_string(),
                "location": {
                    "_className": "Q.Point",
                    "json": {
                        "x": node.position.x.round() as i64,
                        "y": node.position.y.round() as i64,
                        "rotate": 0,
                    }
                },
                "image": { "_classPath": legacy_class_path(node.node_type) }
            }),
        );
        item.insert("id".into(), json!(imac));
        item.insert("src_imac".into(), json!(imac));
        item.insert("display_name".into(), json!(node.name));
        item.insert("node_type".into(), json!(legacy_type));

        if legacy_type != "server" {
            item.insert("buffer_num".into(), json!(8));
            item.insert("queue_num".into(), json!(3));
            item.insert(
                "mac_address".into(),
                json!(node
                    .mac_address
                    .clone()
                    .unwrap_or_else(|| derive_legacy_mac(node.numeric_id))),
            );
            item.insert(
                "ip".into(),
                json!(node
                    .ip_address
                    .clone()
                    .unwrap_or_else(|| derive_legacy_ip(node.numeric_id))),
            );
            item.insert("port_count".into(), json!(node.ports.len()));
        }

        datas.push(Value::Object(item));
    }

    let mut edge_id = 100 + sorted_nodes.len() as i64;
    for link in sort_links_by_numeric_id(&topology.links) {
        let source = match node_by_id(topology, &link.source.node_id) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let target = match node_by_id(topology, &link.target.node_id) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let source_port = legacy_port_number(source, &link.source.port_id).unwrap_or(0);
        let target_port = legacy_port_number(target, &link.target.port_id).unwrap_or(0);
        datas.push(json!({
            "_className": "Q.Edge",
            "json": {
                "name": format!(
                    "{}:{}-{}:{}",
                    source.numeric_id, source_port, target.numeric_id, target_port
                ),
                "from": { "_ref": *imac_by_node_id.get(&source.id).unwrap_or(&100) },
                "to": { "_ref": *imac_by_node_id.get(&target.id).unwrap_or(&100) },
                "styles": {
                    "leftLabel": source_port.to_string(),
                    "rightLabel": target_port.to_string(),
                    "speed": link.data_rate_mbps,
                }
            },
            "id": edge_id,
            "bindingUIs": [],
        }));
        edge_id += 1;
    }

    json!({
        "version": "2.0",
        "refs": {},
        "datas": datas,
        "scale": 1,
    })
}

fn build_legacy_mac_forwarding_table(topology: &IntermediateTopology) -> Value {
    let sorted_nodes = sort_nodes_by_numeric_id(&topology.nodes);
    let imac_by_id = imac_by_node_id_map(&sorted_nodes);
    let adjacency = build_adjacency(topology);
    let mut entries: Vec<Value> = Vec::new();

    for sw in sorted_nodes
        .iter()
        .filter(|n| n.node_type == IntermediateNodeType::Switch)
    {
        for dst in &sorted_nodes {
            if dst.id == sw.id {
                continue;
            }
            let Some(egress_port) = find_first_egress_port(&sw.id, &dst.id, &adjacency) else {
                continue;
            };
            entries.push(json!({
                "switch_node": sw.numeric_id,
                "switch_imac": *imac_by_id.get(&sw.id).unwrap_or(&100),
                "switch_name": sw.name,
                "destination_node": dst.numeric_id,
                "destination_imac": *imac_by_id.get(&dst.id).unwrap_or(&100),
                "destination_mac": dst
                    .mac_address
                    .clone()
                    .unwrap_or_else(|| derive_legacy_mac(dst.numeric_id)),
                "destination_name": dst.name,
                "egress_port": egress_port,
            }));
        }
    }

    json!({
        "version": "1.0",
        "entries": entries,
    })
}

#[derive(Debug, Clone)]
struct AdjacencyEdge {
    node_id: String,
    out_port: i64,
}

fn build_adjacency(topology: &IntermediateTopology) -> HashMap<String, Vec<AdjacencyEdge>> {
    let mut adjacency: HashMap<String, Vec<AdjacencyEdge>> = topology
        .nodes
        .iter()
        .map(|n| (n.id.clone(), Vec::new()))
        .collect();

    for link in &topology.links {
        let source = match node_by_id(topology, &link.source.node_id) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let target = match node_by_id(topology, &link.target.node_id) {
            Ok(n) => n,
            Err(_) => continue,
        };
        let s_port = legacy_port_number(source, &link.source.port_id).unwrap_or(0);
        let t_port = legacy_port_number(target, &link.target.port_id).unwrap_or(0);

        adjacency.entry(link.source.node_id.clone()).or_default().push(AdjacencyEdge {
            node_id: link.target.node_id.clone(),
            out_port: s_port,
        });
        adjacency.entry(link.target.node_id.clone()).or_default().push(AdjacencyEdge {
            node_id: link.source.node_id.clone(),
            out_port: t_port,
        });
    }

    for edges in adjacency.values_mut() {
        edges.sort_by(|a, b| match a.node_id.cmp(&b.node_id) {
            std::cmp::Ordering::Equal => a.out_port.cmp(&b.out_port),
            other => other,
        });
    }

    adjacency
}

fn find_first_egress_port(
    start_node_id: &str,
    destination_node_id: &str,
    adjacency: &HashMap<String, Vec<AdjacencyEdge>>,
) -> Option<i64> {
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(start_node_id.to_string());
    let mut queue: VecDeque<(String, Option<i64>)> = VecDeque::new();
    queue.push_back((start_node_id.to_string(), None));

    while let Some((current_node, first_port)) = queue.pop_front() {
        if let Some(edges) = adjacency.get(&current_node) {
            for edge in edges {
                if seen.contains(&edge.node_id) {
                    continue;
                }
                let next_first = if current_node == start_node_id {
                    Some(edge.out_port)
                } else {
                    first_port
                };
                if edge.node_id == destination_node_id {
                    return next_first;
                }
                seen.insert(edge.node_id.clone());
                queue.push_back((edge.node_id.clone(), next_first));
            }
        }
    }
    None
}

// ============================================================================
// describe_artifacts + validate_artifacts
// ============================================================================

pub fn describe_topology_artifacts(artifacts_value: &Value) -> Value {
    let topo = artifacts_value
        .get("topology.json")
        .and_then(|t| t.get("data"))
        .cloned()
        .unwrap_or(Value::Null);
    let mac = artifacts_value
        .get("mac-forwarding-table.json")
        .and_then(|t| t.get("data"))
        .cloned()
        .unwrap_or(Value::Null);

    let mut total_bytes: usize = 0;
    let mut names: Vec<String> = Vec::new();
    for name in [
        "topology.json",
        "topo_feature.json",
        "data-server.json",
        "mac-forwarding-table.json",
    ] {
        if let Some(art) = artifacts_value.get(name) {
            names.push(name.into());
            total_bytes += art
                .get("byteLength")
                .and_then(Value::as_u64)
                .map(|n| n as usize)
                .unwrap_or_else(|| {
                    art.get("data")
                        .map(artifact_byte_length)
                        .unwrap_or(0)
                });
        }
    }
    let node_count = topo
        .get("node")
        .and_then(|n| n.get("nodes"))
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    let link_count = topo
        .get("node")
        .and_then(|n| n.get("links"))
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    let mac_entry_count = mac
        .get("entries")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);

    json!({
        "artifactCount": names.len(),
        "artifactNames": [
            "topology.json", "topo_feature.json",
            "data-server.json", "mac-forwarding-table.json",
        ],
        "totalBytes": total_bytes,
        "topologyNodeCount": node_count,
        "topologyLinkCount": link_count,
        "macEntryCount": mac_entry_count,
        "containsHtml": false,
    })
}

pub struct ValidateArtifactsReport {
    pub ok: bool,
    pub errors: Vec<TopologyErrorOut>,
    pub artifact_names: Vec<String>,
}

pub fn validate_topology_artifacts(artifacts_value: &Value) -> ValidateArtifactsReport {
    let mut errors: Vec<TopologyErrorOut> = Vec::new();
    let topology_data = artifacts_value
        .get("topology.json")
        .and_then(|v| {
            // 兼容包装形式 {data: ...} 和裸值
            if v.is_object() && v.get("data").is_some() {
                v.get("data").cloned()
            } else {
                Some(v.clone())
            }
        });
    let topo_feature = artifacts_value
        .get("topo_feature.json")
        .and_then(|v| {
            if v.is_object() && v.get("data").is_some() {
                v.get("data").cloned()
            } else {
                Some(v.clone())
            }
        });
    let data_server = artifacts_value
        .get("data-server.json")
        .and_then(|v| {
            if v.is_object() && v.get("data").is_some() {
                v.get("data").cloned()
            } else {
                Some(v.clone())
            }
        });
    let mac_table = artifacts_value
        .get("mac-forwarding-table.json")
        .and_then(|v| {
            if v.is_object() && v.get("data").is_some() {
                v.get("data").cloned()
            } else {
                Some(v.clone())
            }
        });

    let topology_ok = topology_data
        .as_ref()
        .and_then(|t| t.get("node"))
        .map(|n| {
            n.get("nodes").and_then(Value::as_array).is_some()
                && n.get("links").and_then(Value::as_array).is_some()
        })
        .unwrap_or(false);
    if !topology_ok {
        errors.push(TopologyErrorOut::new(
            "INVALID_ARTIFACT",
            "topology.json must contain node.nodes and node.links arrays.",
            "$.artifacts['topology.json']",
        ));
    }

    if !topo_feature.as_ref().map(Value::is_array).unwrap_or(false) {
        errors.push(TopologyErrorOut::new(
            "INVALID_ARTIFACT",
            "topo_feature.json must be an array.",
            "$.artifacts['topo_feature.json']",
        ));
    }

    let data_server_ok = data_server
        .as_ref()
        .map(|d| {
            d.get("version").and_then(Value::as_str) == Some("2.0")
                && d.get("datas").and_then(Value::as_array).is_some()
        })
        .unwrap_or(false);
    if !data_server_ok {
        errors.push(TopologyErrorOut::new(
            "INVALID_ARTIFACT",
            "data-server.json must contain version 2.0 and datas array.",
            "$.artifacts['data-server.json']",
        ));
    }

    let mac_table_ok = mac_table
        .as_ref()
        .map(|m| {
            m.get("version").and_then(Value::as_str) == Some("1.0")
                && m.get("entries").and_then(Value::as_array).is_some()
        })
        .unwrap_or(false);
    if !mac_table_ok {
        errors.push(TopologyErrorOut::new(
            "INVALID_ARTIFACT",
            "mac-forwarding-table.json must contain version 1.0 and entries array.",
            "$.artifacts['mac-forwarding-table.json']",
        ));
    }

    // Cross-artifact: topo_feature edges reference unknown node
    if let (Some(topology), Some(features_value)) = (&topology_data, &topo_feature) {
        if let Some(nodes_arr) = topology.get("node").and_then(|n| n.get("nodes")).and_then(Value::as_array) {
            let node_ids: HashSet<i64> = nodes_arr
                .iter()
                .filter_map(|n| {
                    n.get("sync_name")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<i64>().ok())
                })
                .collect();
            if let Some(features) = features_value.as_array() {
                for (index, edge) in features.iter().enumerate() {
                    let src = edge.get("src_node").and_then(Value::as_i64);
                    let dst = edge.get("dst_node").and_then(Value::as_i64);
                    if !matches!(src, Some(n) if node_ids.contains(&n))
                        || !matches!(dst, Some(n) if node_ids.contains(&n))
                    {
                        errors.push(TopologyErrorOut::new(
                            "ARTIFACT_REFERENCE_ERROR",
                            "topo_feature edge references an unknown node.",
                            &format!("$.artifacts['topo_feature.json'][{}]", index),
                        ));
                    }
                }
            }
        }
    }

    // Cross-artifact: mac-forwarding entries reference unknown nodes
    if let (Some(topology), Some(mac)) = (&topology_data, &mac_table) {
        if let (Some(nodes_arr), Some(entries)) = (
            topology
                .get("node")
                .and_then(|n| n.get("nodes"))
                .and_then(Value::as_array),
            mac.get("entries").and_then(Value::as_array),
        ) {
            let node_ids: HashSet<i64> = nodes_arr
                .iter()
                .filter_map(|n| {
                    n.get("sync_name")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<i64>().ok())
                })
                .collect();
            for (index, entry) in entries.iter().enumerate() {
                let sw = entry.get("switch_node").and_then(Value::as_i64);
                let dst = entry.get("destination_node").and_then(Value::as_i64);
                if !matches!(sw, Some(n) if node_ids.contains(&n))
                    || !matches!(dst, Some(n) if node_ids.contains(&n))
                {
                    errors.push(TopologyErrorOut::new(
                        "ARTIFACT_REFERENCE_ERROR",
                        "mac-forwarding-table entry references an unknown node.",
                        &format!(
                            "$.artifacts['mac-forwarding-table.json'].entries[{}]",
                            index
                        ),
                    ));
                }
            }
        }
    }

    let mut names: Vec<String> = artifacts_value
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();

    ValidateArtifactsReport {
        ok: errors.is_empty(),
        errors,
        artifact_names: names,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn build_minimal_generic_line() -> IntermediateTopology {
        initialize_topology(&InitializeIntent {
            template_id: "generic-line".into(),
            params: json!({ "switchCount": 2, "endSystemsPerSwitch": 1 }),
        })
        .map(|(t, _)| t)
        .expect("generic-line topology should be valid")
    }

    #[test]
    fn describe_templates_includes_all_three_templates() {
        let catalog = describe_templates_catalog();
        assert_eq!(catalog["templateCount"], 3);
        let ids = catalog["templateIds"].as_array().unwrap();
        assert!(ids.iter().any(|v| v == "generic-line"));
        assert!(ids.iter().any(|v| v == "generic-ring"));
        assert!(ids.iter().any(|v| v == "dual-plane-redundant"));
    }

    #[test]
    fn initialize_generic_line_produces_chain_topology() {
        let topology = build_minimal_generic_line();
        assert_eq!(topology.nodes.len(), 4);
        // 2 switches + 2 end systems
        assert_eq!(topology.switch_count(), 2);
        assert_eq!(topology.end_system_count(), 2);
        // 2 host-to-switch links + 1 switch interconnect = 3 links
        assert_eq!(topology.links.len(), 3);
    }

    #[test]
    fn initialize_generic_ring_closes_loop_with_enough_switches() {
        let (topology, _) = initialize_topology(&InitializeIntent {
            template_id: "generic-ring".into(),
            params: json!({ "switchCount": 4, "endSystemsPerSwitch": 1 }),
        })
        .unwrap();
        // 4 host-switch + 3 interconnect (line) + 1 closing = 8
        assert_eq!(topology.links.len(), 8);
    }

    #[test]
    fn initialize_rejects_dual_plane_until_phase_b() {
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: json!({ "planes": [{"id": "A"}, {"id": "B"}] }),
        })
        .unwrap_err();
        assert_eq!(err[0].code, "INVALID_TEMPLATE_PARAM");
        assert!(err[0].message.contains("dual-plane"));
    }

    #[test]
    fn initialize_rejects_unknown_template() {
        let err = initialize_topology(&InitializeIntent {
            template_id: "aerospace-redundant".into(),
            params: json!({}),
        })
        .unwrap_err();
        assert_eq!(err[0].code, "UNKNOWN_TEMPLATE_ID");
    }

    #[test]
    fn initialize_rejects_switch_count_out_of_range() {
        let err = initialize_topology(&InitializeIntent {
            template_id: "generic-line".into(),
            params: json!({ "switchCount": 200 }),
        })
        .unwrap_err();
        assert_eq!(err[0].code, "INVALID_TEMPLATE_PARAM");
        assert_eq!(err[0].path, "$.params.switchCount");
    }

    #[test]
    fn validate_intermediate_passes_for_initialize_output() {
        let topology = build_minimal_generic_line();
        let raw = serde_json::to_value(&topology).unwrap();
        let report = validate_intermediate_topology(&raw);
        assert!(report.ok, "errors={:?}", report.errors);
        assert!(report.summary.valid);
    }

    #[test]
    fn validate_intermediate_detects_missing_schema_version() {
        let raw = json!({
            "metadata": {},
            "nodes": [],
            "links": [],
            "diagnostics": []
        });
        let report = validate_intermediate_topology(&raw);
        assert!(!report.ok);
        assert!(report
            .errors
            .iter()
            .any(|e| e.code == "UNSUPPORTED_SCHEMA_VERSION"));
    }

    #[test]
    fn build_artifacts_returns_four_jsons_with_expected_counts() {
        let topology = build_minimal_generic_line();
        let raw = serde_json::to_value(&topology).unwrap();
        let result = build_topology_artifacts(&raw).expect("build OK");
        assert_eq!(result.summary.artifact_count, 4);
        assert_eq!(result.summary.contains_html, false);
        // Topology has 2 switches + 2 endSystems = 4 nodes
        assert_eq!(result.summary.topology_node_count, 4);
        // 2 host-switch + 1 interconnect
        assert_eq!(result.summary.topology_link_count, 3);
        // 2 switches × (3 dst non-self) but only ones reachable count;
        // 在最简 generic-line(2/1) fixture 中，2 switches 之间每边能算到对方 + 终端系统 → 至少 ≥2
        assert!(result.summary.mac_entry_count >= 2);

        let arts = &result.artifacts;
        assert!(arts.get("topology.json").is_some());
        assert!(arts.get("topo_feature.json").is_some());
        assert!(arts.get("data-server.json").is_some());
        assert!(arts.get("mac-forwarding-table.json").is_some());

        // topology.json node count == 4
        let topo_nodes = arts["topology.json"]["data"]["node"]["nodes"]
            .as_array()
            .unwrap();
        assert_eq!(topo_nodes.len(), 4);
    }

    #[test]
    fn describe_artifacts_summarizes_built_artifacts() {
        let topology = build_minimal_generic_line();
        let raw = serde_json::to_value(&topology).unwrap();
        let built = build_topology_artifacts(&raw).unwrap();
        let summary = describe_topology_artifacts(&built.artifacts);
        assert_eq!(summary["artifactCount"], 4);
        assert_eq!(summary["containsHtml"], false);
        assert!(summary["totalBytes"].as_u64().unwrap() > 0);
    }

    #[test]
    fn validate_artifacts_passes_for_built_artifacts() {
        let topology = build_minimal_generic_line();
        let raw = serde_json::to_value(&topology).unwrap();
        let built = build_topology_artifacts(&raw).unwrap();
        let report = validate_topology_artifacts(&built.artifacts);
        assert!(report.ok, "errors={:?}", report.errors);
        assert_eq!(report.artifact_names.len(), 4);
    }

    #[test]
    fn validate_artifacts_detects_bad_versions() {
        let bad = json!({
            "topology.json": { "data": { "node": { "nodes": [], "links": [] } } },
            "topo_feature.json": { "data": "not-array" },
            "data-server.json": { "data": { "version": "1.0", "datas": [] } },
            "mac-forwarding-table.json": { "data": { "version": "2.0", "entries": [] } },
        });
        let report = validate_topology_artifacts(&bad);
        assert!(!report.ok);
        assert!(report.errors.iter().any(|e| e.path.contains("topo_feature")));
        assert!(report.errors.iter().any(|e| e.path.contains("data-server")));
        assert!(report
            .errors
            .iter()
            .any(|e| e.path.contains("mac-forwarding-table")));
    }

    #[test]
    fn inspect_returns_selectors_resolved_by_id() {
        let topology = build_minimal_generic_line();
        let raw = serde_json::to_value(&topology).unwrap();
        let result = inspect_topology(&InspectRequestBody {
            topology: raw,
            selectors: vec![json!({"kind":"node","id":"sw1"})],
            include_adjacency: true,
        })
        .unwrap();
        assert_eq!(result.0.selected_node_ids, vec!["sw1".to_string()]);
    }

    #[test]
    fn inspect_returns_ambiguous_selector_error() {
        let topology = build_minimal_generic_line();
        let raw = serde_json::to_value(&topology).unwrap();
        let err = inspect_topology(&InspectRequestBody {
            topology: raw,
            // Selector by type=switch will match both sw1 and sw2
            selectors: vec![json!({"kind":"node","type":"switch"})],
            include_adjacency: true,
        })
        .unwrap_err();
        assert_eq!(err[0].code, "AMBIGUOUS_SELECTOR");
    }
}
