//! U1（时钟同步软仿）：把库内拓扑 + 时钟树 + 覆盖参数序列化成可跑的 INET gPTP 软仿
//! bundle（network.ned + omnetpp.ini + manifest.json）。纯函数、可单测、不碰网络。
//! 复用 `VerifyNode`/`VerifyLink`/`VerifyError` 形状；参照 `inet_bundle.rs`（将删）的结构。
//!
//! 与「加载验证」bundle 的关键区别：
//! - **端口→ethN 显式映射（KTD3，boss 定 A）**：每节点的端口集合按库端口号升序取下标 k，
//!   映射到 NED 门号 `ethg[k]` / 接口 `eth{k}`。NED 门号、`masterPorts`/`slavePort`、库端口角色
//!   三者由同一张表派生，杜绝 `ethg++` 隐式序接错线。
//! - **gPTP 硬性前提**（R2）：`simtime-resolution=fs`、每节点振荡器、显式 GM 与 master/slave
//!   端口（INET 无 BMCA）、`referenceClock=<GM>.clock`、显式开 clock 模块 vector recording、固定 seed。
//!
//! **执行注记（plan U1）**：实现首步须先在远端跑 gptp showcase 实跑一次，确认 NED 门名到底是
//! `ethg[k]` 还是 `eth[k]`、以及 `.vec` 里 `timeChanged` 的真实 module 路径，再固化 scavetool
//! filter。端口→k 的换算规则（本模块）不依赖实跑、已固化。

use crate::topology_verify::{VerifyError, VerifyLink, VerifyNode};
use std::collections::BTreeMap;

const NODE_TYPE_SWITCH: &str = "switch";
const NODE_TYPE_END_SYSTEM: &str = "endSystem";
const NODE_TYPE_SERVER: &str = "server";

const DEFAULT_DATARATE_MBPS: u32 = 1000;
const MAX_DATARATE_MBPS: f64 = 100_000.0;

/// R3(a) 固定默认（不暴露）：取自 INET clockdrift showcase。
const DEFAULT_DRIFT_PPM: f64 = 100.0;
const DEFAULT_SIM_TIME_S: f64 = 60.0;
const NOMINAL_TICK_LENGTH: &str = "10ns";
/// RandomDriftOscillator 必填项：漂移率更新间隔（取自 INET gptp showcase）。
const RANDOM_CHANGE_INTERVAL: &str = "12.5ms";
/// 每次更新的漂移率增量（随机游走步长，showcase 默认）。
const RANDOM_DRIFT_STEP_PPM: f64 = 1.0;
const LINK_LENGTH: &str = "10m";
const SEED_SET: u32 = 0;

pub use crate::inet_remote::InetBundle;

/// build_timesync_sim_bundle 产物：bundle + GM 的 ned 名。命令层用 gm_ned_name 按 module 名
/// 精确定位 GM 时间序列（取代脆弱的「值域最小=GM」启发式，code-review correctness/adversarial）。
#[derive(Debug, Clone)]
pub struct TimesyncSimBundle {
    pub bundle: InetBundle,
    pub gm_ned_name: String,
}

/// 覆盖表单（R4）：振荡器类型 / 漂移幅度 / sim 时长。缺省走 R3(a) 固定默认。
#[derive(Debug, Clone, Default)]
pub struct SimOverrides {
    /// 振荡器类型：Constant（恒定漂移）/ Random（随机漂移，默认）。
    pub oscillator: OscillatorKind,
    /// 漂移幅度（ppm，对称 uniform(-x, x)；Constant 则取常量 x）。缺省 100ppm。
    pub drift_ppm: Option<f64>,
    /// sim 时长（秒）。缺省 1s。
    pub sim_time_s: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OscillatorKind {
    Constant,
    #[default]
    Random,
}

/// 单节点的时钟同步参数（来自 timesync_nodes 落库快照）。端口号是库端口号（DB port），
/// 由本模块的映射表换算成 eth{k}。
#[derive(Debug, Clone)]
pub struct SimNodeTiming {
    pub mid: String,
    /// master 端口（库端口号）。
    pub master_port: Vec<i64>,
    /// slave 端口（库端口号；非 GM 节点恰 1 个）。
    pub slave_port: Vec<i64>,
    /// gPTP syncInterval（来自 sync_period，毫秒）。None → 不写、用 INET 默认。
    pub sync_period_ms: Option<i64>,
    /// gPTP pdelayInterval（来自 measure_period，毫秒）。
    pub measure_period_ms: Option<i64>,
}

struct MappedNode {
    ned_name: String,
    ned_type: &'static str,
}

fn map_node_type(node_type: Option<&str>) -> Option<&'static str> {
    match node_type {
        Some(NODE_TYPE_SWITCH) => Some("TsnSwitch"),
        Some(NODE_TYPE_END_SYSTEM) => Some("TsnDevice"),
        Some(NODE_TYPE_SERVER) => Some("TsnDevice"),
        _ => None,
    }
}

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

