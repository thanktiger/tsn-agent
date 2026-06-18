//! 第二批 U1：把库内拓扑序列化成 INET 能加载的 bundle（network.ned + omnetpp.ini + manifest.json）。
//! 纯函数、可单测、不碰网络。复用第一批 `VerifyNode`/`VerifyLink` 入参与 `VerifyError` 形状。
//!
//! 真机校正（2026-06-17，~/tsn-agent-inet-verify 样例 + EXIT=0）：
//! - `*.eth[*].bitrate` 写在 NED `parameters` 段（**非** omnetpp.ini）。
//! - `connections` 段用 `allowunconnected`（容忍未连端口、避免 NED 编译失败）。
//! - manifest 字段名 `schemaVersion`（v0），顶层加 `caliber`/`sourceMutationId` 不破坏既有消费。
//! - 节点命名用纯数字全局序号 `sw{N}`/`es{N}`（不混 sync_name/name 原文 → 天然安全标识符，KTD8）；
//!   多挂（双平面）端系统照常唯一命名、不判 unmappable（boss 已定本批支持）。

use crate::topology_verify::{VerifyError, VerifyLink, VerifyNode};

const NODE_TYPE_SWITCH: &str = "switch";
const NODE_TYPE_END_SYSTEM: &str = "endSystem";
const NODE_TYPE_SERVER: &str = "server";

const DEFAULT_DATARATE_MBPS: u32 = 1000;
const MAX_DATARATE_MBPS: f64 = 100_000.0;

/// 序列化产物：三个文件的内容（路径由调用方按 bundle 布局放置）。
#[derive(Debug, Clone)]
pub struct InetBundle {
    pub network_ned: String,
    pub omnetpp_ini: String,
    pub manifest_json: String,
}

struct MappedNode {
    ned_name: String,
    ned_type: &'static str,
}

/// node_type → INET 模块类型。server 当被动终端设备，初判 `TsnDevice`（执行期按真机加载确认）。
fn map_node_type(node_type: Option<&str>) -> Option<&'static str> {
    match node_type {
        Some(NODE_TYPE_SWITCH) => Some("TsnSwitch"),
        Some(NODE_TYPE_END_SYSTEM) => Some("TsnDevice"),
        Some(NODE_TYPE_SERVER) => Some("TsnDevice"),
        _ => None,
    }
}

/// 从 styles_json 取链路速率（Mbps），校验为正有限数值且 ≤100Gbps；否则回退默认。
/// 绝不把原始串拼进 NED（KTD8 注入防护）——非法值用默认数值。
fn link_datarate_mbps(styles_json: &str) -> u32 {
    let parsed: Option<f64> = serde_json::from_str::<serde_json::Value>(styles_json)
        .ok()
        .and_then(|v| v.get("speed").cloned())
        .and_then(|s| match s {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(st) => st.trim().parse::<f64>().ok(),
            _ => None,
        });
    match parsed {
        Some(v) if v.is_finite() && v > 0.0 && v <= MAX_DATARATE_MBPS => v.round() as u32,
        _ => DEFAULT_DATARATE_MBPS,
    }
}

