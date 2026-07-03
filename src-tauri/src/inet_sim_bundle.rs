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

/// R3(a) 固定默认：取自 INET clockdrift showcase。pub 供 get_sim_defaults 命令读，
/// 让前端覆盖参数摘要/预填有单一事实源（U5/U6）。
pub const DEFAULT_DRIFT_PPM: f64 = 100.0;
pub const DEFAULT_SIM_TIME_S: f64 = 60.0;
const NOMINAL_TICK_LENGTH: &str = "10ns";
/// RandomDriftOscillator 漂移率更新间隔默认（ms，可被覆盖表单改）。
pub const DEFAULT_CHANGE_INTERVAL_MS: f64 = 50.0;
/// RandomDriftOscillator 每次更新的漂移率增量默认（ppm，随机游走步长；可被覆盖表单改）。
/// 这是晶振频率稳定度的代理——决定稳态同步残差；drift_ppm 反而被 gPTP 速率比补偿、几乎不影响偏差。
/// 默认 0.3：HTTP 软仿实测此值稳态偏差 ~30ns、贴合真机（INET showcase 默认 1.0 是为演示放大的劣质晶振）。
pub const DEFAULT_DRIFT_RATE_CHANGE_PPM: f64 = 0.3;
/// RandomDriftOscillator 漂移率随机游走的固定边界（ppm）：initialDriftRate 起点范围 + 上下限。
/// Random 下不暴露给前端——边界对偏差≈0，仅防长仿真漂移率无界增长。
const RANDOM_BOUND_PPM: f64 = 100.0;
const LINK_LENGTH: &str = "10m";
const SEED_SET: u32 = 0;

pub use crate::inet_remote::InetBundle;

/// build_timesync_sim_bundle 产物：bundle + GM 的 ned 名。命令层用 gm_ned_name 按 module 名
/// 精确定位 GM 时间序列（取代脆弱的「值域最小=GM」启发式，code-review correctness/adversarial）。
#[derive(Debug, Clone)]
pub struct TimesyncSimBundle {
    pub bundle: InetBundle,
    pub gm_ned_name: String,
    /// mid → ned 名（sw{N}/es{N}）全量映射。命令层据此把逐节点 offset_threshold 对到
    /// 对应 module 的 timeChanged series（series 按 ned 名 keyed，阈值按 mid keyed，需此桥接）。
    pub node_ned_names: std::collections::BTreeMap<String, String>,
}

/// 802.1Qbv 门控表一项（KTD2b 单一序列化契约，U6 pin / U7 dump 解析 / U8 读回 三处共用）。
/// 单位一律 ns。`node`=mid（app 规范节点身份，与 topology_streams.talker/listener 同一身份）；
/// 写 ini / 解析 dump 时经 node_ned_names 在 mid↔ned 名间转换。键 (node, eth_n, gate_index)
/// 全由 app 掌控（U1 契约③ by construction）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GclEntry {
    pub node: String,
    pub eth_n: usize,
    pub gate_index: usize,
    pub initially_open: bool,
    pub offset_ns: u64,
    pub durations_ns: Vec<u64>,
    pub solver: String,
}

/// 一条流在 flow+TAS bundle 里的规格（U6 生成 app / 流识别 / 约束面共用）。talker/listener=mid。
#[derive(Debug, Clone)]
pub struct FlowStreamSpec {
    pub stream_seq: i64,
    pub class: String,
    pub pcp: i64,
    pub talker: String,
    pub listener: String,
    pub period_us: i64,
    pub frame_bytes: i64,
    /// 期望发送报文数。bundle 不写它（源按 productionInterval 连续发）；U8 verify 收=发
    /// 对账用作期望发送数（真机确认是否需据此界定发送上限）。
    #[allow(dead_code)]
    pub count: i64,
    /// synth 约束面 maxLatency；None → U6 回退取 period_us（U7 会先从 docx 窗口预算填好）。
    pub max_latency_us: Option<i64>,
    /// 显式路径（mid 序列，含 talker/listener）；synth 时喂 configurator pathFragments 绕开
    /// 最短路歧义。None → 省略走最短路。
    pub path_fragments: Option<Vec<String>>,
}

/// 门控排程来源：Synth=跑 Z3 配置器综合（U7）；Pin=写死已综合 GCL（U8）。
#[allow(dead_code)] // 变体由 U7(plan_tas)/U8(verify_tas) 构造。
pub enum FlowTasSchedule<'a> {
    Synth,
    Pin(&'a [GclEntry]),
}

/// UDP app 端口基址（每流唯一端口 = 基址 + 稠密下标）。
const FLOW_APP_PORT_BASE: i64 = 1000;
/// 802.1Q 帧开销（synth 约束面 packetLength 需含：8B UDP+20B IP+4B Q-TAG+14B MAC+4B FCS+8B PHY）。
const FLOW_FRAME_OVERHEAD_BYTES: i64 = 58;

/// 覆盖表单（R4）：振荡器类型 / 漂移幅度 / sim 时长。缺省走 R3(a) 固定默认。
#[derive(Debug, Clone, Default)]
pub struct SimOverrides {
    /// 振荡器类型：Constant（恒定漂移）/ Random（随机漂移，默认）。
    pub oscillator: OscillatorKind,
    /// 漂移幅度（ppm）：Constant 取作恒定 driftRate；Random 不用此值（边界固定）。缺省 100ppm。
    pub drift_ppm: Option<f64>,
    /// Random 专用：漂移率随机游走步长（ppm，晶振稳定度代理）。缺省 1.0。
    pub drift_rate_change_ppm: Option<f64>,
    /// Random 专用：漂移率更新间隔（ms）。缺省 12.5。
    pub change_interval_ms: Option<f64>,
    /// sim 时长（秒）。缺省 60s。
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
    /// 逐节点收敛偏移阈值（纳秒，boss 定语义）。None → 软仿用全局兜底阈值。
    pub offset_threshold_ns: Option<i64>,
}