/// 链路速率（Mbps）：优先用 speed 列（结构事实源），缺省回退 styles_json.speed、再回退默认。
fn link_rate(link: &VerifyLink) -> u32 {
    if let Some(s) = link.speed
        && s > 0
        && (s as f64) <= MAX_DATARATE_MBPS
    {
        return s as u32;
    }
    link_datarate_mbps(&link.styles_json)
}

/// 端口→ethN 映射（KTD3 A）：每节点端口集合按库端口号升序取下标。
/// 返回 `mid → (db_port → k)`。同一节点所有出现过的端口（来自 src_port/dst_port）参与排序。
fn build_port_eth_map(links: &[VerifyLink]) -> BTreeMap<String, BTreeMap<i64, usize>> {
    // 先收集每节点用到的库端口号（去重、升序由 BTreeMap 保证）。
    let mut node_ports: BTreeMap<String, std::collections::BTreeSet<i64>> = BTreeMap::new();
    for link in links {
        if let Some(p) = link.src_port {
            node_ports
                .entry(link.src_node.clone())
                .or_default()
                .insert(p);
        }
        if let Some(p) = link.dst_port {
            node_ports
                .entry(link.dst_node.clone())
                .or_default()
                .insert(p);
        }
    }
    let mut map: BTreeMap<String, BTreeMap<i64, usize>> = BTreeMap::new();
    for (mid, ports) in node_ports {
        let inner: BTreeMap<i64, usize> =
            ports.into_iter().enumerate().map(|(k, p)| (p, k)).collect();
        map.insert(mid, inner);
    }
    map
}

fn eth_name(
    map: &BTreeMap<String, BTreeMap<i64, usize>>,
    mid: &str,
    db_port: i64,
) -> Option<String> {
    map.get(mid)
        .and_then(|inner| inner.get(&db_port))
        .map(|k| format!("eth{k}"))
}

