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
    describe_templates_catalog_filtered(None)
}

/// R7：可选按场景过滤模板候选集。未知场景值返回空列表 + warning（不报错，
/// 前向兼容工业等未来场景）；None 返回全量（向后兼容）。
pub fn describe_templates_catalog_filtered(scenario: Option<&str>) -> Value {
    // verify-skills.mjs 正则锚点：`let all = [...]` 清单与各 descriptor 函数内
    // 首个 "id" 字段（必须先于 example 的伪 id）被 R9 对账消费——改名/重排前
    // 同步 scripts/verify-skills.mjs。
    let all = [
        generic_line_descriptor(),
        generic_ring_descriptor(),
        dual_plane_descriptor(),
    ];
    let templates: Vec<Value> = match scenario {
        None => all.to_vec(),
        Some(scenario) => all
            .iter()
            .filter(|descriptor| {
                descriptor["scenarios"]
                    .as_array()
                    .map(|list| list.iter().any(|v| v.as_str() == Some(scenario)))
                    .unwrap_or(false)
            })
            .cloned()
            .collect(),
    };
    let template_ids: Vec<Value> = templates
        .iter()
        .map(|descriptor| descriptor["id"].clone())
        .collect();
    let mut catalog = json!({
        "templateCount": templates.len(),
        "templateIds": template_ids,
        "templates": templates,
    });
    if let Some(scenario) = scenario {
        catalog["scenario"] = json!(scenario);
        if catalog["templateCount"] == json!(0) {
            catalog["warning"] = json!(format!("未知场景 {scenario}，无匹配模板；省略 scenario 参数可获取全量目录。"));
        }
    }
    catalog
}

fn generic_line_descriptor() -> Value {
    let mut params = generic_distributed_params();
    if let Some(list) = params.as_array_mut() {
        list.push(json!({
            "name": "endSystemPlacement", "type": "enum",
            "values": ["per-switch", "ends-only"], "required": false,
            "description": "端系统挂载策略：per-switch（缺省，每台交换机均匀挂载）；ends-only（端系统仅挂链两端各 1 台，endSystemsPerSwitch 必须为 1；switchCount ≥ 5 时画布蛇形折叠，对应规范图 5-1 五跳线性）。",
        }));
    }
    json!({
        "id": "generic-line",
        "name": "通用线型拓扑",
        "description": "多台交换机线型互联；端系统按策略均匀挂载或仅挂链两端（五跳线性）。",
        "tags": ["generic", "line", "beginner"],
        "scenarios": ["generic-tsn", "aerospace-onboard"],
        "params": params,
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
        "scenarios": ["generic-tsn", "aerospace-onboard"],
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
        "scenarios": ["aerospace-onboard"],
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
              "description": "平面内骨干连接策略，当前仅支持 line（ring 待实现）。",
              "itemShape": { "mode": "line", "withinPlane": "true (fixed)" } },
            { "name": "crossPlaneLinks", "type": "object", "required": true,
              "description": "跨平面桥接策略，当前仅支持 none（隔离平面，端系统双归属；paired 待实现）。",
              "itemShape": { "mode": "none" } },
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
        { "name": "switchCount", "type": "integer",
          "minimum": SWITCH_COUNT_MIN, "maximum": SWITCH_COUNT_MAX,
          "description": "交换机数量。" },
        { "name": "endSystemsPerSwitch", "type": "integer",
          "minimum": END_SYSTEMS_PER_SWITCH_MIN, "maximum": END_SYSTEMS_PER_SWITCH_MAX,
          "description": "每台交换机接入的端系统数量。" },
        data_rate_param()
    ])
}

fn data_rate_param() -> Value {
    json!({
        "name": "dataRateMbps", "type": "enum",
        "values": SUPPORTED_DATA_RATES,
        "description": "链路速率，单位 Mbps。",
    })
}

// ============================================================================
// 参数合法域单一常量源（catalog 与 initialize 校验共用，禁止双硬编码）
// MCP 层 zod（src-node/mcp/topology-tools.ts）有意双写 SWITCH_COUNT_*/END_SYSTEMS_*
// 上下限以提供早失败；drift 由测试守一致，改这里须同步 zod。
// ============================================================================