struct MappedNode {
    ned_name: String,
    ned_type: &'static str,
    /// 节点队列数（来自 topology_nodes.queue_count，默认 8）= INET egress numTrafficClasses。
    queue_count: i64,
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
/// pub(crate)：路由推导（flow_route，U5）与 bundle 共用同一张门号事实源，绝不复制（KTD3）。
pub(crate) fn build_port_eth_map(links: &[VerifyLink]) -> BTreeMap<String, BTreeMap<i64, usize>> {
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

/// 节点类型映射（sw{N}/es{N}）+ GM 存在性 + 链路端口列非 NULL 校验。timesync/flow 共享
/// 同一脚手架前置（U6）。错误集非空即返回，不产 NED。
fn map_and_validate<'a>(
    nodes: &'a [VerifyNode],
    links: &[VerifyLink],
    gm_mid: &str,
) -> Result<BTreeMap<&'a str, MappedNode>, Vec<VerifyError>> {
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
                        queue_count: node.queue_count,
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
                        queue_count: node.queue_count,
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
    Ok(mapped)
}

/// NED submodule + connection 段（KTD3 显式门号 + `ethg[N];` 声明）。timesync/flow 共享。
fn build_submodules_and_connections(
    nodes: &[VerifyNode],
    mapped: &BTreeMap<&str, MappedNode>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    links: &[VerifyLink],
) -> (String, String) {
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
    (submodules, connections)
}

/// network.ned 文本。网络名参数化（timesync=TsnAgentTimesyncNetwork / flow=TsnAgentFlowTasNetwork），
/// 其余（extends TsnNetworkBase、bitrate 默认、submodule/connection 段）共享。
fn build_network_ned(network_name: &str, submodules: &str, connections: &str) -> String {
    format!(
        "package tsnagent.generated;\n\n\
import inet.networks.base.TsnNetworkBase;\n\
import inet.node.ethernet.EthernetLink;\n\
import inet.node.tsn.TsnDevice;\n\
import inet.node.tsn.TsnSwitch;\n\n\
network {network_name} extends TsnNetworkBase\n{{\n\
    parameters:\n\
        *.eth[*].bitrate = default({DEFAULT_DATARATE_MBPS}Mbps);\n\
    submodules:\n{submodules}\
    connections allowunconnected:\n{connections}\
}}\n"
    )
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
    let mapped = map_and_validate(nodes, links, gm_mid)?;
    let port_eth = build_port_eth_map(links);
    let (submodules, connections) =
        build_submodules_and_connections(nodes, &mapped, &port_eth, links);
    let network_ned = build_network_ned("TsnAgentTimesyncNetwork", &submodules, &connections);

    let gm_ned = &mapped[gm_mid].ned_name;
    let omnetpp_ini = build_timesync_ini(&mapped, &port_eth, gm_ned, timing, overrides);

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

    let node_ned_names: BTreeMap<String, String> = mapped
        .iter()
        .map(|(mid, node)| ((*mid).to_string(), node.ned_name.clone()))
        .collect();

    Ok(TimesyncSimBundle {
        gm_ned_name: gm_ned.clone(),
        node_ned_names,
        bundle: InetBundle {
            network_ned,
            omnetpp_ini,
            manifest_json,
        },
    })
}

/// 拼 omnetpp.ini。gPTP 硬性前提 + 振荡器 + referenceClock + recording + seed + 每节点端口角色。
/// 拼 timesync omnetpp.ini = [General] 头 + gPTP 同步块。
fn build_timesync_ini(
    mapped: &BTreeMap<&str, MappedNode>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    gm_ned: &str,
    timing: &[SimNodeTiming],
    overrides: &SimOverrides,
) -> String {
    let sim_time = overrides.sim_time_s.unwrap_or(DEFAULT_SIM_TIME_S);
    let mut ini = build_general_header("tsnagent.generated.TsnAgentTimesyncNetwork", sim_time);
    ini.push_str(&build_sync_block(
        mapped, port_eth, gm_ned, timing, overrides,
    ));
    ini
}

/// [General] 头（网络名 + sim 时长 + gPTP 硬性前提 resolution/seed/cmdenv）。timesync/flow 共享。
fn build_general_header(network_fqn: &str, sim_time_s: f64) -> String {
    let mut ini = String::new();
    ini.push_str("[General]\n");
    ini.push_str(&format!("network = {network_fqn}\n"));
    ini.push_str(&format!("sim-time-limit = {sim_time_s}s\n"));
    // gPTP 硬性前提（R2）。
    ini.push_str("simtime-resolution = fs\n");
    ini.push_str(&format!("seed-set = {SEED_SET}\n"));
    ini.push_str("cmdenv-interactive = false\n");
    ini.push_str("cmdenv-express-mode = true\n");
    ini
}