/// 把库内拓扑序列化成 inet-bundle。类型映射不出来 → 返回 `unmappable_node_type` 错误集、不产 NED。
pub fn build_inet_bundle(
    nodes: &[VerifyNode],
    links: &[VerifyLink],
    session_id: &str,
    source_mutation_id: i64,
) -> Result<InetBundle, Vec<VerifyError>> {
    let mut errors: Vec<VerifyError> = Vec::new();
    let mut mapped: std::collections::HashMap<&str, MappedNode> = std::collections::HashMap::new();
    let mut sw_seq = 0u32;
    let mut es_seq = 0u32;

    for node in nodes {
        match map_node_type(node.node_type.as_deref()) {
            Some("TsnSwitch") => {
                sw_seq += 1;
                mapped.insert(
                    node.sync_name.as_str(),
                    MappedNode { ned_name: format!("sw{sw_seq}"), ned_type: "TsnSwitch" },
                );
            }
            Some(ned_type) => {
                es_seq += 1;
                mapped.insert(
                    node.sync_name.as_str(),
                    MappedNode { ned_name: format!("es{es_seq}"), ned_type },
                );
            }
            None => errors.push(VerifyError {
                code: "unmappable_node_type".to_string(),
                message_zh: format!(
                    "节点 {} 的类型无法映射到 INET 模块（不是交换机/端系统/服务器）。",
                    node.sync_name
                ),
                node_ref: Some(node.sync_name.clone()),
            }),
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    // submodules：按入参顺序输出 `<ned_name>: <ned_type>;`。
    let mut submodules = String::new();
    for node in nodes {
        if let Some(m) = mapped.get(node.sync_name.as_str()) {
            submodules.push_str(&format!("        {}: {};\n", m.ned_name, m.ned_type));
        }
    }

    // connections：每条 link 两端 sync_name → ned_name；`ethg++` 门按发出顺序分配（门号唯一真源）。
    // 端点不在 mapped（悬空，结构校验已拦）则跳过，配合 allowunconnected 容忍。
    let mut connections = String::new();
    for link in links {
        let (Some(src), Some(dst)) = (
            mapped.get(link.src_sync_name.as_str()),
            mapped.get(link.dst_sync_name.as_str()),
        ) else {
            continue;
        };
        let rate = link_datarate_mbps(&link.styles_json);
        connections.push_str(&format!(
            "        {}.ethg++ <--> EthernetLink {{ datarate = {}Mbps; }} <--> {}.ethg++;\n",
            src.ned_name, rate, dst.ned_name
        ));
    }

    let network_ned = format!(
        "package tsnagent.generated;\n\n\
import inet.networks.base.TsnNetworkBase;\n\
import inet.node.ethernet.EthernetLink;\n\
import inet.node.tsn.TsnDevice;\n\
import inet.node.tsn.TsnSwitch;\n\n\
network TsnAgentNetwork extends TsnNetworkBase\n{{\n\
    parameters:\n\
        *.eth[*].bitrate = default({}Mbps);\n\
    submodules:\n{}\
    connections allowunconnected:\n{}\
}}\n",
        DEFAULT_DATARATE_MBPS, submodules, connections
    );

    let omnetpp_ini = "[General]\n\
network = tsnagent.generated.TsnAgentNetwork\n\
sim-time-limit = 1000us\n\
cmdenv-interactive = false\n\
cmdenv-express-mode = true\n"
        .to_string();

    let manifest = serde_json::json!({
        "schemaVersion": "tsn-agent.export-manifest.v0",
        "sessionId": session_id,
        "sourceMutationId": source_mutation_id,
        "caliber": crate::topology_verify::CALIBER_LOADABILITY_ONLY,
        "files": [
            { "path": "tsnagent/generated/network.ned", "purpose": "simulation-inet", "label": "INET/OMNeT++ 网络拓扑" },
            { "path": "omnetpp.ini", "purpose": "simulation-inet", "label": "INET/OMNeT++ 最小运行配置" }
        ]
    });
    let manifest_json = serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".to_string());

    Ok(InetBundle { network_ned, omnetpp_ini, manifest_json })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(sync: &str, ty: &str) -> VerifyNode {
        VerifyNode { sync_name: sync.into(), name: None, node_type: Some(ty.into()) }
    }
    fn link(seq: i64, src: &str, dst: &str) -> VerifyLink {
        VerifyLink {
            link_seq: seq,
            src_sync_name: src.into(),
            dst_sync_name: dst.into(),
            styles_json: r#"{"leftLabel":"0","rightLabel":"0","speed":1000}"#.into(),
        }
    }

    /// 合法星型 → 产三文件，NED 含 package/import/network/模块/连线。
    #[test]
    fn legal_star_serializes() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem"), node("2", "endSystem")];
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        let b = build_inet_bundle(&nodes, &links, "s1", 7).unwrap();
        assert!(b.network_ned.contains("package tsnagent.generated;"));
        assert!(b.network_ned.contains("import inet.node.tsn.TsnSwitch;"));
        assert!(b.network_ned.contains("network TsnAgentNetwork extends TsnNetworkBase"));
        assert!(b.network_ned.contains("sw1: TsnSwitch;"));
        assert!(b.network_ned.contains("es1: TsnDevice;"));
        assert!(b.network_ned.contains("es2: TsnDevice;"));
        assert!(b.network_ned.contains("EthernetLink { datarate = 1000Mbps; }"));
    }

    /// 类型映射：switch→TsnSwitch、endSystem/server→TsnDevice。
    #[test]
    fn maps_node_types_incl_server() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem"), node("2", "server")];
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        let b = build_inet_bundle(&nodes, &links, "s1", 1).unwrap();
        assert!(b.network_ned.contains("sw1: TsnSwitch;"));
        assert!(b.network_ned.contains("es1: TsnDevice;")); // endSystem
        assert!(b.network_ned.contains("es2: TsnDevice;")); // server 也 → TsnDevice
    }

    /// 命名用纯数字全局序号、唯一；NED parameters 含 bitrate、connections 含 allowunconnected。
    #[test]
    fn global_serial_naming_and_real_machine_shape() {
        let nodes = vec![node("0", "switch"), node("1", "switch"), node("2", "endSystem")];
        let links = vec![link(0, "0", "1"), link(1, "0", "2")];
        let b = build_inet_bundle(&nodes, &links, "s1", 1).unwrap();
        assert!(b.network_ned.contains("sw1: TsnSwitch;"));
        assert!(b.network_ned.contains("sw2: TsnSwitch;"));
        assert!(b.network_ned.contains("es1: TsnDevice;"));
        assert!(b.network_ned.contains("*.eth[*].bitrate = default(1000Mbps);"));
        assert!(b.network_ned.contains("connections allowunconnected:"));
        // omnetpp.ini 不含 bitrate（真机：bitrate 在 NED parameters）。
        assert!(!b.omnetpp_ini.contains("bitrate"));
        assert!(b.omnetpp_ini.contains("cmdenv-interactive = false"));
        assert!(b.omnetpp_ini.contains("cmdenv-express-mode = true"));
        assert!(b.omnetpp_ini.contains("network = tsnagent.generated.TsnAgentNetwork"));
    }

    /// 双平面：端系统同时连两个交换机 → 正常产 NED、命名唯一、不判 unmappable。
    #[test]
    fn dual_homed_endsystem_supported() {
        let nodes = vec![node("0", "switch"), node("1", "switch"), node("2", "endSystem")];
        // es(2) 同时连 sw(0) 和 sw(1)。
        let links = vec![link(0, "0", "1"), link(1, "2", "0"), link(2, "2", "1")];
        let b = build_inet_bundle(&nodes, &links, "s1", 1).unwrap();
        assert!(b.network_ned.contains("es1: TsnDevice;"));
        // 两条连到同一 es 的线都在。
        let es_to_sw = b.network_ned.matches("es1.ethg++").count();
        assert_eq!(es_to_sw, 2, "dual-homed es 应出现在两条连线里");
    }

    /// 链路速率非法（负/非数字/超大）→ 回退默认 1000，原始串绝不进 datarate。
    #[test]
    fn invalid_speed_falls_back_to_default() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let bad = VerifyLink {
            link_seq: 0,
            src_sync_name: "0".into(),
            dst_sync_name: "1".into(),
            styles_json: r#"{"speed":"0; import evil"}"#.into(),
        };
        let b = build_inet_bundle(&nodes, &[bad], "s1", 1).unwrap();
        assert!(b.network_ned.contains("datarate = 1000Mbps;"));
        assert!(!b.network_ned.contains("import evil"), "原始非法串不得进 NED");
    }

    /// node_type 为 NULL / 未知 → unmappable_node_type，不产 NED（Covers AE8）。
    #[test]
    fn unmappable_node_type_errors() {
        let mut nodes = vec![node("0", "switch")];
        nodes.push(VerifyNode { sync_name: "1".into(), name: None, node_type: None });
        let links = vec![link(0, "0", "1")];
        let err = build_inet_bundle(&nodes, &links, "s1", 1).unwrap_err();
        assert!(err.iter().any(|e| e.code == "unmappable_node_type"));
    }

    /// manifest 沿用 v0 schemaVersion + 顶层 caliber/sourceMutationId。
    #[test]
    fn manifest_v0_fields_with_caliber() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let links = vec![link(0, "0", "1")];
        let b = build_inet_bundle(&nodes, &links, "sess-x", 42).unwrap();
        let m: serde_json::Value = serde_json::from_str(&b.manifest_json).unwrap();
        assert_eq!(m["schemaVersion"], "tsn-agent.export-manifest.v0");
        assert_eq!(m["caliber"], "loadability_only");
        assert_eq!(m["sourceMutationId"], 42);
        assert_eq!(m["sessionId"], "sess-x");
        assert!(m["files"].as_array().unwrap().len() >= 2);
    }
}