pub const SWITCH_COUNT_MIN: i64 = 1;
pub const SWITCH_COUNT_MAX: i64 = 12;
pub const END_SYSTEMS_PER_SWITCH_MIN: i64 = 1;
pub const END_SYSTEMS_PER_SWITCH_MAX: i64 = 24;
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

    if intent.template_id == "dual-plane-redundant" {
        // Plan 2026-06-09-004：aerospace-minimal dual-plane 生成（backbone=line +
        // crossPlaneLinks=none + 端系统双归属）。解析 → 校验 → 确定性生成。
        let params = parse_dual_plane_params(&params_obj)?;
        let mut errors = validate_dual_plane_params(&params);
        // dataRateMbps 复用 generic 的结构化错误信封；与结构错误一并聚合返回。
        let data_rate = match normalize_data_rate(params_obj.get("dataRateMbps")) {
            Ok(rate) => Some(rate),
            Err(mut rate_errors) => {
                errors.append(&mut rate_errors);
                None
            }
        };
        if !errors.is_empty() {
            return Err(errors);
        }
        // data_rate 在上面的 guard 后必为 Some（错误已聚合返回）。
        let topology = create_dual_plane_redundant_topology(
            &params,
            data_rate.expect("data_rate is Some after the error guard"),
        );
        // 防御兜底：sidecar initialize 路径不复验生成结果，参数校验之外的结构性
        // 损坏（自环 / 重复 node id / 重复端口）须在落库前被结构校验拦截。
        let report = validate_intermediate_topology(&serde_json::to_value(&topology).unwrap_or(Value::Null));
        if !report.ok {
            return Err(report.errors);
        }
        let summary = InitializeSummary {
            template_id: intent.template_id.clone(),
            node_count: topology.nodes.len(),
            link_count: topology.links.len(),
            switch_count: topology.switch_count(),
            end_system_count: topology.end_system_count(),
            server_count: topology.server_count(),
        };
        return Ok((topology, summary));
    }

    let data_rate = normalize_data_rate(params_obj.get("dataRateMbps"))?;

    let switch_count = normalize_integer_param(
        params_obj.get("switchCount"),
        SWITCH_COUNT_MIN,
        SWITCH_COUNT_MAX,
        "$.params.switchCount",
    )?;
    let end_systems_per_switch = normalize_integer_param(
        params_obj.get("endSystemsPerSwitch"),
        END_SYSTEMS_PER_SWITCH_MIN,
        END_SYSTEMS_PER_SWITCH_MAX,
        "$.params.endSystemsPerSwitch",
    )?;
    // R10：endSystemPlacement 仅 generic-line 支持 ends-only；该模式下
    // endSystemsPerSwitch 必须为 1（不做语义重载，错值早失败）。
    let ends_only = match params_obj.get("endSystemPlacement") {
        None => false,
        Some(Value::String(s)) if s == "per-switch" => false,
        Some(Value::String(s)) if s == "ends-only" => {
            if intent.template_id != "generic-line" {
                return Err(vec![TopologyErrorOut::new(
                    "INVALID_TEMPLATE_PARAM",
                    "endSystemPlacement \"ends-only\" 仅 generic-line 模板支持。",
                    "$.params.endSystemPlacement",
                )
                .requires_clarification()]);
            }
            if end_systems_per_switch != 1 {
                return Err(vec![TopologyErrorOut::new(
                    "INVALID_TEMPLATE_PARAM",
                    "ends-only 模式下 endSystemsPerSwitch 必须为 1（端系统仅挂链两端各 1 台）。",
                    "$.params.endSystemsPerSwitch",
                )
                .requires_clarification()]);
            }
            true
        }
        Some(_) => {
            return Err(vec![TopologyErrorOut::new(
                "INVALID_TEMPLATE_PARAM",
                "endSystemPlacement 取值仅支持 \"per-switch\" 或 \"ends-only\"。",
                "$.params.endSystemPlacement",
            )
            .requires_clarification()]);
        }
    };
    let topology = if ends_only {
        create_generic_line_ends_only_topology(switch_count as usize, data_rate)
    } else {
        create_generic_distributed_topology(
            &intent.template_id,
            switch_count as usize,
            end_systems_per_switch as usize,
            data_rate,
        )
    };

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
    min: i64,
    max: i64,
    path: &str,
) -> Result<i64, Vec<TopologyErrorOut>> {
    let n = match value {
        None | Some(Value::Null) => {
            return Err(vec![TopologyErrorOut::new(
                "INVALID_TEMPLATE_PARAM",
                format!("{} is required and must be an integer in [{}, {}].", path, min, max),
                path,
            )
            .with_details(json!({"minimum": min, "maximum": max, "actual": Value::Null}))
            .requires_clarification()]);
        }
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
        None | Some(Value::Null) => {
            return Err(vec![TopologyErrorOut::new(
                "INVALID_TEMPLATE_PARAM",
                format!(
                    "$.params.dataRateMbps is required and must be one of {:?}.",
                    SUPPORTED_DATA_RATES
                ),
                "$.params.dataRateMbps",
            )
            .with_details(json!({
                "allowed": SUPPORTED_DATA_RATES,
                "actual": Value::Null
            }))
            .requires_clarification()]);
        }
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

/// R10/R11：generic-line ends-only（规范图 5-1 五跳线性）。端系统仅挂链两端
/// 各 1 台；switchCount ≥ 5 时蛇形折叠（boustrophedon：行容量 ceil(N/2)、
/// 行向交替、折返处上下对齐），<5 单行直线。端口用 per-node first-free 游标
/// （ends-only 打破均匀挂载的定偏移前提）。布局常量沿用 generic 行 y=220、
/// x 步距 300、ES 外伸 220、折叠行距 200（对图校准：图 5-1 转 png）。
fn create_generic_line_ends_only_topology(
    switch_count: usize,
    data_rate: i64,
) -> IntermediateTopology {
    const ROW_Y: f64 = 220.0;
    const ROW_PITCH: f64 = 200.0;
    const X_BASE: f64 = 80.0;
    const X_PITCH: f64 = 300.0;
    const ES_GAP: f64 = 220.0;
    const FOLD_THRESHOLD: usize = 5;

    let folded = switch_count >= FOLD_THRESHOLD;
    let row_capacity = if folded { switch_count.div_ceil(2) } else { switch_count };

    // 蛇形坐标：行 0 自左向右；行 1 自右向左（首元素与行 0 末元素同 x 对齐折返）。
    let switch_position = |index: usize| -> IntermediatePosition {
        let row = index / row_capacity;
        let col = index % row_capacity;
        let x = if row % 2 == 0 {
            X_BASE + X_PITCH * col as f64
        } else {
            let row0_last_x = X_BASE + X_PITCH * (row_capacity as f64 - 1.0);
            row0_last_x - X_PITCH * col as f64
        };
        IntermediatePosition { x, y: ROW_Y + ROW_PITCH * row as f64 }
    };

    let mut nodes: Vec<IntermediateNode> = Vec::new();
    let mut links: Vec<IntermediateLink> = Vec::new();
    let mut numeric_node_id: i64 = 0;
    let mut numeric_link_id: i64 = 0;

    for switch_index in 1..=switch_count {
        nodes.push(IntermediateNode {
            id: format!("sw{}", switch_index),
            numeric_id: numeric_node_id,
            name: format!("SW-{}", switch_index),
            node_type: IntermediateNodeType::Switch,
            ports: create_ports(2),
            position: switch_position(switch_index - 1),
            mac_address: None,
            ip_address: None,
        });
        numeric_node_id += 1;
    }

    // 两端端系统：e1 挂 sw1、e2 挂 swN（N=1 时同挂 sw1）。ES 沿行向外伸。
    let first_pos = switch_position(0);
    let last_pos = switch_position(switch_count - 1);
    let last_row = (switch_count - 1) / row_capacity;
    let e1_pos = IntermediatePosition { x: first_pos.x - ES_GAP, y: first_pos.y };
    // 末行行向：偶数行向右伸，奇数行（反向行）向左伸。
    let e2_pos = if last_row % 2 == 0 {
        IntermediatePosition { x: last_pos.x + ES_GAP, y: last_pos.y }
    } else {
        IntermediatePosition { x: last_pos.x - ES_GAP, y: last_pos.y }
    };
    // es2 的 ip_octet 取 max(2) 防 switchCount=1 时与 es1（octet=1）撞出重复 IP。
    for (ordinal, (id, name, pos, ip_octet)) in [
        ("es1", "ES-1", e1_pos, 1usize),
        ("es2", "ES-2", e2_pos, switch_count.max(2)),
    ]
    .into_iter()
    .enumerate()
    {
        nodes.push(IntermediateNode {
            id: id.to_string(),
            numeric_id: numeric_node_id,
            name: name.to_string(),
            node_type: IntermediateNodeType::EndSystem,
            ports: create_ports(1),
            position: pos,
            mac_address: Some(derive_mac_address(ordinal as i64 + 1)),
            ip_address: Some(format!("10.0.{}.1", ip_octet)),
        });
        numeric_node_id += 1;
    }

    // 端口 first-free 游标（dual-plane 先例）：链路按 ES 接入 → 骨干 顺序生成。
    let mut port_cursor: HashMap<String, usize> = HashMap::new();
    let mut next_port = |node: &str| -> String {
        let counter = port_cursor.entry(node.to_string()).or_insert(0);
        let value = *counter;
        *counter += 1;
        format!("P{}", value)
    };

    let last_switch = format!("sw{}", switch_count);
    for (es_id, sw_id) in [("es1", "sw1".to_string()), ("es2", last_switch)] {
        let es_port = next_port(es_id);
        let sw_port = next_port(&sw_id);
        links.push(create_link(numeric_link_id, es_id, &es_port, &sw_id, &sw_port, data_rate));
        numeric_link_id += 1;
    }
    for index in 1..switch_count {
        let upstream = format!("sw{}", index);
        let downstream = format!("sw{}", index + 1);
        let up_port = next_port(&upstream);
        let down_port = next_port(&downstream);
        links.push(create_link(
            numeric_link_id,
            &upstream,
            &up_port,
            &downstream,
            &down_port,
            data_rate,
        ));
        numeric_link_id += 1;
    }

    IntermediateTopology {
        schema_version: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION.to_string(),
        metadata: IntermediateTopologyMetadata {
            template_id: Some("generic-line".to_string()),
            template_params: Some(json!({
                "switchCount": switch_count,
                "endSystemsPerSwitch": 1,
                "endSystemPlacement": "ends-only",
                "dataRateMbps": data_rate,
            })),
            layout: Some(if folded { "line-serpentine".into() } else { "line".into() }),
            source: Some("template".into()),
        },
        nodes,
        links,
        diagnostics: Vec::new(),
    }
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
                "P0",
                &switch_id,
                &format!("P{}", host_index - 1),
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
            &format!("P{}", switch_interconnect_port_offset),
            &switch_ids[index + 1],
            &format!("P{}", switch_interconnect_port_offset + 1),
            data_rate,
        ));
        numeric_link_id += 1;
    }

    if template_id == "generic-ring" && switch_ids.len() > 2 {
        links.push(create_link(
            numeric_link_id,
            &switch_ids[switch_ids.len() - 1],
            &format!("P{}", switch_interconnect_port_offset),
            &switch_ids[0],
            &format!("P{}", switch_interconnect_port_offset + 1),
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
        plane: None,
        role: None,
        data_rate_mbps,
    }
}

// ============================================================================
// dual-plane-redundant：参数 + 校验 + 生成（Plan 2026-06-09-004，aerospace-minimal）
// 只声明被消费字段；allocation / role / name 等 zod `.strict()` 仍接受但生成器不
// 消费的字段靠 serde 默认忽略多余键（不用 deny_unknown_fields），避免与 zod drift。
// 所有字段 #[serde(default)]：解析不失败，空/缺值由 validate 层带精确 path 报错。
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DualPlaneParams {
    #[serde(default)]
    switches: Vec<DualPlaneSwitch>,
    #[serde(default)]
    switch_groups: Vec<DualPlaneGroup>,
    #[serde(default)]
    end_systems: Vec<DualPlaneEndSystem>,
    #[serde(default)]
    backbone: Option<DualPlaneBackbone>,
    #[serde(default)]
    cross_plane_links: Option<DualPlaneCrossPlane>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DualPlaneSwitch {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    plane: String,
    #[serde(default)]
    group_id: String,
    #[serde(default)]
    port_count: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DualPlaneGroup {
    #[serde(default)]
    id: String,
    #[serde(default)]
    plane_switches: DualPlanePlaneSwitches,
}

#[derive(Debug, Default, Deserialize)]
struct DualPlanePlaneSwitches {
    #[serde(default, rename = "A")]
    a: String,
    #[serde(default, rename = "B")]
    b: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DualPlaneEndSystem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    group_id: String,
    #[serde(default)]
    attachment: DualPlaneAttachment,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DualPlaneAttachment {
    #[serde(default)]
    primary: DualPlaneAttachPoint,
    #[serde(default)]
    backup: DualPlaneAttachPoint,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DualPlaneAttachPoint {
    #[serde(default)]
    switch_id: String,
    #[serde(default)]
    plane: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DualPlaneBackbone {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    within_plane: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DualPlaneCrossPlane {
    #[serde(default)]
    mode: String,
}

fn dp_err(code: &str, message: impl Into<String>, path: &str) -> TopologyErrorOut {
    TopologyErrorOut::new(code, message, path).requires_clarification()
}

fn parse_dual_plane_params(params: &Value) -> Result<DualPlaneParams, Vec<TopologyErrorOut>> {
    serde_json::from_value::<DualPlaneParams>(params.clone()).map_err(|error| {
        vec![dp_err(
            "INVALID_TEMPLATE_PARAM",
            format!("dual-plane-redundant params are not well-formed: {}", error),
            "$.params",
        )]
    })
}

/// 交叉校验 dual-plane 参数（R3/R4）。返回空 = 通过。data_rate 由调用方复用
/// `normalize_data_rate` 单独校验。
fn validate_dual_plane_params(params: &DualPlaneParams) -> Vec<TopologyErrorOut> {
    let mut errors = Vec::new();

    match &params.backbone {
        None => errors.push(dp_err(
            "INVALID_TEMPLATE_PARAM",
            "$.params.backbone is required.",
            "$.params.backbone",
        )),
        Some(b) => {
            match b.mode.as_str() {
                "line" => {}
                "ring" => errors.push(dp_err(
                    "UNSUPPORTED_TEMPLATE_PARAM",
                    "backbone.mode=ring 暂未实现（dual-plane 当前仅支持 backbone=line）。",
                    "$.params.backbone.mode",
                )),
                other => errors.push(dp_err(
                    "INVALID_TEMPLATE_PARAM",
                    format!("$.params.backbone.mode must be \"line\" (got {:?}).", other),
                    "$.params.backbone.mode",
                )),
            }
            // 与 zod `withinPlane: z.literal(true)` 对齐：缺省或 false 都拒（不止 false）。
            if !matches!(b.within_plane, Some(true)) {
                errors.push(dp_err(
                    "INVALID_TEMPLATE_PARAM",
                    "$.params.backbone.withinPlane must be true.",
                    "$.params.backbone.withinPlane",
                ));
            }
        }
    }

    match &params.cross_plane_links {
        None => errors.push(dp_err(
            "INVALID_TEMPLATE_PARAM",
            "$.params.crossPlaneLinks is required.",
            "$.params.crossPlaneLinks",
        )),
        Some(c) => match c.mode.as_str() {
            "none" => {}
            "paired" => errors.push(dp_err(
                "UNSUPPORTED_TEMPLATE_PARAM",
                "crossPlaneLinks.mode=paired 暂未实现（dual-plane 当前仅支持 crossPlaneLinks=none）。",
                "$.params.crossPlaneLinks.mode",
            )),
            other => errors.push(dp_err(
                "INVALID_TEMPLATE_PARAM",
                format!("$.params.crossPlaneLinks.mode must be \"none\" (got {:?}).", other),
                "$.params.crossPlaneLinks.mode",
            )),
        },
    }

    if params.switches.is_empty() {
        errors.push(dp_err(
            "INVALID_TEMPLATE_PARAM",
            "$.params.switches must be a non-empty array.",
            "$.params.switches",
        ));
    }
    let mut switch_plane: HashMap<String, String> = HashMap::new();
    for (i, sw) in params.switches.iter().enumerate() {
        let path = format!("$.params.switches[{}]", i);
        if sw.id.is_empty() {
            errors.push(dp_err("INVALID_TEMPLATE_PARAM", "switch id is required.", &format!("{}.id", path)));
        }
        if sw.plane != "A" && sw.plane != "B" {
            errors.push(dp_err(
                "INVALID_TEMPLATE_PARAM",
                format!("switch plane must be \"A\" or \"B\" (got {:?}).", sw.plane),
                &format!("{}.plane", path),
            ));
        }
        if !sw.id.is_empty() {
            if switch_plane.contains_key(&sw.id) {
                errors.push(dp_err(
                    "INVALID_TEMPLATE_PARAM",
                    format!("duplicate switch id {:?}.", sw.id),
                    &format!("{}.id", path),
                ));
            } else {
                switch_plane.insert(sw.id.clone(), sw.plane.clone());
            }
        }
    }

    if params.switch_groups.is_empty() {
        errors.push(dp_err(
            "INVALID_TEMPLATE_PARAM",
            "$.params.switchGroups must be a non-empty array.",
            "$.params.switchGroups",
        ));
    }
    let mut group_ids: HashSet<String> = HashSet::new();
    let mut group_referenced_switches: HashSet<String> = HashSet::new();
    for (i, g) in params.switch_groups.iter().enumerate() {
        let path = format!("$.params.switchGroups[{}]", i);
        if g.id.is_empty() {
            errors.push(dp_err("INVALID_TEMPLATE_PARAM", "switchGroup id is required.", &format!("{}.id", path)));
        } else if !group_ids.insert(g.id.clone()) {
            errors.push(dp_err(
                "INVALID_TEMPLATE_PARAM",
                format!("duplicate switchGroup id {:?}.", g.id),
                &format!("{}.id", path),
            ));
        }
        validate_group_switch(&g.plane_switches.a, "A", &switch_plane, &mut errors, &format!("{}.planeSwitches.A", path));
        validate_group_switch(&g.plane_switches.b, "B", &switch_plane, &mut errors, &format!("{}.planeSwitches.B", path));
        // 同一 switch 不得被多个 group 引用（否则平面内骨干链会出现 sw->sw 自环）。
        for sid in [&g.plane_switches.a, &g.plane_switches.b] {
            if !sid.is_empty() && !group_referenced_switches.insert(sid.clone()) {
                errors.push(dp_err(
                    "INVALID_TEMPLATE_PARAM",
                    format!("switch {:?} is referenced by more than one switchGroup.", sid),
                    &format!("{}.planeSwitches", path),
                ));
            }
        }
    }
    for (i, sw) in params.switches.iter().enumerate() {
        if !sw.group_id.is_empty() && !group_ids.contains(&sw.group_id) {
            errors.push(dp_err(
                "INVALID_TEMPLATE_PARAM",
                format!("switch references unknown groupId {:?}.", sw.group_id),
                &format!("$.params.switches[{}].groupId", i),
            ));
        }
    }

    if params.end_systems.is_empty() {
        errors.push(dp_err(
            "INVALID_TEMPLATE_PARAM",
            "$.params.endSystems must be a non-empty array.",
            "$.params.endSystems",
        ));
    }
    let mut es_ids: HashSet<String> = HashSet::new();
    for (i, es) in params.end_systems.iter().enumerate() {
        let path = format!("$.params.endSystems[{}]", i);
        if es.id.is_empty() {
            errors.push(dp_err("INVALID_TEMPLATE_PARAM", "endSystem id is required.", &format!("{}.id", path)));
        } else {
            if !es_ids.insert(es.id.clone()) {
                errors.push(dp_err(
                    "INVALID_TEMPLATE_PARAM",
                    format!("duplicate endSystem id {:?}.", es.id),
                    &format!("{}.id", path),
                ));
            }
            if switch_plane.contains_key(&es.id) {
                errors.push(dp_err(
                    "INVALID_TEMPLATE_PARAM",
                    format!("endSystem id {:?} collides with a switch id.", es.id),
                    &format!("{}.id", path),
                ));
            }
        }
        if !es.group_id.is_empty() && !group_ids.contains(&es.group_id) {
            errors.push(dp_err(
                "INVALID_TEMPLATE_PARAM",
                format!("endSystem references unknown groupId {:?}.", es.group_id),
                &format!("{}.groupId", path),
            ));
        }
        let primary = &es.attachment.primary;
        let backup = &es.attachment.backup;
        validate_attach_switch(&primary.switch_id, &primary.plane, &switch_plane, &mut errors, &format!("{}.attachment.primary", path));
        validate_attach_switch(&backup.switch_id, &backup.plane, &switch_plane, &mut errors, &format!("{}.attachment.backup", path));
        if !primary.plane.is_empty() && primary.plane == backup.plane {
            errors.push(dp_err(
                "INVALID_TEMPLATE_PARAM",
                format!("endSystem primary/backup must be on different planes (both {:?}).", primary.plane),
                &format!("{}.attachment", path),
            ));
        }
        if !primary.switch_id.is_empty() && primary.switch_id == backup.switch_id {
            errors.push(dp_err(
                "INVALID_TEMPLATE_PARAM",
                "endSystem primary/backup must attach to different switches.",
                &format!("{}.attachment", path),
            ));
        }
    }

    // 端口容量：仅在结构无误时计算需求（避免引用错误产生噪声）。
    if errors.is_empty() {
        let demand = compute_switch_port_demand(params);
        for (i, sw) in params.switches.iter().enumerate() {
            if let Some(declared) = sw.port_count {
                let need = *demand.get(&sw.id).unwrap_or(&0) as i64;
                if declared < need {
                    errors.push(dp_err(
                        "INVALID_TEMPLATE_PARAM",
                        format!("switch {:?} portCount {} < required {}.", sw.id, declared, need),
                        &format!("$.params.switches[{}].portCount", i),
                    ));
                }
            }
        }
    }

    errors
}

fn validate_group_switch(
    switch_id: &str,
    plane: &str,
    switch_plane: &HashMap<String, String>,
    errors: &mut Vec<TopologyErrorOut>,
    path: &str,
) {
    if switch_id.is_empty() {
        errors.push(dp_err("INVALID_TEMPLATE_PARAM", format!("switchGroup must reference a plane-{} switch.", plane), path));
        return;
    }
    match switch_plane.get(switch_id) {
        None => errors.push(dp_err("INVALID_TEMPLATE_PARAM", format!("switchGroup references unknown switch {:?}.", switch_id), path)),
        Some(actual) if actual != plane => errors.push(dp_err(
            "INVALID_TEMPLATE_PARAM",
            format!("switchGroup plane-{} must reference a plane-{} switch, but {:?} is plane-{}.", plane, plane, switch_id, actual),
            path,
        )),
        Some(_) => {}
    }
}

fn validate_attach_switch(
    switch_id: &str,
    declared_plane: &str,
    switch_plane: &HashMap<String, String>,
    errors: &mut Vec<TopologyErrorOut>,
    path: &str,
) {
    if switch_id.is_empty() {
        errors.push(dp_err("INVALID_TEMPLATE_PARAM", "endSystem attachment must reference a switch.", &format!("{}.switchId", path)));
        return;
    }
    match switch_plane.get(switch_id) {
        None => errors.push(dp_err("INVALID_TEMPLATE_PARAM", format!("endSystem attachment references unknown switch {:?}.", switch_id), &format!("{}.switchId", path))),
        Some(actual) if !declared_plane.is_empty() && actual != declared_plane => errors.push(dp_err(
            "INVALID_TEMPLATE_PARAM",
            format!("attachment plane {:?} does not match switch {:?} plane {:?}.", declared_plane, switch_id, actual),
            &format!("{}.plane", path),
        )),
        Some(_) => {}
    }
}

/// 每台 switch 的端口需求 = 接入链路（作为 primary 或 backup）+ 平面内 backbone 链路。
fn compute_switch_port_demand(params: &DualPlaneParams) -> HashMap<String, usize> {
    let mut demand: HashMap<String, usize> = HashMap::new();
    for es in &params.end_systems {
        *demand.entry(es.attachment.primary.switch_id.clone()).or_default() += 1;
        *demand.entry(es.attachment.backup.switch_id.clone()).or_default() += 1;
    }
    for plane in ["A", "B"] {
        let chain = plane_switch_chain(params, plane);
        for pair in chain.windows(2) {
            *demand.entry(pair[0].clone()).or_default() += 1;
            *demand.entry(pair[1].clone()).or_default() += 1;
        }
    }
    demand
}

/// 某平面按 group 顺序的 switch 链（只保留存在的 switch）。
fn plane_switch_chain(params: &DualPlaneParams, plane: &str) -> Vec<String> {
    let known: HashSet<&str> = params.switches.iter().map(|s| s.id.as_str()).collect();
    params
        .switch_groups
        .iter()
        .map(|g| if plane == "A" { g.plane_switches.a.clone() } else { g.plane_switches.b.clone() })
        .filter(|id| known.contains(id.as_str()))
        .collect()
}

/// 确定性生成（R2/R5）。节点序 = switches（按 group、A 先 B）→ end systems（按
/// group、声明序）；链路序 = 接入（每 ES 先 primary 后 backup)→ 平面内 backbone。
/// 端口 first-free（每节点游标）。布局按组数分支：单跳三明治（SW 同行居中、ES
/// 上下两行夹住）；多组双平面行（B 上 A 下、ES 按 group 前半左/后半右挂外端，
/// y 对齐 primary 平面行，同 lane 沿外端堆叠）。全部整数算术，节点序不动。
fn create_dual_plane_redundant_topology(params: &DualPlaneParams, data_rate: i64) -> IntermediateTopology {
    let switch_by_id: HashMap<String, &DualPlaneSwitch> =
        params.switches.iter().map(|s| (s.id.clone(), s)).collect();
    let group_index: HashMap<String, usize> =
        params.switch_groups.iter().enumerate().map(|(i, g)| (g.id.clone(), i)).collect();

    // 节点序：switches 按 group 顺序、A 先 B；末尾补未被 group 引用的 switch（声明序）。
    let mut ordered_switches: Vec<&DualPlaneSwitch> = Vec::new();
    let mut seen_switch: HashSet<String> = HashSet::new();
    for g in &params.switch_groups {
        for sid in [&g.plane_switches.a, &g.plane_switches.b] {
            if let Some(sw) = switch_by_id.get(sid) {
                if seen_switch.insert(sid.clone()) {
                    ordered_switches.push(sw);
                }
            }
        }
    }
    for sw in &params.switches {
        if seen_switch.insert(sw.id.clone()) {
            ordered_switches.push(sw);
        }
    }

    // end systems 按 group 顺序、组内声明序；末尾补未知 group 的 ES。
    let mut ordered_es: Vec<&DualPlaneEndSystem> = Vec::new();
    for g in &params.switch_groups {
        for es in &params.end_systems {
            if es.group_id == g.id {
                ordered_es.push(es);
            }
        }
    }
    for es in &params.end_systems {
        if !group_index.contains_key(&es.group_id) {
            ordered_es.push(es);
        }
    }

    // 链路对（KTD3 序）：接入（primary 后 backup）→ 平面内 backbone。
    // 每条携带平面归属与角色（R6）：接入边 = 对端 SW 的平面，骨干边 = 所属平面。
    struct LinkSpec {
        src: String,
        dst: String,
        plane: Option<String>,
        role: Option<String>,
    }
    let plane_of = |switch_id: &str| -> Option<String> {
        switch_by_id.get(switch_id).map(|s| s.plane.clone())
    };
    let mut link_pairs: Vec<LinkSpec> = Vec::new();
    for es in &ordered_es {
        let primary = es.attachment.primary.switch_id.clone();
        let backup = es.attachment.backup.switch_id.clone();
        let primary_plane = plane_of(&primary);
        let backup_plane = plane_of(&backup);
        link_pairs.push(LinkSpec {
            src: es.id.clone(),
            dst: primary,
            plane: primary_plane,
            role: Some("access".into()),
        });
        link_pairs.push(LinkSpec {
            src: es.id.clone(),
            dst: backup,
            plane: backup_plane,
            role: Some("access".into()),
        });
    }
    for plane in ["A", "B"] {
        let chain = plane_switch_chain(params, plane);
        for pair in chain.windows(2) {
            link_pairs.push(LinkSpec {
                src: pair[0].clone(),
                dst: pair[1].clone(),
                plane: Some(plane.to_string()),
                role: Some("backbone".into()),
            });
        }
    }

    // 端口需求（两端各计一次）。
    let mut demand: HashMap<String, usize> = HashMap::new();
    for spec in &link_pairs {
        *demand.entry(spec.src.clone()).or_default() += 1;
        *demand.entry(spec.dst.clone()).or_default() += 1;
    }
    let port_count_for = |id: &str| -> usize { (*demand.get(id).unwrap_or(&0)).max(1) };

    // —— 布局常量（R3）：整数算术，ES 间距 ≥ 节点最大渲染宽 126px + 留白。 ——
    const ES_PITCH: f64 = 180.0;
    const GROUP_PITCH: f64 = 300.0;
    const BASE_X: f64 = 120.0;
    const SIDE_GAP: f64 = 220.0;
    // 单跳三明治行（R1）。
    const ES_TOP_Y: f64 = 60.0;
    const SW_ROW_Y: f64 = 300.0;
    const ES_BOTTOM_Y: f64 = 540.0;
    // 多组双平面行（R2）：规范图二 B 行在上、A 行在下。
    const PLANE_B_Y: f64 = 160.0;
    const PLANE_A_Y: f64 = 360.0;
    // R8：ring≥1 溢出 ES 沿列纵向延伸（背离行间走廊：A 行向下、B 行向上），
    // 间距取平面行距（200）——对角连线足够陡才不穿内列节点盒（几何间隙
    // 测试驱动：背离方向 ≥149 才可行，朝走廊方向窗口仅 [97,103] 过脆）。
    const COLUMN_EXTEND_PITCH: f64 = PLANE_A_Y - PLANE_B_Y;
    // 空/未知 group 的退化输入：独立溢出行，保确定性与坐标唯一。
    const OVERFLOW_Y: f64 = 780.0;

    let group_count = params.switch_groups.len();
    let single_hop = group_count <= 1;
    let left_group_count = (group_count + 1) / 2; // 前半挂左，奇数中位组归左。

    // 列归属以 group 的 planeSwitches 引用为准（switch 自带 groupId 可能指向
    // 未引用它的 group——按 groupId 取列会与该 group 的真实交换机重叠）。
    let mut col_by_switch: HashMap<String, usize> = HashMap::new();
    for (i, g) in params.switch_groups.iter().enumerate() {
        col_by_switch.insert(g.plane_switches.a.clone(), i);
        col_by_switch.insert(g.plane_switches.b.clone(), i);
    }
    // 未被任何 group 引用的悬挂交换机占 group 列之后的扩展列。
    let mut extra_col: HashMap<String, usize> = HashMap::new();
    for sw in &ordered_switches {
        if !col_by_switch.contains_key(&sw.id) && !extra_col.contains_key(&sw.id) {
            let next = extra_col.len();
            extra_col.insert(sw.id.clone(), next);
        }
    }
    let total_cols = group_count + extra_col.len();
    let single_hop_sw_center =
        BASE_X + (GROUP_PITCH / 2.0) * (ordered_switches.len().saturating_sub(1)) as f64;
    let right_edge_x = BASE_X + GROUP_PITCH * (total_cols.saturating_sub(1)) as f64 + SIDE_GAP;
    let left_edge_x = BASE_X - SIDE_GAP;

    // ES 按 group 预计数（单跳 ceil(n/2) 上行需要 n）。
    let mut group_es_count: HashMap<String, usize> = HashMap::new();
    for es in &ordered_es {
        *group_es_count.entry(es.group_id.clone()).or_default() += 1;
    }

    // 构建节点（只改 position 赋值；节点生成/排序顺序 = imac 身份源，不动）。
    let mut nodes: Vec<IntermediateNode> = Vec::new();
    let mut numeric_node_id: i64 = 0;
    for (sw_seq, sw) in ordered_switches.iter().enumerate() {
        let position = if single_hop {
            // 规范图一：SW 同行居中、按节点序横排。
            IntermediatePosition { x: BASE_X + GROUP_PITCH * sw_seq as f64, y: SW_ROW_Y }
        } else {
            let col = match col_by_switch.get(&sw.id) {
                Some(c) => *c,
                None => group_count + extra_col[&sw.id],
            };
            let y = if sw.plane == "B" { PLANE_B_Y } else { PLANE_A_Y };
            IntermediatePosition { x: BASE_X + GROUP_PITCH * col as f64, y }
        };
        nodes.push(IntermediateNode {
            id: sw.id.clone(),
            numeric_id: numeric_node_id,
            name: sw.name.clone().unwrap_or_else(|| sw.id.clone()),
            node_type: IntermediateNodeType::Switch,
            ports: create_ports(port_count_for(&sw.id)),
            position,
            mac_address: None,
            ip_address: None,
        });
        numeric_node_id += 1;
    }
    let mut within_group: HashMap<String, usize> = HashMap::new();
    // 多组外端槽位占用：挂侧 → 已占 (ring, 平面 B 行)。规范图 4-5：同侧 ES
    // 先纵向占满两平面行（同 x 成列），占满后沿列背离走廊延伸（ring）。
    let mut side_slots: HashMap<bool, HashSet<(usize, bool)>> = HashMap::new();
    let mut overflow_cursor: usize = 0;
    let mut es_ordinal: i64 = 1;
    for es in &ordered_es {
        let gidx = *group_index.get(&es.group_id).unwrap_or(&0);
        let wi = {
            let counter = within_group.entry(es.group_id.clone()).or_insert(0);
            let value = *counter;
            *counter += 1;
            value
        };
        let position = if !group_index.contains_key(&es.group_id) {
            let x = BASE_X + ES_PITCH * overflow_cursor as f64;
            overflow_cursor += 1;
            IntermediatePosition { x, y: OVERFLOW_Y }
        } else if single_hop {
            // 规范图一：组内声明序前 ceil(n/2) 上行、其余下行，行内对 SW 居中。
            let n = *group_es_count.get(&es.group_id).unwrap_or(&1);
            let n_up = (n + 1) / 2;
            let (row_y, idx, row_len) =
                if wi < n_up { (ES_TOP_Y, wi, n_up) } else { (ES_BOTTOM_Y, wi - n_up, n - n_up) };
            let row_start =
                single_hop_sw_center - (ES_PITCH / 2.0) * (row_len.saturating_sub(1)) as f64;
            IntermediatePosition { x: row_start + ES_PITCH * idx as f64, y: row_y }
        } else {
            // 规范图 4-5：优先对齐 primary 平面行；该行被占则让位到另一行
            // （同 x 纵向成列），两行占满后沿列背离走廊延伸。R2 的「y 对齐
            // primary 行」仅在行空闲时成立——双 ES 同主接时成列形态优先。
            let side_left = gidx < left_group_count;
            let primary_plane_b = switch_by_id
                .get(&es.attachment.primary.switch_id)
                .map(|s| s.plane == "B")
                .unwrap_or(false);
            let slots = side_slots.entry(side_left).or_default();
            let (ring, row_b) = {
                let mut r = 0usize;
                loop {
                    if !slots.contains(&(r, primary_plane_b)) {
                        break (r, primary_plane_b);
                    }
                    if !slots.contains(&(r, !primary_plane_b)) {
                        break (r, !primary_plane_b);
                    }
                    r += 1;
                }
            };
            slots.insert((ring, row_b));
            let x = if side_left { left_edge_x } else { right_edge_x };
            // ring=0 严格对齐平面行；ring>0 沿列背离走廊延伸（R8）。
            let y = if row_b {
                PLANE_B_Y - COLUMN_EXTEND_PITCH * ring as f64
            } else {
                PLANE_A_Y + COLUMN_EXTEND_PITCH * ring as f64
            };
            IntermediatePosition { x, y }
        };
        nodes.push(IntermediateNode {
            id: es.id.clone(),
            numeric_id: numeric_node_id,
            name: es.name.clone().unwrap_or_else(|| es.id.clone()),
            node_type: IntermediateNodeType::EndSystem,
            ports: create_ports(port_count_for(&es.id)),
            position,
            mac_address: Some(derive_mac_address(es_ordinal)),
            ip_address: Some(format!("10.0.{}.{}", gidx + 1, wi + 1)),
        });
        numeric_node_id += 1;
        es_ordinal += 1;
    }

    // 构建链路：first-free 端口游标（每节点）。
    let mut cursor: HashMap<String, usize> = HashMap::new();
    let mut next_port = |node: &str| -> String {
        let counter = cursor.entry(node.to_string()).or_insert(0);
        let value = *counter;
        *counter += 1;
        format!("P{}", value)
    };
    let mut links: Vec<IntermediateLink> = Vec::new();
    for (numeric_link_id, spec) in link_pairs.iter().enumerate() {
        let src_port = next_port(&spec.src);
        let dst_port = next_port(&spec.dst);
        let mut link = create_link(
            numeric_link_id as i64,
            &spec.src,
            &src_port,
            &spec.dst,
            &dst_port,
            data_rate,
        );
        link.plane = spec.plane.clone();
        link.role = spec.role.clone();
        links.push(link);
    }

    IntermediateTopology {
        schema_version: INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION.to_string(),
        metadata: IntermediateTopologyMetadata {
            template_id: Some("dual-plane-redundant".into()),
            template_params: Some(json!({
                "switchCount": ordered_switches.len(),
                "endSystemCount": ordered_es.len(),
                "groupCount": params.switch_groups.len(),
                "dataRateMbps": data_rate,
            })),
            layout: Some("dual-plane".into()),
            source: Some("template".into()),
        },
        nodes,
        links,
        diagnostics: Vec::new(),
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
            params: json!({ "switchCount": 2, "endSystemsPerSwitch": 1, "dataRateMbps": 1000 }),
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

    fn ends_only_intent(switch_count: i64, es_per_switch: i64) -> InitializeIntent {
        InitializeIntent {
            template_id: "generic-line".into(),
            params: json!({
                "switchCount": switch_count,
                "endSystemsPerSwitch": es_per_switch,
                "dataRateMbps": 1000,
                "endSystemPlacement": "ends-only",
            }),
        }
    }

    #[test]
    fn ends_only_five_hop_matches_spec_figure_5_1() {
        // AE3：7 节点（5 SW + 2 ES）6 链路、ES 仅两端、两行蛇形坐标快照。
        let (topo, summary) = initialize_topology(&ends_only_intent(5, 1)).unwrap();
        assert_eq!(summary.node_count, 7);
        assert_eq!(summary.link_count, 6);
        assert_eq!(summary.switch_count, 5);
        assert_eq!(summary.end_system_count, 2);

        let pos = |id: &str| {
            let node = topo.nodes.iter().find(|n| n.id == id).expect("node");
            (node.position.x, node.position.y)
        };
        // 行 1 自左向右；行 2 蛇形反向（sw4 与 sw3 同 x 折返）；ES 沿行外伸。
        assert_eq!(pos("sw1"), (80.0, 220.0));
        assert_eq!(pos("sw2"), (380.0, 220.0));
        assert_eq!(pos("sw3"), (680.0, 220.0));
        assert_eq!(pos("sw4"), (680.0, 420.0));
        assert_eq!(pos("sw5"), (380.0, 420.0));
        assert_eq!(pos("es1"), (-140.0, 220.0));
        assert_eq!(pos("es2"), (160.0, 420.0));

        // 链路结构：e1—sw1、e2—sw5、sw1..sw5 级联（无环）。
        let connects = |a: &str, b: &str| {
            topo.links.iter().any(|l| {
                (l.source.node_id == a && l.target.node_id == b)
                    || (l.source.node_id == b && l.target.node_id == a)
            })
        };
        assert!(connects("es1", "sw1"));
        assert!(connects("es2", "sw5"));
        for i in 1..5 {
            assert!(connects(&format!("sw{}", i), &format!("sw{}", i + 1)));
        }
        assert!(!connects("sw5", "sw1"), "线性不闭环");

        // 防穿框：每条链路中心连线不得穿过任何非端点节点盒（126×56，margin 8）。
        for link in &topo.links {
            let from = pos(&link.source.node_id);
            let to = pos(&link.target.node_id);
            for node in &topo.nodes {
                if node.id == link.source.node_id || node.id == link.target.node_id {
                    continue;
                }
                let center = (node.position.x, node.position.y);
                assert!(
                    !seg_intersects_rect(from, to, center, 63.0, 28.0, 8.0),
                    "link {}-{} crosses node {}",
                    link.source.node_id,
                    link.target.node_id,
                    node.id
                );
            }
        }

        // 确定性 + 无坐标重叠。
        let (topo2, _) = initialize_topology(&ends_only_intent(5, 1)).unwrap();
        let coords: Vec<_> = topo.nodes.iter().map(|n| (n.position.x, n.position.y)).collect();
        let coords2: Vec<_> = topo2.nodes.iter().map(|n| (n.position.x, n.position.y)).collect();
        assert_eq!(coords, coords2, "同参两次坐标全等");
        for (i, a) in coords.iter().enumerate() {
            for b in coords.iter().skip(i + 1) {
                assert_ne!(a, b, "任意两节点不得同坐标");
            }
        }

        // 落库前结构校验兜底。
        let report =
            validate_intermediate_topology(&serde_json::to_value(&topo).unwrap_or(Value::Null));
        assert!(report.ok, "validate_intermediate must pass: {:?}", report.errors);
    }

    #[test]
    fn ends_only_below_fold_threshold_stays_single_row() {
        let (topo, summary) = initialize_topology(&ends_only_intent(3, 1)).unwrap();
        assert_eq!(summary.node_count, 5);
        assert_eq!(summary.link_count, 4);
        let ys: std::collections::BTreeSet<i64> =
            topo.nodes.iter().map(|n| n.position.y as i64).collect();
        assert_eq!(ys.len(), 1, "未达折叠阈值保持单行");
        let e2 = topo.nodes.iter().find(|n| n.id == "es2").unwrap();
        let sw3 = topo.nodes.iter().find(|n| n.id == "sw3").unwrap();
        assert!(e2.position.x > sw3.position.x, "单行时 es2 向右外伸");
    }

    #[test]
    fn ends_only_even_and_max_fold_hold_invariants() {
        // 偶数折叠（6 → 3+3）与上限 12（6+6）的反向行算式、防穿框、唯一性、
        // 校验兜底（坐标快照只钉规范图 5-1 的 N=5，其余只验不变量）。
        for switch_count in [1i64, 2, 6, 12] {
            let (topo, summary) = initialize_topology(&ends_only_intent(switch_count, 1)).unwrap();
            assert_eq!(summary.node_count, switch_count as usize + 2);
            assert_eq!(summary.link_count, switch_count as usize + 1);

            let pos = |id: &str| {
                let node = topo.nodes.iter().find(|n| n.id == id).expect("node");
                (node.position.x, node.position.y)
            };
            for link in &topo.links {
                let from = pos(&link.source.node_id);
                let to = pos(&link.target.node_id);
                for node in &topo.nodes {
                    if node.id == link.source.node_id || node.id == link.target.node_id {
                        continue;
                    }
                    assert!(
                        !seg_intersects_rect(
                            from,
                            to,
                            (node.position.x, node.position.y),
                            63.0,
                            28.0,
                            8.0
                        ),
                        "N={switch_count}: link {}-{} crosses {}",
                        link.source.node_id,
                        link.target.node_id,
                        node.id
                    );
                }
            }

            let coords: Vec<_> = topo.nodes.iter().map(|n| (n.position.x, n.position.y)).collect();
            for (i, a) in coords.iter().enumerate() {
                for b in coords.iter().skip(i + 1) {
                    assert_ne!(a, b, "N={switch_count}: 任意两节点不得同坐标");
                }
            }

            // IP 唯一性（N=1 时 es1/es2 同挂 sw1，octet 必须仍不同）。
            let ips: Vec<_> = topo.nodes.iter().filter_map(|n| n.ip_address.clone()).collect();
            let unique: std::collections::BTreeSet<_> = ips.iter().collect();
            assert_eq!(ips.len(), unique.len(), "N={switch_count}: IP 不得重复");

            let report =
                validate_intermediate_topology(&serde_json::to_value(&topo).unwrap_or(Value::Null));
            assert!(report.ok, "N={switch_count}: {:?}", report.errors);
        }
    }

    #[test]
    fn ends_only_rejects_invalid_parameter_combinations() {
        // endSystemsPerSwitch 必须为 1（不做语义重载）。
        let errors = initialize_topology(&ends_only_intent(5, 2)).unwrap_err();
        assert!(errors.iter().any(|e| e.path == "$.params.endSystemsPerSwitch"));

        // ends-only 仅 generic-line 支持。
        let mut ring = ends_only_intent(5, 1);
        ring.template_id = "generic-ring".into();
        let errors = initialize_topology(&ring).unwrap_err();
        assert!(errors.iter().any(|e| e.path == "$.params.endSystemPlacement"));

        // 非法枚举值。
        let intent = InitializeIntent {
            template_id: "generic-line".into(),
            params: json!({
                "switchCount": 5, "endSystemsPerSwitch": 1, "dataRateMbps": 1000,
                "endSystemPlacement": "middle",
            }),
        };
        let errors = initialize_topology(&intent).unwrap_err();
        assert!(errors.iter().any(|e| e.path == "$.params.endSystemPlacement"));

        // 显式 per-switch 与缺省等价（向后兼容，ring 也接受）。
        let mut ring_default = ends_only_intent(4, 2);
        ring_default.template_id = "generic-ring".into();
        ring_default.params["endSystemPlacement"] = json!("per-switch");
        assert!(initialize_topology(&ring_default).is_ok());
    }

    #[test]
    fn describe_templates_scenario_filter_matches_r7_matrix() {
        // R7：每个 descriptor 都有非空 scenarios；过滤按归属矩阵收窄候选集。
        let full = describe_templates_catalog_filtered(None);
        for descriptor in full["templates"].as_array().unwrap() {
            let scenarios = descriptor["scenarios"].as_array().unwrap();
            assert!(!scenarios.is_empty(), "{} 必须声明场景归属", descriptor["id"]);
        }

        let aero = describe_templates_catalog_filtered(Some("aerospace-onboard"));
        assert_eq!(aero["templateCount"], 3, "宇航场景含全部三模板（ring 双场景归属）");
        // 匹配场景与全量均不得携带 warning（否则 agent 每次过滤都收到误导警告）。
        assert!(aero.get("warning").is_none());
        assert!(full.get("warning").is_none());
        assert!(full.get("scenario").is_none());

        let generic = describe_templates_catalog_filtered(Some("generic-tsn"));
        assert_eq!(generic["templateCount"], 2);
        let ids = generic["templateIds"].as_array().unwrap();
        assert!(!ids.iter().any(|v| v == "dual-plane-redundant"));

        let unknown = describe_templates_catalog_filtered(Some("industrial"));
        assert_eq!(unknown["templateCount"], 0);
        assert!(unknown["warning"].as_str().unwrap().contains("industrial"));
        // 未知场景回显 scenario，空结果是空数组而非 null。
        assert_eq!(unknown["scenario"], json!("industrial"));
        assert!(unknown["templates"].as_array().unwrap().is_empty());
        assert!(unknown["templateIds"].as_array().unwrap().is_empty());
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
            params: json!({ "switchCount": 4, "endSystemsPerSwitch": 1, "dataRateMbps": 1000 }),
        })
        .unwrap();
        // 4 host-switch + 3 interconnect (line) + 1 closing = 8
        assert_eq!(topology.links.len(), 8);
    }

    fn dual_plane_single_hop_params() -> serde_json::Value {
        let end_systems: Vec<serde_json::Value> = (1..=6)
            .map(|i| {
                json!({
                    "id": format!("es{}", i),
                    "groupId": "g1",
                    "attachment": {
                        "primary": {"switchId": "sw1", "plane": "A"},
                        "backup": {"switchId": "sw2", "plane": "B"}
                    }
                })
            })
            .collect();
        json!({
            "dataRateMbps": 1000,
            "planes": [{"id": "A"}, {"id": "B"}],
            "switches": [
                {"id": "sw1", "plane": "A", "groupId": "g1"},
                {"id": "sw2", "plane": "B", "groupId": "g1"}
            ],
            "switchGroups": [{"id": "g1", "planeSwitches": {"A": "sw1", "B": "sw2"}}],
            "endSystems": end_systems,
            "backbone": {"mode": "line", "withinPlane": true},
            "crossPlaneLinks": {"mode": "none"}
        })
    }

    fn dual_plane_two_hop_params() -> serde_json::Value {
        json!({
            "dataRateMbps": 1000,
            "planes": [{"id": "A"}, {"id": "B"}],
            "switches": [
                {"id": "sw1", "plane": "A", "groupId": "g1"},
                {"id": "sw2", "plane": "B", "groupId": "g1"},
                {"id": "sw3", "plane": "A", "groupId": "g2"},
                {"id": "sw4", "plane": "B", "groupId": "g2"}
            ],
            "switchGroups": [
                {"id": "g1", "planeSwitches": {"A": "sw1", "B": "sw2"}},
                {"id": "g2", "planeSwitches": {"A": "sw3", "B": "sw4"}}
            ],
            "endSystems": [
                {"id": "e1", "groupId": "g1", "attachment": {"primary": {"switchId": "sw1", "plane": "A"}, "backup": {"switchId": "sw2", "plane": "B"}}},
                {"id": "e2", "groupId": "g1", "attachment": {"primary": {"switchId": "sw1", "plane": "A"}, "backup": {"switchId": "sw2", "plane": "B"}}},
                {"id": "e3", "groupId": "g2", "attachment": {"primary": {"switchId": "sw3", "plane": "A"}, "backup": {"switchId": "sw4", "plane": "B"}}},
                {"id": "e4", "groupId": "g2", "attachment": {"primary": {"switchId": "sw3", "plane": "A"}, "backup": {"switchId": "sw4", "plane": "B"}}}
            ],
            "backbone": {"mode": "line", "withinPlane": true},
            "crossPlaneLinks": {"mode": "none"}
        })
    }

    fn dp_link_connects(topo: &IntermediateTopology, a: &str, b: &str) -> bool {
        topo.links.iter().any(|l| {
            (l.source.node_id == a && l.target.node_id == b)
                || (l.source.node_id == b && l.target.node_id == a)
        })
    }

    #[test]
    fn initialize_dual_plane_single_hop_generates_dual_homed_topology() {
        // AE1：1 group、6 ES 双归属、line/none → 8 节点 + 12 接入链路、无 backbone。
        let (topo, summary) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: dual_plane_single_hop_params(),
        })
        .unwrap();
        assert_eq!(topo.switch_count(), 2);
        assert_eq!(topo.end_system_count(), 6);
        assert_eq!(topo.nodes.len(), 8);
        assert_eq!(topo.links.len(), 12);
        assert_eq!(summary.node_count, 8);
        for i in 1..=6 {
            let es = format!("es{}", i);
            assert!(dp_link_connects(&topo, &es, "sw1"), "{} not homed to sw1", es);
            assert!(dp_link_connects(&topo, &es, "sw2"), "{} not homed to sw2", es);
        }
    }

    #[test]
    fn initialize_dual_plane_two_hop_generates_within_plane_backbone() {
        // AE2：2 group、line within-plane → A: sw1-sw3、B: sw2-sw4 骨干 + 跨 group 路径。
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: dual_plane_two_hop_params(),
        })
        .unwrap();
        assert_eq!(topo.switch_count(), 4);
        assert_eq!(topo.end_system_count(), 4);
        assert!(dp_link_connects(&topo, "sw1", "sw3"), "plane A backbone sw1-sw3 missing");
        assert!(dp_link_connects(&topo, "sw2", "sw4"), "plane B backbone sw2-sw4 missing");
        // 跨 group 路径：e1 在 g1(sw1)、e3 在 g2(sw3)、sw1-sw3 骨干已在 → 平面 A 连通。
        assert!(dp_link_connects(&topo, "e1", "sw1"));
        assert!(dp_link_connects(&topo, "e3", "sw3"));
        // crossPlaneLinks=none：A/B 平面不直连。
        assert!(!dp_link_connects(&topo, "sw1", "sw2"), "unexpected cross-plane link");
    }

    #[test]
    fn dual_plane_links_carry_plane_and_role() {
        // R6：接入边 plane = 对端 SW 平面、role=access；骨干边 = 所属平面、role=backbone；
        // generic 模板链路两字段为 None。
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: dual_plane_two_hop_params(),
        })
        .unwrap();
        let link_to = |a: &str, b: &str| {
            topo.links
                .iter()
                .find(|l| l.source.node_id == a && l.target.node_id == b)
                .unwrap_or_else(|| panic!("link {}->{} missing", a, b))
        };
        let e1_primary = link_to("e1", "sw1");
        assert_eq!(e1_primary.plane.as_deref(), Some("A"));
        assert_eq!(e1_primary.role.as_deref(), Some("access"));
        let e1_backup = link_to("e1", "sw2");
        assert_eq!(e1_backup.plane.as_deref(), Some("B"));
        assert_eq!(e1_backup.role.as_deref(), Some("access"));
        let backbone_a = link_to("sw1", "sw3");
        assert_eq!(backbone_a.plane.as_deref(), Some("A"));
        assert_eq!(backbone_a.role.as_deref(), Some("backbone"));

        let line = build_minimal_generic_line();
        assert!(line.links.iter().all(|l| l.plane.is_none() && l.role.is_none()));
    }

    #[test]
    fn intermediate_link_without_plane_fields_deserializes() {
        // additive 回归：旧 JSON（无 plane/role 键）反序列化为 None，序列化不回写键。
        let raw = json!({
            "id": "link-0", "numericId": 0,
            "source": { "nodeId": "a", "portId": "p1" },
            "target": { "nodeId": "b", "portId": "p1" },
            "medium": "ethernet", "dataRateMbps": 1000
        });
        let link: IntermediateLink = serde_json::from_value(raw).unwrap();
        assert!(link.plane.is_none() && link.role.is_none());
        let back = serde_json::to_value(&link).unwrap();
        assert!(back.get("plane").is_none() && back.get("role").is_none());
    }

    fn dp_pos(topo: &IntermediateTopology, id: &str) -> (f64, f64) {
        let n = topo.nodes.iter().find(|n| n.id == id).unwrap_or_else(|| panic!("{} missing", id));
        (n.position.x, n.position.y)
    }

    #[test]
    fn dual_plane_single_hop_layout_is_sandwich() {
        // AE1（R1/R3）：SW 同行居中，ES 前半上行/后半下行夹住，行内间距 ≥ 180。
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: dual_plane_single_hop_params(),
        })
        .unwrap();
        let (sw1x, sw1y) = dp_pos(&topo, "sw1");
        let (sw2x, sw2y) = dp_pos(&topo, "sw2");
        assert_eq!(sw1y, sw2y, "single-hop switches share one row");
        assert!((sw1x - sw2x).abs() >= 180.0);
        let top_y = dp_pos(&topo, "es1").1;
        let bottom_y = dp_pos(&topo, "es4").1;
        for i in 1..=3 {
            assert_eq!(dp_pos(&topo, &format!("es{}", i)).1, top_y, "es{} not on top row", i);
        }
        for i in 4..=6 {
            assert_eq!(dp_pos(&topo, &format!("es{}", i)).1, bottom_y, "es{} not on bottom row", i);
        }
        assert!(top_y < sw1y && sw1y < bottom_y, "ES rows must sandwich the SW row");
        // 行内相邻间距 ≥ ES_PITCH（R3 反重叠）。
        assert!((dp_pos(&topo, "es1").0 - dp_pos(&topo, "es2").0).abs() >= 180.0);
        assert!((dp_pos(&topo, "es4").0 - dp_pos(&topo, "es5").0).abs() >= 180.0);
        // ES 行对 SW 行居中（R1）：上行均值 x = SW 均值 x。
        let sw_mean = (sw1x + sw2x) / 2.0;
        let top_mean = (1..=3).map(|i| dp_pos(&topo, &format!("es{}", i)).0).sum::<f64>() / 3.0;
        assert!((top_mean - sw_mean).abs() <= 1.0, "top row not centered: {} vs {}", top_mean, sw_mean);
    }

    #[test]
    fn dual_plane_two_hop_layout_matches_spec_projection() {
        // AE2（R2/R3）：平面行上下排布、同组 SW 垂直成对、ES 按 group 左右外端、
        // y 对齐 primary 平面行、同 lane 沿外端堆叠不重叠。
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: dual_plane_two_hop_params(),
        })
        .unwrap();
        let (sw1x, sw1y) = dp_pos(&topo, "sw1");
        let (sw2x, sw2y) = dp_pos(&topo, "sw2");
        let (sw3x, sw3y) = dp_pos(&topo, "sw3");
        let (sw4x, sw4y) = dp_pos(&topo, "sw4");
        assert_eq!(sw1y, sw3y, "plane A row");
        assert_eq!(sw2y, sw4y, "plane B row");
        assert!(sw2y < sw1y, "spec figure: plane B row above plane A row");
        assert_eq!(sw1x, sw2x, "group g1 switches stack vertically");
        assert_eq!(sw3x, sw4x, "group g2 switches stack vertically");
        assert!(sw1x < sw3x, "groups spread along x by declaration order");
        // 规范图 4-5：首台对齐 primary 平面行；同主接的第二台让位到另一平面行。
        for id in ["e1", "e3"] {
            assert_eq!(dp_pos(&topo, id).1, sw1y, "{} must align to primary plane row", id);
        }
        for id in ["e2", "e4"] {
            assert_eq!(dp_pos(&topo, id).1, sw2y, "{} must take the free plane-B row", id);
        }
        // g1 在左外端、g2 在右外端。
        assert!(dp_pos(&topo, "e1").0 < sw1x && dp_pos(&topo, "e2").0 < sw1x);
        assert!(dp_pos(&topo, "e3").0 > sw3x && dp_pos(&topo, "e4").0 > sw3x);
        // 规范图 4-5：组内两台 ES 纵向成列（同 x）。
        assert_eq!(dp_pos(&topo, "e1").0, dp_pos(&topo, "e2").0, "left ES column");
        assert_eq!(dp_pos(&topo, "e3").0, dp_pos(&topo, "e4").0, "right ES column");
    }

    fn dual_plane_three_group_params() -> serde_json::Value {
        json!({
            "dataRateMbps": 1000,
            "planes": [{"id": "A"}, {"id": "B"}],
            "switches": [
                {"id": "sw1", "plane": "A", "groupId": "g1"},
                {"id": "sw2", "plane": "B", "groupId": "g1"},
                {"id": "sw3", "plane": "A", "groupId": "g2"},
                {"id": "sw4", "plane": "B", "groupId": "g2"},
                {"id": "sw5", "plane": "A", "groupId": "g3"},
                {"id": "sw6", "plane": "B", "groupId": "g3"}
            ],
            "switchGroups": [
                {"id": "g1", "planeSwitches": {"A": "sw1", "B": "sw2"}},
                {"id": "g2", "planeSwitches": {"A": "sw3", "B": "sw4"}},
                {"id": "g3", "planeSwitches": {"A": "sw5", "B": "sw6"}}
            ],
            "endSystems": [
                {"id": "e1", "groupId": "g1", "attachment": {"primary": {"switchId": "sw1", "plane": "A"}, "backup": {"switchId": "sw2", "plane": "B"}}},
                {"id": "e2", "groupId": "g2", "attachment": {"primary": {"switchId": "sw4", "plane": "B"}, "backup": {"switchId": "sw3", "plane": "A"}}},
                {"id": "e3", "groupId": "g3", "attachment": {"primary": {"switchId": "sw5", "plane": "A"}, "backup": {"switchId": "sw6", "plane": "B"}}}
            ],
            "backbone": {"mode": "line", "withinPlane": true},
            "crossPlaneLinks": {"mode": "none"}
        })
    }

    /// 线段与（含 margin 膨胀的）AABB 相交检测——slab 法。
    fn seg_intersects_rect(
        p: (f64, f64),
        q: (f64, f64),
        center: (f64, f64),
        half_w: f64,
        half_h: f64,
        margin: f64,
    ) -> bool {
        let (min_x, max_x) = (center.0 - half_w - margin, center.0 + half_w + margin);
        let (min_y, max_y) = (center.1 - half_h - margin, center.1 + half_h + margin);
        let d = (q.0 - p.0, q.1 - p.1);
        let mut t_min: f64 = 0.0;
        let mut t_max: f64 = 1.0;
        for (start, delta, lo, hi) in
            [(p.0, d.0, min_x, max_x), (p.1, d.1, min_y, max_y)]
        {
            if delta.abs() < f64::EPSILON {
                if start < lo || start > hi {
                    return false;
                }
            } else {
                let mut t1 = (lo - start) / delta;
                let mut t2 = (hi - start) / delta;
                if t1 > t2 {
                    std::mem::swap(&mut t1, &mut t2);
                }
                t_min = t_min.max(t1);
                t_max = t_max.min(t2);
                if t_min > t_max {
                    return false;
                }
            }
        }
        true
    }

    #[test]
    fn seg_intersects_rect_detects_known_cases() {
        // 几何断言依赖该 helper 正确性：正反例独立验证（不靠布局集成测试间接覆盖）。
        let center = (100.0, 100.0);
        // 穿过矩形中心的对角线段 → true
        assert!(seg_intersects_rect((0.0, 0.0), (200.0, 200.0), center, 50.0, 25.0, 0.0));
        // 完全在矩形上方掠过的水平线段 → false
        assert!(!seg_intersects_rect((0.0, 10.0), (200.0, 10.0), center, 50.0, 25.0, 0.0));
        // 水平线段（delta_y≈0）y 在 slab 内且 x 覆盖矩形 → true
        assert!(seg_intersects_rect((0.0, 100.0), (200.0, 100.0), center, 50.0, 25.0, 0.0));
        // 垂直线段 x 在矩形外 → false；margin 膨胀后进入 → true
        assert!(!seg_intersects_rect((160.0, 0.0), (160.0, 200.0), center, 50.0, 25.0, 0.0));
        assert!(seg_intersects_rect((160.0, 0.0), (160.0, 200.0), center, 50.0, 25.0, 12.0));
        // 端点恰落在矩形边缘（切边）→ true（t_min <= t_max 边界）
        assert!(seg_intersects_rect((150.0, 100.0), (300.0, 100.0), center, 50.0, 25.0, 0.0));
    }

    #[test]
    fn dual_plane_stacked_lane_edges_clear_inner_nodes() {
        // R8/AE3：成列双 ES 的交叉连线（规范图 4-5 X 形）不得穿过同列另一台
        // ES 的节点盒（126×56，margin 8）。
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: dual_plane_two_hop_params(),
        })
        .unwrap();
        // e1 = A 行、e2 = 让位 B 行（同列）；两者 primary→sw1、backup→sw2。
        let inner = dp_pos(&topo, "e1");
        let outer = dp_pos(&topo, "e2");
        let sw1 = dp_pos(&topo, "sw1");
        let sw2 = dp_pos(&topo, "sw2");
        for (label, target) in [("primary", sw1), ("backup", sw2)] {
            assert!(
                !seg_intersects_rect(outer, target, inner, 63.0, 28.0, 8.0),
                "outer ES {} edge ({:?}->{:?}) crosses inner ES box at {:?}",
                label,
                outer,
                target,
                inner
            );
        }
    }

    #[test]
    fn dual_plane_third_es_overflow_ring_clears_column_nodes() {
        // 两平面行占满后第三台 ES 沿列背离走廊延伸（ring1，同 x）；
        // 其 primary/backup 连线不得穿过列内两台 ES 的节点盒。
        let mut params = dual_plane_two_hop_params();
        let mut es = params["endSystems"].as_array().unwrap().clone();
        es.push(json!({
            "id": "e5", "groupId": "g1",
            "attachment": {"primary": {"switchId": "sw1", "plane": "A"}, "backup": {"switchId": "sw2", "plane": "B"}}
        }));
        params["endSystems"] = json!(es);
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params,
        })
        .unwrap();
        let e1 = dp_pos(&topo, "e1");
        let e2 = dp_pos(&topo, "e2");
        let e5 = dp_pos(&topo, "e5");
        assert_eq!(e5.0, e1.0, "ring1 stays in the column (same x)");
        assert!(e5.1 > e1.1, "ring1 A-row ES extends away from the corridor (below A row)");
        for (label, target) in [("primary", dp_pos(&topo, "sw1")), ("backup", dp_pos(&topo, "sw2"))] {
            for (inner_label, inner) in [("e1", e1), ("e2", e2)] {
                assert!(
                    !seg_intersects_rect(e5, target, inner, 63.0, 28.0, 8.0),
                    "ring1 ES {} edge ({:?}->{:?}) crosses {} box at {:?}",
                    label, e5, target, inner_label, inner
                );
            }
        }
    }

    #[test]
    fn dual_plane_three_group_sides_split_front_half_left() {
        // R2：3 组 → 前 2 组（含中位）挂左、第 3 组挂右，确定性。
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: dual_plane_three_group_params(),
        })
        .unwrap();
        let min_sw_x = ["sw1", "sw3", "sw5"].iter().map(|id| dp_pos(&topo, id).0).fold(f64::MAX, f64::min);
        let max_sw_x = ["sw1", "sw3", "sw5"].iter().map(|id| dp_pos(&topo, id).0).fold(f64::MIN, f64::max);
        assert!(dp_pos(&topo, "e1").0 < min_sw_x, "g1 ES on left edge");
        assert!(dp_pos(&topo, "e2").0 < min_sw_x, "g2 (middle group) ES on left edge");
        assert!(dp_pos(&topo, "e3").0 > max_sw_x, "g3 ES on right edge");
        // e2 primary 在 B 平面 → y 对齐 B 行。
        assert_eq!(dp_pos(&topo, "e2").1, dp_pos(&topo, "sw4").1);
    }

    #[test]
    fn dual_plane_single_hop_odd_es_uses_ceil_split() {
        // R1：奇数 ES 前 ceil(n/2) 上行；n=1 仅上行。
        let mut params = dual_plane_single_hop_params();
        let es = params["endSystems"].as_array().unwrap()[..5].to_vec();
        params["endSystems"] = json!(es);
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params,
        })
        .unwrap();
        let sw_y = dp_pos(&topo, "sw1").1;
        let above = (1..=5).filter(|i| dp_pos(&topo, &format!("es{}", i)).1 < sw_y).count();
        let below = (1..=5).filter(|i| dp_pos(&topo, &format!("es{}", i)).1 > sw_y).count();
        assert_eq!((above, below), (3, 2), "5 ES split as ceil: 3 top / 2 bottom");

        let mut single = dual_plane_single_hop_params();
        let one = single["endSystems"].as_array().unwrap()[..1].to_vec();
        single["endSystems"] = json!(one);
        let (topo_one, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: single,
        })
        .unwrap();
        assert!(dp_pos(&topo_one, "es1").1 < dp_pos(&topo_one, "sw1").1, "n=1 stays on top row");
    }

    #[test]
    fn dual_plane_rejects_same_plane_or_same_switch_attachment() {
        // AE3。
        let mut params = dual_plane_single_hop_params();
        params["endSystems"][0]["attachment"]["backup"] = json!({"switchId": "sw1", "plane": "A"});
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params,
        })
        .unwrap_err();
        assert!(err.iter().any(|e| e.path.contains("attachment")));
    }

    #[test]
    fn dual_plane_rejects_ring_backbone() {
        // AE4。
        let mut params = dual_plane_two_hop_params();
        params["backbone"]["mode"] = json!("ring");
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params,
        })
        .unwrap_err();
        assert!(err
            .iter()
            .any(|e| e.code == "UNSUPPORTED_TEMPLATE_PARAM" && e.path.contains("backbone.mode")));
    }

    #[test]
    fn dual_plane_rejects_paired_cross_plane() {
        // AE4。
        let mut params = dual_plane_two_hop_params();
        params["crossPlaneLinks"]["mode"] = json!("paired");
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params,
        })
        .unwrap_err();
        assert!(err
            .iter()
            .any(|e| e.code == "UNSUPPORTED_TEMPLATE_PARAM" && e.path.contains("crossPlaneLinks")));
    }

    #[test]
    fn dual_plane_rejects_unknown_switch_and_single_plane_group_and_missing_backbone() {
        // AE5。
        let mut unknown = dual_plane_single_hop_params();
        unknown["endSystems"][0]["attachment"]["primary"]["switchId"] = json!("nope");
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: unknown,
        })
        .unwrap_err();
        assert!(err.iter().any(|e| e.path.contains("primary") && e.message.contains("unknown")));

        let mut single_plane = dual_plane_single_hop_params();
        single_plane["switchGroups"][0]["planeSwitches"]["B"] = json!("sw1");
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: single_plane,
        })
        .unwrap_err();
        assert!(err.iter().any(|e| e.path.contains("planeSwitches.B")));

        let mut no_backbone = dual_plane_single_hop_params();
        no_backbone.as_object_mut().unwrap().remove("backbone");
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: no_backbone,
        })
        .unwrap_err();
        assert!(err.iter().any(|e| e.path == "$.params.backbone"));
    }

    #[test]
    fn dual_plane_rejects_insufficient_port_count() {
        let mut params = dual_plane_single_hop_params();
        params["switches"][0]["portCount"] = json!(1); // sw1 需要 6 个接入端口。
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params,
        })
        .unwrap_err();
        assert!(err.iter().any(|e| e.path.contains("portCount")));
    }

    #[test]
    fn dual_plane_rejects_id_collisions_and_switch_reuse() {
        // 代码审查 P1：唯一性/复用缺口——这些输入过去能通过校验、静默生成损坏拓扑。
        let dup_switch = {
            let mut p = dual_plane_two_hop_params();
            p["switches"][2]["id"] = json!("sw1"); // 与 sw1 重复
            p
        };
        let dup_es = {
            let mut p = dual_plane_single_hop_params();
            p["endSystems"][1]["id"] = json!("es1"); // 与 es1 重复
            p
        };
        let es_switch_collision = {
            let mut p = dual_plane_single_hop_params();
            p["endSystems"][0]["id"] = json!("sw1"); // ES id 撞 switch id
            p
        };
        let dup_group = {
            let mut p = dual_plane_two_hop_params();
            p["switchGroups"][1]["id"] = json!("g1"); // 重复 group id
            p
        };
        let switch_reuse = {
            // 两个 group 引用同一 A 平面 switch → 过去会生成 sw1->sw1 自环 backbone。
            let mut p = dual_plane_two_hop_params();
            p["switchGroups"][1]["planeSwitches"]["A"] = json!("sw1");
            p
        };
        for params in [dup_switch, dup_es, es_switch_collision, dup_group, switch_reuse] {
            let result = initialize_topology(&InitializeIntent {
                template_id: "dual-plane-redundant".into(),
                params,
            });
            assert!(result.is_err(), "structurally-invalid dual-plane input must be rejected");
        }
    }

    #[test]
    fn dual_plane_rejects_absent_within_plane_and_unknown_mode_and_missing_data_rate() {
        // withinPlane 缺省（对齐 zod literal(true)）。
        let mut absent_wp = dual_plane_single_hop_params();
        absent_wp["backbone"].as_object_mut().unwrap().remove("withinPlane");
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: absent_wp,
        })
        .unwrap_err();
        assert!(err.iter().any(|e| e.path.contains("withinPlane")));

        // 未知 backbone.mode → INVALID（区别于 ring 的 UNSUPPORTED）。
        let mut unknown_mode = dual_plane_single_hop_params();
        unknown_mode["backbone"]["mode"] = json!("mesh");
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: unknown_mode,
        })
        .unwrap_err();
        assert!(err
            .iter()
            .any(|e| e.code == "INVALID_TEMPLATE_PARAM" && e.path.contains("backbone.mode")));

        // dataRateMbps 缺省 → 结构化错误。
        let mut no_rate = dual_plane_single_hop_params();
        no_rate.as_object_mut().unwrap().remove("dataRateMbps");
        let err = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: no_rate,
        })
        .unwrap_err();
        assert!(err.iter().any(|e| e.path.contains("dataRateMbps")));
    }

    #[test]
    fn dual_plane_descriptor_advertises_only_implemented_domain() {
        // 代码审查（api-contract）：descriptor 与 zod/实现的合法域一致性守护。
        let catalog = describe_templates_catalog();
        let templates = catalog["templates"].as_array().unwrap();
        let dp = templates
            .iter()
            .find(|t| t["id"] == "dual-plane-redundant")
            .expect("dual-plane descriptor present");
        let params = dp["params"].as_array().unwrap();
        let backbone = params.iter().find(|p| p["name"] == "backbone").unwrap();
        let cross = params.iter().find(|p| p["name"] == "crossPlaneLinks").unwrap();
        assert_eq!(backbone["itemShape"]["mode"], json!("line"));
        assert_eq!(cross["itemShape"]["mode"], json!("none"));
    }

    #[test]
    fn dual_plane_output_passes_validate_intermediate() {
        // Finding 2：sidecar initialize 不复验，端口分配 bug 须被本断言提前拦截。
        for params in [
            dual_plane_single_hop_params(),
            dual_plane_two_hop_params(),
            dual_plane_three_group_params(),
        ] {
            let (topo, _) = initialize_topology(&InitializeIntent {
                template_id: "dual-plane-redundant".into(),
                params,
            })
            .unwrap();
            let value = serde_json::to_value(&topo).unwrap();
            let report = validate_intermediate_topology(&value);
            assert!(report.ok, "dual-plane output failed validate: {:?}", report.errors);
        }
    }

    #[test]
    fn dual_plane_generation_is_deterministic_and_non_degenerate() {
        // R4/AE5：同输入两次全等 + 无两个节点共享 (x,y)——覆盖全部三种布局分支
        // （单跳三明治 / 双跳两平面行 / 3 组分侧）。
        for params in [
            dual_plane_single_hop_params(),
            dual_plane_two_hop_params(),
            dual_plane_three_group_params(),
        ] {
            let make = || {
                initialize_topology(&InitializeIntent {
                    template_id: "dual-plane-redundant".into(),
                    params: params.clone(),
                })
                .unwrap()
                .0
            };
            let a = make();
            let b = make();
            assert_eq!(
                serde_json::to_value(&a).unwrap(),
                serde_json::to_value(&b).unwrap()
            );
            let mut seen = std::collections::HashSet::new();
            for n in &a.nodes {
                assert!(
                    seen.insert((n.position.x.to_bits(), n.position.y.to_bits())),
                    "node {} shares position with another",
                    n.id
                );
            }
        }
    }

    #[test]
    fn dual_plane_grouped_but_unreferenced_switch_gets_own_column() {
        // 自带 groupId 但未被该 group planeSwitches 引用的交换机不得与
        // 该 group 的真实交换机重叠（列归属以 planeSwitches 引用为准）。
        let mut params = dual_plane_two_hop_params();
        params["switches"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "sw9", "plane": "A", "groupId": "g1"}));
        let (topo, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params,
        })
        .unwrap();
        let sw9 = dp_pos(&topo, "sw9");
        for id in ["sw1", "sw2", "sw3", "sw4"] {
            assert_ne!(sw9, dp_pos(&topo, id), "sw9 overlaps {}", id);
        }
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
        let over_max = SWITCH_COUNT_MAX + 188;
        let err = initialize_topology(&InitializeIntent {
            template_id: "generic-line".into(),
            params: json!({
                "switchCount": over_max,
                "endSystemsPerSwitch": 1,
                "dataRateMbps": 1000
            }),
        })
        .unwrap_err();
        assert_eq!(err[0].code, "INVALID_TEMPLATE_PARAM");
        assert_eq!(err[0].path, "$.params.switchCount");
        assert_eq!(err[0].details["maximum"], json!(SWITCH_COUNT_MAX));
        assert_eq!(err[0].details["minimum"], json!(SWITCH_COUNT_MIN));
        assert!(err[0].requires_user_clarification);
    }

    #[test]
    fn initialize_requires_explicit_switch_count() {
        // 缺 switchCount → requires_clarification，不再静默用 4
        let err = initialize_topology(&InitializeIntent {
            template_id: "generic-line".into(),
            params: json!({ "endSystemsPerSwitch": 2, "dataRateMbps": 1000 }),
        })
        .unwrap_err();
        assert_eq!(err[0].code, "INVALID_TEMPLATE_PARAM");
        assert_eq!(err[0].path, "$.params.switchCount");
        assert!(err[0].requires_user_clarification);
    }

    #[test]
    fn initialize_requires_explicit_end_systems_per_switch() {
        let err = initialize_topology(&InitializeIntent {
            template_id: "generic-line".into(),
            params: json!({ "switchCount": 4, "dataRateMbps": 1000 }),
        })
        .unwrap_err();
        assert_eq!(err[0].code, "INVALID_TEMPLATE_PARAM");
        assert_eq!(err[0].path, "$.params.endSystemsPerSwitch");
        assert!(err[0].requires_user_clarification);
    }

    #[test]
    fn initialize_requires_explicit_data_rate() {
        let err = initialize_topology(&InitializeIntent {
            template_id: "generic-line".into(),
            params: json!({ "switchCount": 4, "endSystemsPerSwitch": 2 }),
        })
        .unwrap_err();
        assert_eq!(err[0].code, "INVALID_TEMPLATE_PARAM");
        assert_eq!(err[0].path, "$.params.dataRateMbps");
        assert!(err[0].requires_user_clarification);
    }

    #[test]
    fn describe_templates_generic_params_omit_default_and_carry_legal_domain() {
        let catalog = describe_templates_catalog();
        for template_id in ["generic-line", "generic-ring"] {
            let template = catalog["templates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == template_id)
                .unwrap_or_else(|| panic!("template {} should exist", template_id));
            let params = template["params"].as_array().unwrap();

            let switch_count = params
                .iter()
                .find(|p| p["name"] == "switchCount")
                .expect("switchCount param");
            assert!(switch_count.get("default").is_none(), "switchCount must not carry default");
            assert_eq!(switch_count["type"], "integer");
            assert_eq!(switch_count["minimum"], json!(SWITCH_COUNT_MIN));
            assert_eq!(switch_count["maximum"], json!(SWITCH_COUNT_MAX));

            let end_systems = params
                .iter()
                .find(|p| p["name"] == "endSystemsPerSwitch")
                .expect("endSystemsPerSwitch param");
            assert!(end_systems.get("default").is_none(), "endSystemsPerSwitch must not carry default");
            assert_eq!(end_systems["type"], "integer");
            assert_eq!(end_systems["minimum"], json!(END_SYSTEMS_PER_SWITCH_MIN));
            assert_eq!(end_systems["maximum"], json!(END_SYSTEMS_PER_SWITCH_MAX));

            let data_rate = params
                .iter()
                .find(|p| p["name"] == "dataRateMbps")
                .expect("dataRateMbps param");
            assert!(data_rate.get("default").is_none(), "dataRateMbps must not carry default");
            assert_eq!(data_rate["type"], "enum");
            assert_eq!(data_rate["values"], json!(SUPPORTED_DATA_RATES));
        }
    }

    #[test]
    fn mcp_zod_legal_domain_matches_rust_constants() {
        // MCP 层 zod（topology-tools.ts）有意双写上下限以早失败；这里守 drift：
        // 改 Rust 常量却忘改 zod（或反之）会 red。
        let zod_src = include_str!("../../src-node/mcp/topology-tools.ts");
        let switch_clause = format!(".min({}).max({})", SWITCH_COUNT_MIN, SWITCH_COUNT_MAX);
        let end_systems_clause =
            format!(".min({}).max({})", END_SYSTEMS_PER_SWITCH_MIN, END_SYSTEMS_PER_SWITCH_MAX);
        assert!(
            zod_src.contains(&format!("switchCount: z.number().int(){}", switch_clause)),
            "zod switchCount bounds drifted from Rust SWITCH_COUNT_MIN/MAX ({switch_clause})"
        );
        assert!(
            zod_src.contains(&format!(
                "endSystemsPerSwitch: z.number().int(){}",
                end_systems_clause
            )),
            "zod endSystemsPerSwitch bounds drifted from Rust END_SYSTEMS_PER_SWITCH_MIN/MAX ({end_systems_clause})"
        );
        assert!(
            zod_src.contains(r#"endSystemPlacement: z.enum(["per-switch", "ends-only"]).optional()"#),
            "zod endSystemPlacement enum drifted from Rust placement parsing (per-switch/ends-only)"
        );
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
    fn ports_are_p0_indexed_across_templates() {
        // R5：全模板 P0 起编——节点端口与链路标签同源一致。
        let line = build_minimal_generic_line();
        assert_eq!(line.nodes[0].ports[0].id, "P0");
        assert!(line
            .links
            .iter()
            .all(|l| l.source.port_id.starts_with('P') && l.target.port_id.starts_with('P')));
        assert!(line.links.iter().any(|l| l.source.port_id == "P0"));

        let (dual, _) = initialize_topology(&InitializeIntent {
            template_id: "dual-plane-redundant".into(),
            params: dual_plane_single_hop_params(),
        })
        .unwrap();
        assert!(dual.nodes.iter().all(|n| n.ports[0].id == "P0"));
        assert!(dual
            .links
            .iter()
            .all(|l| l.source.port_id.starts_with('P') && l.target.port_id.starts_with('P')));
    }

    #[test]
    fn validate_intermediate_passes_for_generic_ring_output() {
        // ring 闭环块有独立端口字面量，漏改时悬空端口引用在此即红（U1 护栏）。
        let (topology, _) = initialize_topology(&InitializeIntent {
            template_id: "generic-ring".into(),
            params: json!({ "switchCount": 4, "endSystemsPerSwitch": 2, "dataRateMbps": 1000 }),
        })
        .unwrap();
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
}