/// gPTP 同步块：hasTimeSynchronization + 流式收发器 + 振荡器 + referenceClock + clock
/// recording + 每节点 gptp 端口角色。timesync 与 flow 共用（R15 非理想时钟须有同步、否则漂移发散）。
fn build_sync_block(
    mapped: &BTreeMap<&str, MappedNode>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    gm_ned: &str,
    timing: &[SimNodeTiming],
    overrides: &SimOverrides,
) -> String {
    let drift = overrides.drift_ppm.unwrap_or(DEFAULT_DRIFT_PPM);

    let mut ini = String::new();
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
            // changeInterval 必填（无默认，缺则 Cmdenv 停下等输入）。漂移率随机游走：
            // 步长 driftRateChange + 节奏 changeInterval 决定稳态同步残差（晶振稳定度代理，可覆盖）；
            // 起点/上下限用固定 RANDOM_BOUND_PPM（对偏差≈0、被 gPTP 补偿，仅防无界游走），不取 drift_ppm。
            let drc = overrides
                .drift_rate_change_ppm
                .unwrap_or(DEFAULT_DRIFT_RATE_CHANGE_PPM);
            let ci = overrides
                .change_interval_ms
                .unwrap_or(DEFAULT_CHANGE_INTERVAL_MS);
            ini.push_str("**.clock.oscillator.typename = \"RandomDriftOscillator\"\n");
            ini.push_str(&format!("**.clock.oscillator.changeInterval = {ci}ms\n"));
            ini.push_str(&format!(
                "**.clock.oscillator.initialDriftRate = uniform(-{RANDOM_BOUND_PPM}ppm, {RANDOM_BOUND_PPM}ppm)\n"
            ));
            ini.push_str(&format!(
                "**.clock.oscillator.driftRateChange = uniform(-{drc}ppm, {drc}ppm)\n"
            ));
            ini.push_str(&format!(
                "**.clock.oscillator.driftRateChangeLowerLimit = -{RANDOM_BOUND_PPM}ppm\n"
            ));
            ini.push_str(&format!(
                "**.clock.oscillator.driftRateChangeUpperLimit = {RANDOM_BOUND_PPM}ppm\n"
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

/// 流量类：一个 pcp 对应一个 gateIndex（transmissionGate 下标 = 流量类）。
pub(crate) struct FlowClassInfo {
    pub(crate) name: String,
    pub(crate) pcp: i64,
    pub(crate) gate_index: usize,
}

/// 单流在 bundle 里的放置：talker/listener 上的 app 下标、UDP 端口、门下标。
/// pub(crate)：U8 verify 据 listener_app 构造 sink app 的 module 路径匹配 per-stream 向量。
pub(crate) struct FlowPlacement {
    pub(crate) talker_app: usize,
    pub(crate) listener_app: usize,
    pub(crate) port: i64,
    pub(crate) gate_index: usize,
}

/// 从流集算：①流量类表（distinct pcp 升序 → gate_index）②每流放置 ③每节点 app 总数。
/// app 下标 per-node（source app 先、sink app 后，各按 stream_seq）——一个节点可同时是
/// 发端与收端，app 空间不重叠。端口 = 基址 + 全局稠密下标（source destPort == sink localPort）。
/// pub(crate)：U8 verify 复用同一放置逻辑（绝不各算一份、避免 app 下标漂移）。
/// flow-tas 软仿时长（秒）：取各流 count×period 的最大值（至少 1ms）。源按固定间隔持续产包，
/// sim 时长即决定产包数（INET 源无产包上限参数）——据此让产包数≈用户 count。验证侧用相同公式
/// 反推每流实发数（floor(sim/period)+1，含 t=0 包）判丢包，无需服务回传发送计数。
pub(crate) fn flow_sim_time_s(streams: &[FlowStreamSpec]) -> f64 {
    streams
        .iter()
        .map(|s| s.count.max(1) as f64 * s.period_us as f64 / 1_000_000.0)
        .fold(0.0_f64, f64::max)
        .max(0.001)
}

/// 某流在给定 sim 时长下的确定性产包数：floor(sim/period)+1（源在 t=0 也产一个）。
pub(crate) fn flow_expected_sent(sim_time_s: f64, period_us: i64) -> i64 {
    let period_s = period_us.max(1) as f64 / 1_000_000.0;
    (sim_time_s / period_s).floor() as i64 + 1
}

pub(crate) fn plan_flow_traffic(
    streams: &[FlowStreamSpec],
) -> (
    Vec<FlowClassInfo>,
    Vec<FlowPlacement>,
    BTreeMap<String, usize>,
) {
    let mut order: Vec<usize> = (0..streams.len()).collect();
    order.sort_by_key(|&i| streams[i].stream_seq);

    // gate_index = pcp（INET PcpTrafficClassClassifier 默认 pcp→traffic class 恒等映射）：
    // 每条流的门下标就是它的 PCP，交换机开满 queue_count 个门（见 numTrafficClasses）。这样
    // ST(pcp7)→gate7 由 Z3 排，而 gPTP 等控制流量走各自的 PCP 门（默认恒开、Z3 不排），不会
    // 被塞进 ST 的受控门里挨延迟致时钟伺服发散（真机实证）。class 名取该 pcp 首条流的 class。
    let mut pcps: Vec<i64> = streams.iter().map(|s| s.pcp).collect();
    pcps.sort_unstable();
    pcps.dedup();
    let classes: Vec<FlowClassInfo> = pcps
        .iter()
        .map(|&pcp| FlowClassInfo {
            name: streams
                .iter()
                .find(|s| s.pcp == pcp)
                .map(|s| s.class.clone())
                .unwrap_or_default(),
            pcp,
            gate_index: pcp as usize,
        })
        .collect();
    let gate_of_pcp = |pcp: i64| pcp as usize;

    // 每节点 source / sink 流（stream_seq 序）。
    let mut src_of: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut snk_of: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for &i in &order {
        src_of.entry(streams[i].talker.clone()).or_default().push(i);
        snk_of
            .entry(streams[i].listener.clone())
            .or_default()
            .push(i);
    }

    let mut talker_app_of = vec![0usize; streams.len()];
    let mut listener_app_of = vec![0usize; streams.len()];
    let mut node_apps: BTreeMap<String, usize> = BTreeMap::new();
    for (node, src) in &src_of {
        for (k, &i) in src.iter().enumerate() {
            talker_app_of[i] = k;
        }
        *node_apps.entry(node.clone()).or_insert(0) += src.len();
    }
    for (node, snk) in &snk_of {
        let base = src_of.get(node).map_or(0, |v| v.len());
        for (k, &i) in snk.iter().enumerate() {
            listener_app_of[i] = base + k;
        }
        *node_apps.entry(node.clone()).or_insert(0) += snk.len();
    }

    let mut placements_opt: Vec<Option<FlowPlacement>> = Vec::new();
    placements_opt.resize_with(streams.len(), || None);
    for (dense, &i) in order.iter().enumerate() {
        placements_opt[i] = Some(FlowPlacement {
            talker_app: talker_app_of[i],
            listener_app: listener_app_of[i],
            port: FLOW_APP_PORT_BASE + dense as i64,
            gate_index: gate_of_pcp(streams[i].pcp),
        });
    }
    let placements: Vec<FlowPlacement> = placements_opt
        .into_iter()
        .map(|p| p.expect("placement for every stream"))
        .collect();

    (classes, placements, node_apps)
}

/// 拼 flow+TAS omnetpp.ini：[General] 头 + gPTP 同步块（R15 非理想时钟共享 build_sync_block），
/// 再叠流量 app / 流识别 / 出口整形（R14）与门控段（synth=Z3 配置器 / pin=写死 GCL）。
/// 语法照 U6 spike 钉死的 SAT showcase。
#[allow(clippy::too_many_arguments)]
fn build_flow_tas_ini(
    mapped: &BTreeMap<&str, MappedNode>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    gm_ned: &str,
    timing: &[SimNodeTiming],
    overrides: &SimOverrides,
    streams: &[FlowStreamSpec],
    schedule: FlowTasSchedule,
) -> String {
    // sim 时长按流量推导（非固定 60s）：INET ActivePacketSource 无「产 N 个就停」参数、按
    // productionInterval 持续产包直到 sim 结束，故 sim 时长决定产包数。取各流 count×period 最大值
    // → 源产包数≈count（验证侧按可算的实发数判丢包，见 flow_verify_command）。允许 overrides 覆盖。
    let sim_time = overrides
        .sim_time_s
        .unwrap_or_else(|| flow_sim_time_s(streams));
    let mut ini = build_general_header("tsnagent.generated.TsnAgentFlowTasNetwork", sim_time);
    ini.push_str(&build_sync_block(
        mapped, port_eth, gm_ned, timing, overrides,
    ));
    ini.push('\n');

    let (classes, placements, node_apps) = plan_flow_traffic(streams);
    let ned = |mid: &str| -> String {
        mapped
            .get(mid)
            .map_or_else(|| mid.to_string(), |m| m.ned_name.clone())
    };

    // stream_seq 稳定序 + per-talker / per-listener 分组。
    let mut order: Vec<usize> = (0..streams.len()).collect();
    order.sort_by_key(|&i| streams[i].stream_seq);
    let mut talker_streams: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    let mut listener_streams: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for &i in &order {
        talker_streams
            .entry(streams[i].talker.as_str())
            .or_default()
            .push(i);
        listener_streams
            .entry(streams[i].listener.as_str())
            .or_default()
            .push(i);
    }

    // 编码/解码映射（各节点相同）：class 名 ↔ pcp。
    let encoder_map = classes
        .iter()
        .map(|c| format!("{{stream: \"{}\", pcp: {}}}", c.name, c.pcp))
        .collect::<Vec<_>>()
        .join(", ");
    let decoder_map = classes
        .iter()
        .map(|c| format!("{{pcp: {}, stream: \"{}\"}}", c.pcp, c.name))
        .collect::<Vec<_>>()
        .join(", ");

    // --- numApps（每节点一次，含既发又收的节点）---
    for (node, count) in &node_apps {
        ini.push_str(&format!("*.{}.numApps = {count}\n", ned(node)));
    }

    // --- 源 app（UdpSourceApp）---
    for (talker, sidx) in &talker_streams {
        let tned = ned(talker);
        for &i in sidx {
            let s = &streams[i];
            let p = &placements[i];
            let a = p.talker_app;
            let lned = ned(&s.listener);
            ini.push_str(&format!("*.{tned}.app[{a}].typename = \"UdpSourceApp\"\n"));
            ini.push_str(&format!("*.{tned}.app[{a}].io.destAddress = \"{lned}\"\n"));
            ini.push_str(&format!("*.{tned}.app[{a}].io.destPort = {}\n", p.port));
            ini.push_str(&format!(
                "*.{tned}.app[{a}].source.packetLength = {}B\n",
                s.frame_bytes
            ));
            ini.push_str(&format!(
                "*.{tned}.app[{a}].source.productionInterval = {}us\n",
                s.period_us
            ));
            ini.push_str(&format!(
                "*.{tned}.app[{a}].source.packetNameFormat = \"%M-%m-%c\"\n"
            ));
        }
    }

    // --- 汇 app（UdpSinkApp）---
    for (listener, sidx) in &listener_streams {
        let lned = ned(listener);
        for &i in sidx {
            let p = &placements[i];
            ini.push_str(&format!(
                "*.{lned}.app[{}].typename = \"UdpSinkApp\"\n",
                p.listener_app
            ));
            ini.push_str(&format!(
                "*.{lned}.app[{}].io.localPort = {}\n",
                p.listener_app, p.port
            ));
        }
    }

    // --- 流识别 + 编码（talker 出流）---
    for (talker, sidx) in &talker_streams {
        let tned = ned(talker);
        ini.push_str(&format!("*.{tned}.hasOutgoingStreams = true\n"));
        let ident = sidx
            .iter()
            .map(|&i| {
                // udp != nullptr 守卫：本节点开了 gPTP（hasTimeSynchronization，MASTER/SLAVE 皆
                // 生成无 UDP 头的 gPTP 控制包），会流经 streamIdentifier 对每个包求 packetFilter。
                // 裸 udp.destPort 在 gPTP 包上 → udp=nullptr → .destPort 崩（eval_error）。INET 自带
                // showcase 的 talker 都关了时间同步故无此坑；我们的流 talker 带 gPTP，须短路守卫。
                format!(
                    "{{stream: \"{}\", packetFilter: expr(udp != nullptr && udp.destPort == {})}}",
                    streams[i].class, placements[i].port
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        ini.push_str(&format!(
            "*.{tned}.bridging.streamIdentifier.identifier.mapping = [{ident}]\n"
        ));
        ini.push_str(&format!(
            "*.{tned}.bridging.streamCoder.encoder.mapping = [{encoder_map}]\n"
        ));
    }

    // --- 交换机：收发流 + 解码/编码 + 出口整形（R14）+ 队列/门 ---
    // numTrafficClasses 取节点 queue_count（默认 8=PCP 全空间），每 PCP 一个门：ST(pcp7)→gate7
    // 由 Z3 排，其余 PCP 门（含 gPTP/控制）默认恒开、Z3 不排——避免控制流量被 ST 门延迟致时钟发散。
    for m in mapped.values() {
        if m.ned_type != "TsnSwitch" {
            continue;
        }
        let sw = &m.ned_name;
        ini.push_str(&format!("*.{sw}.hasIncomingStreams = true\n"));
        ini.push_str(&format!("*.{sw}.hasOutgoingStreams = true\n"));
        ini.push_str(&format!(
            "*.{sw}.bridging.streamCoder.decoder.mapping = [{decoder_map}]\n"
        ));
        ini.push_str(&format!(
            "*.{sw}.bridging.streamCoder.encoder.mapping = [{encoder_map}]\n"
        ));
        ini.push_str(&format!("*.{sw}.hasEgressTrafficShaping = true\n"));
        ini.push_str(&format!(
            "*.{sw}.eth[*].macLayer.queue.numTrafficClasses = {}\n",
            m.queue_count
        ));
        for c in &classes {
            ini.push_str(&format!(
                "*.{sw}.eth[*].macLayer.queue.queue[{}].display-name = \"{}\"\n",
                c.gate_index, c.name
            ));
        }
    }

    // --- listener 收流 ---
    for listener in listener_streams.keys() {
        ini.push_str(&format!("*.{}.hasIncomingStreams = true\n", ned(listener)));
    }

    // --- 门控段 ---
    match schedule {
        FlowTasSchedule::Synth => {
            ini.push_str("*.gateScheduleConfigurator.typename = \"Z3GateScheduleConfigurator\"\n");
            ini.push_str("*.gateScheduleConfigurator.gateCycleDuration = 1ms\n");
            let entries = order
                .iter()
                .map(|&i| {
                    let s = &streams[i];
                    let p = &placements[i];
                    let max_latency = s.max_latency_us.unwrap_or(s.period_us);
                    let mut e = format!(
                        "{{pcp: {}, gateIndex: {}, application: \"app[{}]\", source: \"{}\", destination: \"{}\", packetLength: {}B + {}B, packetInterval: {}us, maxLatency: {}us",
                        s.pcp,
                        p.gate_index,
                        p.talker_app,
                        ned(&s.talker),
                        ned(&s.listener),
                        s.frame_bytes,
                        FLOW_FRAME_OVERHEAD_BYTES,
                        s.period_us,
                        max_latency
                    );
                    if let Some(path) = &s.path_fragments {
                        let hops = path
                            .iter()
                            .map(|mid| format!("\"{}\"", ned(mid)))
                            .collect::<Vec<_>>()
                            .join(", ");
                        e.push_str(&format!(", pathFragments: [[{hops}]]"));
                    }
                    e.push('}');
                    e
                })
                .collect::<Vec<_>>()
                .join(",\n     ");
            ini.push_str(&format!(
                "*.gateScheduleConfigurator.configuration =\n    [{entries}]\n"
            ));
        }
        FlowTasSchedule::Pin(gcl) => {
            // 不声明 gateScheduleConfigurator.typename（保持 ""=不实例化）→ 门参数直接生效。
            for g in gcl {
                let node = ned(&g.node);
                let base = format!(
                    "*.{node}.eth[{}].macLayer.queue.transmissionGate[{}]",
                    g.eth_n, g.gate_index
                );
                ini.push_str(&format!(
                    "{base}.initiallyOpen = {}\n",
                    if g.initially_open { "true" } else { "false" }
                ));
                ini.push_str(&format!("{base}.offset = {}ns\n", g.offset_ns));
                let durs = g
                    .durations_ns
                    .iter()
                    .map(|d| format!("{d}ns"))
                    .collect::<Vec<_>>()
                    .join(", ");
                ini.push_str(&format!("{base}.durations = [{durs}]\n"));
                // 关隐式保护带：Z3 门窗是零余量（开窗=正好一帧传输时间），而 enableImplicitGuardBand
                // 默认 true 会禁止「发不完就不许进本窗」的帧——包恰好卡在窗边界即被拒、滑到下一周期
                // (+一个门周期≈500us)。Z3 已保证帧在窗内放得下，此处关掉这层运行时严格边界检查，
                // honor Z3 排程。真机实证：关掉后 6 跳链时延 527us→27.66us、漂移尾巴消失。
                ini.push_str(&format!("{base}.enableImplicitGuardBand = false\n"));
            }
        }
    }

    ini
}

/// 把库内拓扑 + 流集 + 门控排程序列化成 flow+TAS 软仿 bundle。复用 timesync 的节点映射 /
/// 门号 / NED 脚手架 / gPTP 同步块，仅 fork ini 的流量/门控段 + 网络名 + caliber（U6）。
/// `schedule=Synth` 给 U7 跑 Z3 综合；`Pin(gcl)` 给 U8 pin 已综合 GCL 软仿。
#[allow(clippy::too_many_arguments)]
#[allow(dead_code)] // U7(plan_tas)/U8(verify_tas) 消费；连带把 GclEntry/FlowStreamSpec/FlowTasSchedule 标 live。
pub fn build_flow_tas_sim_bundle(
    nodes: &[VerifyNode],
    links: &[VerifyLink],
    gm_mid: &str,
    timing: &[SimNodeTiming],
    overrides: &SimOverrides,
    streams: &[FlowStreamSpec],
    schedule: FlowTasSchedule,
    session_id: &str,
    source_mutation_id: i64,
) -> Result<TimesyncSimBundle, Vec<VerifyError>> {
    let mapped = map_and_validate(nodes, links, gm_mid)?;
    let port_eth = build_port_eth_map(links);
    let (submodules, connections) =
        build_submodules_and_connections(nodes, &mapped, &port_eth, links);
    let network_ned = build_network_ned("TsnAgentFlowTasNetwork", &submodules, &connections);

    let gm_ned = &mapped[gm_mid].ned_name;
    let omnetpp_ini = build_flow_tas_ini(
        &mapped, &port_eth, gm_ned, timing, overrides, streams, schedule,
    );

    let manifest = serde_json::json!({
        "schemaVersion": "tsn-agent.export-manifest.v0",
        "sessionId": session_id,
        "sourceMutationId": source_mutation_id,
        "caliber": "flow_tas_simulated",
        "gmMid": gm_mid,
        "files": [
            { "path": "tsnagent/generated/network.ned", "purpose": "simulation-inet", "label": "INET 流量+TAS 软仿拓扑" },
            { "path": "omnetpp.ini", "purpose": "simulation-inet", "label": "INET 流量+TAS 软仿运行配置" }
        ]
    });
    let manifest_json =
        serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".to_string());

    let node_ned_names: BTreeMap<String, String> = mapped
        .iter()
        .map(|(mid, node)| ((*mid).to_string(), node.ned_name.clone()))
        .collect();

    Ok(TimesyncSimBundle {
        gm_ned_name: gm_ned.clone(),
        node_ned_names,
        bundle: InetBundle {
            network_ned,
            omnetpp_ini,
            manifest_json,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(mid: &str, ty: &str) -> VerifyNode {
        VerifyNode {
            mid: mid.into(),
            name: None,
            node_type: Some(ty.into()),
            queue_count: 8,
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
                offset_threshold_ns: None,
            },
            // sw0：master 端口 5、2；slave 端口朝 GM = 5。
            SimNodeTiming {
                mid: "0".into(),
                master_port: vec![2],
                slave_port: vec![5],
                sync_period_ms: None,
                measure_period_ms: None,
                offset_threshold_ns: None,
            },
            SimNodeTiming {
                mid: "2".into(),
                master_port: vec![],
                slave_port: vec![0],
                sync_period_ms: None,
                measure_period_ms: None,
                offset_threshold_ns: None,
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
        // node_ned_names 全量映射（U7：命令层据此把逐节点阈值对到对应 series）。
        // sample：GM mid"1"→es1、switch mid"0"→sw1、mid"2"→es2。
        assert_eq!(b.node_ned_names.get("0").map(String::as_str), Some("sw1"));
        assert_eq!(b.node_ned_names.get("1").map(String::as_str), Some("es1"));
        assert_eq!(b.node_ned_names.get("2").map(String::as_str), Some("es2"));
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
            ini.contains("**.clock.oscillator.changeInterval = 50ms"),
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
            drift_rate_change_ppm: None,
            change_interval_ms: None,
            sim_time_s: Some(2.5),
        };
        let b = build_timesync_sim_bundle(&nodes, &links, "1", &timing, &ov, "s1", 1).unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(ini.contains("ConstantDriftOscillator"));
        assert!(ini.contains("driftRate = 50ppm"));
        assert!(ini.contains("sim-time-limit = 2.5s"));
    }

    #[test]
    fn random_oscillator_drift_rate_change_and_interval_applied() {
        let (nodes, links, timing) = sample();
        let ov = SimOverrides {
            oscillator: OscillatorKind::Random,
            drift_ppm: Some(20.0), // Random 下忽略：边界用固定 RANDOM_BOUND_PPM，不取此值。
            drift_rate_change_ppm: Some(0.3),
            change_interval_ms: Some(25.0),
            sim_time_s: None,
        };
        let b = build_timesync_sim_bundle(&nodes, &links, "1", &timing, &ov, "s1", 1).unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(ini.contains("RandomDriftOscillator"));
        // 覆盖的步长与间隔进 ini。
        assert!(
            ini.contains("**.clock.oscillator.driftRateChange = uniform(-0.3ppm, 0.3ppm)"),
            "{ini}"
        );
        assert!(
            ini.contains("**.clock.oscillator.changeInterval = 25ms"),
            "{ini}"
        );
        // drift_ppm(20) 不进 Random 的边界：起点/上下限固定 100ppm。
        assert!(
            ini.contains("initialDriftRate = uniform(-100ppm, 100ppm)"),
            "{ini}"
        );
        assert!(ini.contains("driftRateChangeUpperLimit = 100ppm"), "{ini}");
        assert!(
            !ini.contains("20ppm"),
            "Random 不该出现 drift_ppm=20：{ini}"
        );
    }

    // R23 golden fixture：timesync 模式 NED + INI 在「抽 mode 重构」前后字节一致。
    // 基线在重构前用 sample() 实跑捕获（见 U6 commit）；此后任何改动改变 timesync 输出即红。
    const GOLDEN_TIMESYNC_NED: &str = "package tsnagent.generated;\n\nimport inet.networks.base.TsnNetworkBase;\nimport inet.node.ethernet.EthernetLink;\nimport inet.node.tsn.TsnDevice;\nimport inet.node.tsn.TsnSwitch;\n\nnetwork TsnAgentTimesyncNetwork extends TsnNetworkBase\n{\nparameters:\n*.eth[*].bitrate = default(1000Mbps);\nsubmodules:\n        sw1: TsnSwitch {\n            gates:\n                ethg[2];\n        }\n        es1: TsnDevice {\n            gates:\n                ethg[1];\n        }\n        es2: TsnDevice {\n            gates:\n                ethg[1];\n        }\nconnections allowunconnected:\n        sw1.ethg[1] <--> EthernetLink { datarate = 1000Mbps; length = 10m; } <--> es1.ethg[0];\n        sw1.ethg[0] <--> EthernetLink { datarate = 1000Mbps; length = 10m; } <--> es2.ethg[0];\n}\n";
    const GOLDEN_TIMESYNC_INI: &str = "[General]\nnetwork = tsnagent.generated.TsnAgentTimesyncNetwork\nsim-time-limit = 60s\nsimtime-resolution = fs\nseed-set = 0\ncmdenv-interactive = false\ncmdenv-express-mode = true\n*.*.hasTimeSynchronization = true\n**.transmitter.typename = \"StreamingTransmitter\"\n**.receiver.typename = \"DestreamingReceiver\"\n**.clock.oscillator.typename = \"RandomDriftOscillator\"\n**.clock.oscillator.changeInterval = 50ms\n**.clock.oscillator.initialDriftRate = uniform(-100ppm, 100ppm)\n**.clock.oscillator.driftRateChange = uniform(-0.3ppm, 0.3ppm)\n**.clock.oscillator.driftRateChangeLowerLimit = -100ppm\n**.clock.oscillator.driftRateChangeUpperLimit = 100ppm\n**.clock.oscillator.nominalTickLength = 10ns\n**.referenceClock = \"es1.clock\"\n**.clock.result-recording-modes = +vector\n\n*.es1.gptp.gptpNodeType = \"MASTER_NODE\"\n*.es1.gptp.masterPorts = [\"eth0\"]\n*.es1.gptp.slavePort = \"\"\n*.es1.gptp.syncInterval = 125ms\n*.es1.gptp.pdelayInterval = 1000ms\n*.sw1.gptp.gptpNodeType = \"BRIDGE_NODE\"\n*.sw1.gptp.masterPorts = [\"eth0\"]\n*.sw1.gptp.slavePort = \"eth1\"\n*.es2.gptp.gptpNodeType = \"SLAVE_NODE\"\n*.es2.gptp.masterPorts = []\n*.es2.gptp.slavePort = \"eth0\"\n";

    #[test]
    fn golden_timesync_byte_identical() {
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
        assert_eq!(
            b.bundle.network_ned, GOLDEN_TIMESYNC_NED,
            "timesync NED 抽 mode 重构后字节漂移（R23）"
        );
        assert_eq!(
            b.bundle.omnetpp_ini, GOLDEN_TIMESYNC_INI,
            "timesync INI 抽 mode 重构后字节漂移（R23）"
        );
    }

    /// 两条流：ST(pcp7) es1→es2、BE(pcp0) es1→es2。
    fn flow_streams() -> Vec<FlowStreamSpec> {
        vec![
            FlowStreamSpec {
                stream_seq: 0,
                class: "BE".into(),
                pcp: 0,
                talker: "1".into(),   // es1
                listener: "2".into(), // es2
                period_us: 500,
                frame_bytes: 1000,
                count: 1000,
                max_latency_us: None,
                path_fragments: None,
            },
            FlowStreamSpec {
                stream_seq: 1,
                class: "ST".into(),
                pcp: 7,
                talker: "1".into(),
                listener: "2".into(),
                period_us: 250,
                frame_bytes: 500,
                count: 10000,
                max_latency_us: Some(300),
                path_fragments: Some(vec!["1".into(), "0".into(), "2".into()]),
            },
        ]
    }

    /// pin 模式：写死 GCL → transmissionGate 参数逐值写入；配置器不实例化。
    #[test]
    fn flow_pin_mode_writes_gate_params_no_configurator() {
        let (nodes, links, timing) = sample();
        let gcl = vec![GclEntry {
            node: "0".into(), // sw1
            eth_n: 0,
            gate_index: 1,
            initially_open: true,
            offset_ns: 100,
            durations_ns: vec![500_000, 500_000],
            solver: "Z3".into(),
        }];
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            &flow_streams(),
            FlowTasSchedule::Pin(&gcl),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(
            ini.contains("*.sw1.hasEgressTrafficShaping = true"),
            "{ini}"
        );
        assert!(
            ini.contains(
                "*.sw1.eth[0].macLayer.queue.transmissionGate[1].durations = [500000ns, 500000ns]"
            ),
            "{ini}"
        );
        assert!(
            ini.contains("*.sw1.eth[0].macLayer.queue.transmissionGate[1].offset = 100ns"),
            "{ini}"
        );
        assert!(
            !ini.contains("Z3GateScheduleConfigurator"),
            "pin 模式不得实例化配置器：{ini}"
        );
        // 零余量门窗须关隐式保护带，否则包卡窗边界被拒、滑一个门周期（真机 527us→27us）。
        assert!(
            ini.contains(
                "*.sw1.eth[0].macLayer.queue.transmissionGate[1].enableImplicitGuardBand = false"
            ),
            "{ini}"
        );
        // 网络名切到 flow。
        assert!(
            b.bundle
                .network_ned
                .contains("network TsnAgentFlowTasNetwork extends TsnNetworkBase"),
            "{}",
            b.bundle.network_ned
        );
        // 门向量声明仍在（KTD3）。
        assert!(
            b.bundle.network_ned.contains("ethg[2];"),
            "{}",
            b.bundle.network_ned
        );
    }

    /// synth 模式：Z3 配置器 + configuration 数组（含 +58B 开销、ST pcp7、pathFragments）。
    #[test]
    fn flow_synth_mode_emits_z3_configurator() {
        let (nodes, links, timing) = sample();
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            &flow_streams(),
            FlowTasSchedule::Synth,
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(
            ini.contains("*.gateScheduleConfigurator.typename = \"Z3GateScheduleConfigurator\""),
            "{ini}"
        );
        assert!(
            ini.contains("*.gateScheduleConfigurator.configuration ="),
            "{ini}"
        );
        assert!(
            ini.contains("packetLength: 500B + 58B"),
            "ST 报文含 +58B 开销：{ini}"
        );
        assert!(ini.contains("pcp: 7"), "{ini}");
        assert!(
            ini.contains("maxLatency: 300us"),
            "ST 用覆盖的 maxLatency：{ini}"
        );
        // 显式路径喂 pathFragments（NED 名）。
        assert!(
            ini.contains("pathFragments: [[\"es1\", \"sw1\", \"es2\"]]"),
            "{ini}"
        );
    }

    /// 流量类映射：ST(pcp7)+BE(pcp0) → numTrafficClasses=2；BE(pcp0)→gate0、ST(pcp7)→gate1。
    #[test]
    fn flow_traffic_class_mapping() {
        let (nodes, links, timing) = sample();
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            &flow_streams(),
            FlowTasSchedule::Synth,
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        // numTrafficClasses = 节点 queue_count（sample 节点为 8），非流类别数——每 PCP 一个门。
        assert!(
            ini.contains("*.sw1.eth[*].macLayer.queue.numTrafficClasses = 8"),
            "{ini}"
        );
        // encoder 两类都在。
        assert!(ini.contains("{stream: \"BE\", pcp: 0}"), "{ini}");
        assert!(ini.contains("{stream: \"ST\", pcp: 7}"), "{ini}");
        // gate_index = pcp：BE(pcp0)→gate0、ST(pcp7)→gate7。
        assert!(ini.contains("queue[0].display-name = \"BE\""), "{ini}");
        assert!(ini.contains("queue[7].display-name = \"ST\""), "{ini}");
        // synth configuration 里 ST 的 gateIndex=7、BE 的 gateIndex=0。
        assert!(ini.contains("pcp: 7, gateIndex: 7"), "{ini}");
        assert!(ini.contains("pcp: 0, gateIndex: 0"), "{ini}");
    }

    /// sim 时长按 count×period 推导（取最大流），最少 1ms；expected_sent = floor(sim/period)+1。
    #[test]
    fn sim_time_and_expected_sent_from_count_period() {
        let streams = vec![
            FlowStreamSpec {
                stream_seq: 0,
                class: "ST".into(),
                pcp: 7,
                talker: "1".into(),
                listener: "2".into(),
                period_us: 500,
                frame_bytes: 512,
                count: 10000,
                max_latency_us: None,
                path_fragments: None,
            },
            FlowStreamSpec {
                stream_seq: 1,
                class: "BE".into(),
                pcp: 0,
                talker: "1".into(),
                listener: "2".into(),
                period_us: 1000,
                frame_bytes: 512,
                count: 100,
                max_latency_us: None,
                path_fragments: None,
            },
        ];
        // 最大流 10000×500us=5s；BE 100×1000us=0.1s → 取 5s。
        assert!((flow_sim_time_s(&streams) - 5.0).abs() < 1e-9);
        // 5s 下：ST(500us) 产 10001；BE(1000us) 产 5001（远超其 count=100，故须按 sim 反推非 count）。
        assert_eq!(flow_expected_sent(5.0, 500), 10001);
        assert_eq!(flow_expected_sent(5.0, 1000), 5001);
        // 空流兜底 ≥1ms。
        assert!((flow_sim_time_s(&[]) - 0.001).abs() < 1e-9);
    }

    /// 流识别 packetFilter 必须带 udp != nullptr 短路守卫：talker 开了 gPTP，无 UDP 头的 gPTP
    /// 控制包会流经 streamIdentifier，裸 udp.destPort 会在其上求空指针成员而崩（真机 eval_error）。
    #[test]
    fn stream_filter_guards_against_non_udp_packets() {
        let (nodes, links, timing) = sample();
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            &flow_streams(),
            FlowTasSchedule::Synth,
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        // 守卫形态在。
        assert!(
            ini.contains("packetFilter: expr(udp != nullptr && udp.destPort =="),
            "{ini}"
        );
        // 裸形态（expr( 紧跟 udp.destPort）不得再出现——回归哨兵。
        assert!(!ini.contains("expr(udp.destPort"), "{ini}");
    }
}