/// 把库内拓扑 + 时钟树参数序列化成 gPTP 软仿 bundle。
/// 错误集非空（类型不可映射 / 链路端口列 NULL / GM 不存在）则不产 NED。
pub fn build_timesync_sim_bundle(
    nodes: &[VerifyNode],
    links: &[VerifyLink],
    gm_mid: &str,
    timing: &[SimNodeTiming],
    overrides: &SimOverrides,
    session_id: &str,
    source_mutation_id: i64,
) -> Result<TimesyncSimBundle, Vec<VerifyError>> {
    let mut errors: Vec<VerifyError> = Vec::new();
    let mut mapped: BTreeMap<&str, MappedNode> = BTreeMap::new();
    let mut sw_seq = 0u32;
    let mut es_seq = 0u32;

    for node in nodes {
        match map_node_type(node.node_type.as_deref()) {
            Some("TsnSwitch") => {
                sw_seq += 1;
                mapped.insert(
                    node.mid.as_str(),
                    MappedNode {
                        ned_name: format!("sw{sw_seq}"),
                        ned_type: "TsnSwitch",
                    },
                );
            }
            Some(ned_type) => {
                es_seq += 1;
                mapped.insert(
                    node.mid.as_str(),
                    MappedNode {
                        ned_name: format!("es{es_seq}"),
                        ned_type,
                    },
                );
            }
            None => errors.push(VerifyError {
                code: "unmappable_node_type".to_string(),
                message_zh: format!(
                    "节点 {} 的类型无法映射到 INET 模块（不是交换机/端系统/服务器）。",
                    node.mid
                ),
                node_ref: Some(node.mid.clone()),
            }),
        }
    }

    // GM 必须存在且可映射。
    if !mapped.contains_key(gm_mid) {
        errors.push(VerifyError {
            code: "gm_not_found".to_string(),
            message_zh: format!("GM 节点 {gm_mid} 不在拓扑里，无法生成软仿。"),
            node_ref: Some(gm_mid.to_string()),
        });
    }

    // 链路端口列 NULL → 明确报错（不静默产错接线）。
    for link in links {
        if !mapped.contains_key(link.src_node.as_str())
            || !mapped.contains_key(link.dst_node.as_str())
        {
            continue; // 悬空链路结构校验已拦，这里跳过。
        }
        if link.src_port.is_none() || link.dst_port.is_none() {
            errors.push(VerifyError {
                code: "link_port_null".to_string(),
                message_zh: format!(
                    "链路 {} 的端口列为空（src_port/dst_port NULL），无法映射 ethN，请先补端口。",
                    link.link_seq
                ),
                node_ref: None,
            });
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }

    let port_eth = build_port_eth_map(links);

    // submodules：`<ned_name>: <ned_type>;`，按入参顺序。
    // 关键（真机校正 2026-06-26）：用显式门号 `ethg[k]` 时 INET 的 `ethg[]` 默认 size 0，
    // 必须在 submodule 里显式声明门向量大小（=该节点用到的端口数），否则 network setup 报
    // 「Gate index 0 out of range ... 'ethg$i[]' with size 0」。`ethg++` 才会自动增长。
    let mut submodules = String::new();
    for node in nodes {
        if let Some(m) = mapped.get(node.mid.as_str()) {
            let gate_count = port_eth.get(node.mid.as_str()).map_or(0, |p| p.len());
            if gate_count > 0 {
                submodules.push_str(&format!(
                    "        {}: {} {{\n            gates:\n                ethg[{}];\n        }}\n",
                    m.ned_name, m.ned_type, gate_count
                ));
            } else {
                submodules.push_str(&format!("        {}: {};\n", m.ned_name, m.ned_type));
            }
        }
    }

    // connections：显式门号 ethg[k]（k 由端口映射派生），不再 ethg++。
    let mut connections = String::new();
    for link in links {
        let (Some(src), Some(dst)) = (
            mapped.get(link.src_node.as_str()),
            mapped.get(link.dst_node.as_str()),
        ) else {
            continue;
        };
        // 端口列已校验非 NULL。
        let (sp, dp) = (link.src_port.unwrap(), link.dst_port.unwrap());
        let (ks, kd) = (port_eth[&link.src_node][&sp], port_eth[&link.dst_node][&dp]);
        let rate = link_rate(link);
        connections.push_str(&format!(
            "        {}.ethg[{}] <--> EthernetLink {{ datarate = {}Mbps; length = {}; }} <--> {}.ethg[{}];\n",
            src.ned_name, ks, rate, LINK_LENGTH, dst.ned_name, kd
        ));
    }

    let network_ned = format!(
        "package tsnagent.generated;\n\n\
import inet.networks.base.TsnNetworkBase;\n\
import inet.node.ethernet.EthernetLink;\n\
import inet.node.tsn.TsnDevice;\n\
import inet.node.tsn.TsnSwitch;\n\n\
network TsnAgentTimesyncNetwork extends TsnNetworkBase\n{{\n\
    parameters:\n\
        *.eth[*].bitrate = default({DEFAULT_DATARATE_MBPS}Mbps);\n\
    submodules:\n{submodules}\
    connections allowunconnected:\n{connections}\
}}\n"
    );

    let gm_ned = &mapped[gm_mid].ned_name;
    let omnetpp_ini = build_ini(&mapped, &port_eth, gm_ned, timing, overrides);

    let manifest = serde_json::json!({
        "schemaVersion": "tsn-agent.export-manifest.v0",
        "sessionId": session_id,
        "sourceMutationId": source_mutation_id,
        "caliber": "timesync_simulated",
        "gmMid": gm_mid,
        "files": [
            { "path": "tsnagent/generated/network.ned", "purpose": "simulation-inet", "label": "INET gPTP 软仿拓扑" },
            { "path": "omnetpp.ini", "purpose": "simulation-inet", "label": "INET gPTP 软仿运行配置" }
        ]
    });
    let manifest_json =
        serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".to_string());

    Ok(TimesyncSimBundle {
        gm_ned_name: gm_ned.clone(),
        bundle: InetBundle {
            network_ned,
            omnetpp_ini,
            manifest_json,
        },
    })
}

/// 拼 omnetpp.ini。gPTP 硬性前提 + 振荡器 + referenceClock + recording + seed + 每节点端口角色。
fn build_ini(
    mapped: &BTreeMap<&str, MappedNode>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    gm_ned: &str,
    timing: &[SimNodeTiming],
    overrides: &SimOverrides,
) -> String {
    let sim_time = overrides.sim_time_s.unwrap_or(DEFAULT_SIM_TIME_S);
    let drift = overrides.drift_ppm.unwrap_or(DEFAULT_DRIFT_PPM);

    let mut ini = String::new();
    ini.push_str("[General]\n");
    ini.push_str("network = tsnagent.generated.TsnAgentTimesyncNetwork\n");
    ini.push_str(&format!("sim-time-limit = {sim_time}s\n"));
    // gPTP 硬性前提（R2）。
    ini.push_str("simtime-resolution = fs\n");
    ini.push_str(&format!("seed-set = {SEED_SET}\n"));
    ini.push_str("cmdenv-interactive = false\n");
    ini.push_str("cmdenv-express-mode = true\n");
    // 真机校正（2026-06-26）：在所有 TSN 节点上启用时间同步——这才会实例化每节点的
    // clock + gptp 子模块（否则节点无 clock → 不录 timeChanged → scavetool 导出 0 行 →
    // 取数解析失败）。与 INET gptp showcase 同款（`*.*.hasTimeSynchronization = true`）。
    ini.push_str("*.*.hasTimeSynchronization = true\n");
    // 真机校正（2026-06-26）：gPTP 的 pdelay 测量要求以太网 PHY 用流式收发器，它才发
    // receptionStarted/transmissionStarted 时序信号；默认 packet 收发器不发 → 运行时报
    // “must emit receptionStarted signal”。与 INET gptp showcase 同款。
    ini.push_str("**.transmitter.typename = \"StreamingTransmitter\"\n");
    ini.push_str("**.receiver.typename = \"DestreamingReceiver\"\n");

    // 振荡器：每节点挂时钟振荡器（漂移驱动偏差）。
    match overrides.oscillator {
        OscillatorKind::Random => {
            // RandomDriftOscillator 用 initialDriftRate（非 driftRate，后者它没有 → 静默丢弃），
            // changeInterval 必填（无默认，缺则 Cmdenv 停下等输入）。漂移率在 [-drift, drift] 内随机游走。
            ini.push_str("**.clock.oscillator.typename = \"RandomDriftOscillator\"\n");
            ini.push_str(&format!(
                "**.clock.oscillator.changeInterval = {RANDOM_CHANGE_INTERVAL}\n"
            ));
            ini.push_str(&format!(
                "**.clock.oscillator.initialDriftRate = uniform(-{drift}ppm, {drift}ppm)\n"
            ));
            ini.push_str(&format!(
                "**.clock.oscillator.driftRateChange = uniform(-{RANDOM_DRIFT_STEP_PPM}ppm, {RANDOM_DRIFT_STEP_PPM}ppm)\n"
            ));
            ini.push_str(&format!(
                "**.clock.oscillator.driftRateChangeLowerLimit = -{drift}ppm\n"
            ));
            ini.push_str(&format!(
                "**.clock.oscillator.driftRateChangeUpperLimit = {drift}ppm\n"
            ));
        }
        OscillatorKind::Constant => {
            ini.push_str("**.clock.oscillator.typename = \"ConstantDriftOscillator\"\n");
            ini.push_str(&format!("**.clock.oscillator.driftRate = {drift}ppm\n"));
        }
    }
    ini.push_str(&format!(
        "**.clock.oscillator.nominalTickLength = {NOMINAL_TICK_LENGTH}\n"
    ));

    // referenceClock：各 clock 对齐 GM，供取回后相减算偏差。
    ini.push_str(&format!("**.referenceClock = \"{gm_ned}.clock\"\n"));

    // 显式开 clock 模块 vector recording，否则结果为空（R2/R10）。
    ini.push_str("**.clock.result-recording-modes = +vector\n");

    // 每节点 gPTP 端口角色（INET 无 BMCA，须显式 master/slave）。
    ini.push('\n');
    for t in timing {
        let Some(m) = mapped.get(t.mid.as_str()) else {
            continue;
        };
        let master_eths: Vec<String> = t
            .master_port
            .iter()
            .filter_map(|p| eth_name(port_eth, &t.mid, *p))
            .map(|e| format!("\"{e}\""))
            .collect();
        // gptpNodeType 显式按时钟树角色（INET 不允许 BRIDGE_NODE 缺 master 口）。双平面冗余里
        // 冗余平面的交换机会成生成树叶子（只有 slave 口、无 master 口）→ 归 SLAVE_NODE，
        // 它仍同步自身 clock 并录 timeChanged，只是不向下转发。
        let gptp_node_type = if m.ned_name == gm_ned {
            "MASTER_NODE"
        } else if master_eths.is_empty() {
            "SLAVE_NODE"
        } else {
            "BRIDGE_NODE"
        };
        ini.push_str(&format!(
            "*.{}.gptp.gptpNodeType = \"{gptp_node_type}\"\n",
            m.ned_name
        ));
        ini.push_str(&format!(
            "*.{}.gptp.masterPorts = [{}]\n",
            m.ned_name,
            master_eths.join(", ")
        ));
        // slavePort 总是显式发：GM 发空串覆盖 TsnDevice 的非空默认（否则 MASTER_NODE
        // 残留默认 slavePort → INET 报 “MASTER_NODE with slave port”）。
        let slave_eth = t
            .slave_port
            .first()
            .and_then(|p| eth_name(port_eth, &t.mid, *p))
            .unwrap_or_default();
        ini.push_str(&format!(
            "*.{}.gptp.slavePort = \"{slave_eth}\"\n",
            m.ned_name
        ));
        if let Some(sync) = t.sync_period_ms {
            ini.push_str(&format!("*.{}.gptp.syncInterval = {sync}ms\n", m.ned_name));
        }
        if let Some(pdelay) = t.measure_period_ms {
            ini.push_str(&format!(
                "*.{}.gptp.pdelayInterval = {pdelay}ms\n",
                m.ned_name
            ));
        }
    }

    ini
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(mid: &str, ty: &str) -> VerifyNode {
        VerifyNode {
            mid: mid.into(),
            name: None,
            node_type: Some(ty.into()),
        }
    }
    fn link(seq: i64, src: &str, dst: &str, sp: Option<i64>, dp: Option<i64>) -> VerifyLink {
        VerifyLink {
            link_seq: seq,
            src_node: src.into(),
            dst_node: dst.into(),
            src_port: sp,
            dst_port: dp,
            speed: None,
            styles_json: r#"{"plane":"A"}"#.into(),
        }
    }

    // GM=es1(mid 1)，sw(mid 0) 连两个 ES。端口升序映射：sw 端口 {2,5}→eth0/eth1。
    fn sample() -> (Vec<VerifyNode>, Vec<VerifyLink>, Vec<SimNodeTiming>) {
        let nodes = vec![
            node("0", "switch"),
            node("1", "endSystem"),
            node("2", "endSystem"),
        ];
        // sw0 用端口 5 接 es1，端口 2 接 es2（故意乱序，验证升序取下标）。
        let links = vec![
            link(0, "0", "1", Some(5), Some(0)),
            link(1, "0", "2", Some(2), Some(0)),
        ];
        let timing = vec![
            // GM=1：所有参与端口 master。
            SimNodeTiming {
                mid: "1".into(),
                master_port: vec![0],
                slave_port: vec![],
                sync_period_ms: Some(125),
                measure_period_ms: Some(1000),
            },
            // sw0：master 端口 5、2；slave 端口朝 GM = 5。
            SimNodeTiming {
                mid: "0".into(),
                master_port: vec![2],
                slave_port: vec![5],
                sync_period_ms: None,
                measure_period_ms: None,
            },
            SimNodeTiming {
                mid: "2".into(),
                master_port: vec![],
                slave_port: vec![0],
                sync_period_ms: None,
                measure_period_ms: None,
            },
        ];
        (nodes, links, timing)
    }

    #[test]
    fn port_eth_map_assigns_by_ascending_db_port() {
        let (_, links, _) = sample();
        let map = build_port_eth_map(&links);
        // sw0 端口 {2,5} 升序 → 2→eth0, 5→eth1。
        assert_eq!(map["0"][&2], 0);
        assert_eq!(map["0"][&5], 1);
        // es1/es2 各只有端口 0 → eth0。
        assert_eq!(map["1"][&0], 0);
        assert_eq!(map["2"][&0], 0);
    }

    #[test]
    fn ini_has_gptp_hard_prereqs_and_mapped_ports() {
        let (nodes, links, timing) = sample();
        let b = build_timesync_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        // gPTP 硬性前提全在。
        assert!(ini.contains("simtime-resolution = fs"));
        // 真机校正：必须启用时间同步以实例化各节点 clock（否则不录 timeChanged）。
        assert!(ini.contains("*.*.hasTimeSynchronization = true"));
        // 真机校正：gPTP pdelay 需流式收发器发 receptionStarted 信号。
        assert!(ini.contains("**.transmitter.typename = \"StreamingTransmitter\""));
        assert!(ini.contains("**.receiver.typename = \"DestreamingReceiver\""));
        assert!(ini.contains("seed-set = 0"));
        assert!(ini.contains("RandomDriftOscillator"));
        // 真机校正：RandomDriftOscillator 的 changeInterval 必填（无默认会停下等输入）。
        assert!(
            ini.contains("**.clock.oscillator.changeInterval = 12.5ms"),
            "{ini}"
        );
        assert!(
            ini.contains("**.clock.oscillator.initialDriftRate = uniform"),
            "{ini}"
        );
        assert!(ini.contains("nominalTickLength = 10ns"));
        assert!(ini.contains("**.clock.result-recording-modes = +vector"));
        // referenceClock 指向 GM 的 ned 名（es1）。
        assert!(ini.contains("**.referenceClock = \"es1.clock\""), "{ini}");
        // sw0 master 端口 2 → eth0；slave 端口 5 → eth1。
        assert!(ini.contains("*.sw1.gptp.masterPorts = [\"eth0\"]"), "{ini}");
        assert!(ini.contains("*.sw1.gptp.slavePort = \"eth1\""), "{ini}");
        // gptpNodeType 按角色：GM=MASTER、有 master+slave=BRIDGE、只有 slave=SLAVE。
        assert!(
            ini.contains("*.es1.gptp.gptpNodeType = \"MASTER_NODE\""),
            "{ini}"
        );
        assert!(
            ini.contains("*.sw1.gptp.gptpNodeType = \"BRIDGE_NODE\""),
            "{ini}"
        );
        assert!(
            ini.contains("*.es2.gptp.gptpNodeType = \"SLAVE_NODE\""),
            "{ini}"
        );
        // GM 显式空 slavePort 覆盖 TsnDevice 默认（否则 MASTER_NODE 报 slave port 冲突）。
        assert!(ini.contains("*.es1.gptp.slavePort = \"\""), "{ini}");
    }

    #[test]
    fn ned_uses_explicit_gate_indices_from_mapping() {
        let (nodes, links, timing) = sample();
        let b = build_timesync_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            "s1",
            7,
        )
        .unwrap();
        let ned = &b.bundle.network_ned;
        // sw0 端口5→eth1 接 es1.eth0；端口2→eth0 接 es2.eth0。
        assert!(ned.contains("sw1.ethg[1] <-->"), "{ned}");
        assert!(ned.contains("sw1.ethg[0] <-->"), "{ned}");
        assert!(ned.contains("allowunconnected"));
        // 真机校正：显式门号必须配门向量大小声明，否则 INET ethg[] size 0 报错。
        // sw0 用 2 个端口 → ethg[2]；es1/es2 各 1 个端口 → ethg[1]。
        assert!(ned.contains("ethg[2];"), "sw 应声明门大小 ethg[2]: {ned}");
        assert!(ned.contains("ethg[1];"), "es 应声明门大小 ethg[1]: {ned}");
    }

    #[test]
    fn null_port_link_errors() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let links = vec![link(0, "0", "1", Some(1), None)]; // dst_port NULL
        let timing = vec![];
        let err = build_timesync_sim_bundle(
            &nodes,
            &links,
            "0",
            &timing,
            &SimOverrides::default(),
            "s1",
            1,
        )
        .unwrap_err();
        assert!(err.iter().any(|e| e.code == "link_port_null"), "{err:?}");
    }

    #[test]
    fn missing_gm_errors() {
        let (nodes, links, timing) = sample();
        let err = build_timesync_sim_bundle(
            &nodes,
            &links,
            "99",
            &timing,
            &SimOverrides::default(),
            "s1",
            1,
        )
        .unwrap_err();
        assert!(err.iter().any(|e| e.code == "gm_not_found"), "{err:?}");
    }

    #[test]
    fn constant_oscillator_and_overrides_applied() {
        let (nodes, links, timing) = sample();
        let ov = SimOverrides {
            oscillator: OscillatorKind::Constant,
            drift_ppm: Some(50.0),
            sim_time_s: Some(2.5),
        };
        let b = build_timesync_sim_bundle(&nodes, &links, "1", &timing, &ov, "s1", 1).unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(ini.contains("ConstantDriftOscillator"));
        assert!(ini.contains("driftRate = 50ppm"));
        assert!(ini.contains("sim-time-limit = 2.5s"));
    }
}
