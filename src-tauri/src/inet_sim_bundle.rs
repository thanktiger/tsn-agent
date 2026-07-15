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

use crate::flow_route::Route;
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
/// 单位一律 ns。`node`=mid（app 规范节点身份，与 flow_streams.talker/listener 同一身份）；
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
    /// FRER trees（U4，verify RC 会话装配设置）：每棵树一条 mid 路径（含 talker/listener）。
    /// ST 单树（平面 A）、RC 双树（A/B）；None（BE / 非 RC 会话）→ 不进 streamRedundancyConfigurator。
    pub frer_trees: Option<Vec<Vec<String>>>,
    /// 无 RC 双平面会话的平面 A 路径 link_seqs（U4 转发钉死用，spike 押注⑤）。None → 不参与钉死。
    pub pin_links: Option<Vec<i64>>,
}

/// 门控排程来源：Synth=跑 Z3 配置器综合（U7）；Pin=写死已综合 GCL（U8）。
#[allow(dead_code)] // 变体由 U7(plan_tas)/U8(verify_tas) 构造。
pub enum FlowTasSchedule<'a> {
    Synth,
    /// `Pin(gcl, routes)`：`routes`=每条 ST/BE 流的 `(stream_seq, Route)`（KTD13 转发钉死用，
    /// 空 slice=不钉死）。含 RC 会话由调用方传空 routes（现状 FRER 单写入者，见 KTD3）。
    Pin(&'a [GclEntry], &'a [(i64, Route)]),
}

/// UDP app 端口基址（每流唯一端口 = 基址 + 稠密下标）。
const FLOW_APP_PORT_BASE: i64 = 1000;
/// 802.1Q 帧开销（synth 约束面 packetLength 需含：8B UDP+20B IP+4B Q-TAG+14B MAC+4B FCS+8B PHY）。
const FLOW_FRAME_OVERHEAD_BYTES: i64 = 58;
/// 802.1R R-TAG 开销：FRER 会话下经 streamRedundancyConfigurator 的流（含单树 ST）帧上多 4B。
const FLOW_FRAME_RTAG_BYTES: i64 = 4;

/// 帧开销选择（U4/spike）：有 RC 的会话 58B→62B（+4B R-TAG）——Z3 packetLength 与 U5 关窗
/// 算术共用（spike 实证：512B 帧 4592ns > 4560ns，零余量窗不计 R-TAG 必跨窗）。
pub(crate) fn flow_frame_overhead_bytes(has_rc: bool) -> i64 {
    FLOW_FRAME_OVERHEAD_BYTES + if has_rc { FLOW_FRAME_RTAG_BYTES } else { 0 }
}

/// 门控周期（ns）：由录入闸的 `flow_verify::GATE_CYCLE_US` 单一源推导（×1000，消除双定义
/// 漂移），与 synth 段 `gateCycleDuration = 1ms` 同一周期（U5 互补关窗按此取补）。
pub(crate) const GATE_CYCLE_NS: u64 = crate::flow_verify::GATE_CYCLE_US as u64 * 1_000;
/// 以太网 MTU（载荷字节）：补集最长连续开窗须容得下一个 MTU 帧的发送时长，否则低优先级门永久锁死。
const MTU_BYTES: i64 = 1500;
/// 补集门条目的 solver 标识（U5/KTD5）：pin 写参时据此**不写** enableImplicitGuardBand
/// （保持 INET 默认 true——帧发不完不许进窗，天然防低优先级帧跨入 ST 窗）；ST 门维持显式 false。
pub(crate) const COMPLEMENT_SOLVER: &str = "complement";

/// 从 initiallyOpen/offset/durations 还原一条 GCL 的开窗区间（绝对时间，[0,cycle) 内，跨界拆两段）。
/// INET PeriodicGate 语义：t=0 时排程已前进 offset，即 state(t) = seq((t + offset) mod cycle)，
/// 故序列坐标 p 的开窗落在绝对时间 (p - offset) mod cycle。durations 空 → 恒 initiallyOpen；
/// durations 总和 ≠ 门控周期 → 响亮 Err（无法按 1ms 周期取补）。
/// pub(crate)：门控位图合成（flow_plan_command U2）复用同一区间展开，绝不各算一份。
pub(crate) fn gcl_open_intervals(g: &GclEntry) -> Result<Vec<(u64, u64)>, VerifyError> {
    if g.durations_ns.is_empty() {
        return Ok(if g.initially_open {
            vec![(0, GATE_CYCLE_NS)]
        } else {
            vec![]
        });
    }
    let total: u64 = g.durations_ns.iter().sum();
    if total != GATE_CYCLE_NS {
        return Err(VerifyError {
            code: "gcl_cycle_mismatch".to_string(),
            message_zh: format!(
                "端口 {} eth{} 的 ST 门表周期 {total}ns ≠ 门控周期 {GATE_CYCLE_NS}ns，无法推导互补关窗。",
                g.node, g.eth_n
            ),
            node_ref: Some(g.node.clone()),
        });
    }
    let off = g.offset_ns % GATE_CYCLE_NS;
    let mut open = g.initially_open;
    let mut pos = 0u64;
    let mut out: Vec<(u64, u64)> = Vec::new();
    for &d in &g.durations_ns {
        if open && d > 0 {
            let start = (pos + GATE_CYCLE_NS - off) % GATE_CYCLE_NS;
            if start + d <= GATE_CYCLE_NS {
                out.push((start, start + d));
            } else {
                // offset 回绕：开窗跨周期边界，拆成尾段 + 头段。
                out.push((start, GATE_CYCLE_NS));
                out.push((0, start + d - GATE_CYCLE_NS));
            }
        }
        pos += d;
        open = !open;
    }
    Ok(out)
}

/// 互补关窗推导（U5，R8/KTD5，纯函数）：从 pin 的 ST 门条目（gate_index==ST_PCP）按 (node, eth_n)
/// 分组，取 ST 开窗区间并集（mod 1ms 门控周期）的补集，对该端口全部非 ST 门（0..queue_count
/// 除 ST pcp）各生成一条补集 GclEntry（solver=COMPLEMENT_SOLVER）。
/// - 仅在会话存在 BE/RC 流时生成（KTD5）：纯 ST 会话返回空集，pin ini 与现状位级一致。
/// - 无 ST 窗的端口不生成条目（各门恒开，R8）；ST 门恒关（无开窗）同样跳过——无窗可防。
/// - 响亮 Err：端口被 ST 占满 / 补集最长连续开窗（环回计）容不下一个 MTU 帧（MTU+帧开销在
///   端口速率下的发送时长，帧开销经 flow_frame_overhead_bytes(has_rc) 含 R-TAG）/
///   ST 门下标超出节点 queue_count（门表与节点配置矛盾）。
pub(crate) fn complement_gcl(
    pinned: &[GclEntry],
    queue_counts: &BTreeMap<String, i64>,
    port_rates: &BTreeMap<(String, usize), u32>,
    has_rc: bool,
    has_be: bool,
) -> Result<Vec<GclEntry>, VerifyError> {
    if !has_rc && !has_be {
        return Ok(vec![]);
    }
    let st_gate = crate::flow_verify::ST_PCP as usize;
    let mut ports: BTreeMap<(String, usize), Vec<&GclEntry>> = BTreeMap::new();
    for g in pinned.iter().filter(|g| g.gate_index == st_gate) {
        ports.entry((g.node.clone(), g.eth_n)).or_default().push(g);
    }
    let overhead = flow_frame_overhead_bytes(has_rc);
    let mut out: Vec<GclEntry> = Vec::new();
    for ((node, eth_n), entries) in ports {
        let Some(&qc) = queue_counts.get(&node) else {
            return Err(VerifyError {
                code: "gcl_node_unmapped".to_string(),
                message_zh: format!("GCL 条目引用的节点 {node} 不在拓扑映射里，无法推导互补关窗。"),
                node_ref: Some(node.clone()),
            });
        };
        if (st_gate as i64) >= qc {
            return Err(VerifyError {
                code: "st_gate_exceeds_queue_count".to_string(),
                message_zh: format!(
                    "节点 {node} 的队列数 {qc} 容不下 ST 门（gate {st_gate}），门表与节点配置矛盾，请检查节点 queue_count 或重新规划。"
                ),
                node_ref: Some(node.clone()),
            });
        }
        // ST 开窗区间并集。
        let mut intervals: Vec<(u64, u64)> = Vec::new();
        for g in entries {
            intervals.extend(gcl_open_intervals(g)?);
        }
        intervals.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for (s, e) in intervals {
            match merged.last_mut() {
                Some(last) if s <= last.1 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        if merged.is_empty() {
            continue; // ST 门恒关：该端口无 ST 窗，各门恒开（R8），不生成条目。
        }
        // 补集（[0,cycle) 线性坐标）。
        let mut comp: Vec<(u64, u64)> = Vec::new();
        let mut cursor = 0u64;
        for &(s, e) in &merged {
            if s > cursor {
                comp.push((cursor, s));
            }
            cursor = e;
        }
        if cursor < GATE_CYCLE_NS {
            comp.push((cursor, GATE_CYCLE_NS));
        }
        if comp.is_empty() {
            return Err(VerifyError {
                code: "st_windows_saturate_port".to_string(),
                message_zh: format!(
                    "端口 {node} eth{eth_n} 被 ST 门窗占满，无低优先级传输空间，请缩短 ST 窗或减少该端口 ST 流。"
                ),
                node_ref: Some(node.clone()),
            });
        }
        // 环回归并成圆上开窗段 (start, len)：首段起于 0 且尾段止于 cycle 时两段是同一连续窗。
        let mut segs: Vec<(u64, u64)> = comp.iter().map(|&(s, e)| (s, e - s)).collect();
        if segs.len() >= 2 {
            let first = segs[0];
            let last = *segs.last().unwrap();
            if first.0 == 0 && last.0 + last.1 == GATE_CYCLE_NS {
                segs.pop();
                segs.remove(0);
                segs.push((last.0, last.1 + first.1));
            }
        }
        // MTU 帧发送时长校验（环回段按归并后长度计）。速率口径与 link_rate 一致（Mbps）。
        let rate = port_rates
            .get(&(node.clone(), eth_n))
            .copied()
            .unwrap_or(DEFAULT_DATARATE_MBPS);
        let mtu_tx_ns = ((MTU_BYTES + overhead) as u64 * 8 * 1000).div_ceil(rate as u64);
        let max_open = segs.iter().map(|&(_, len)| len).max().unwrap_or(0);
        if max_open < mtu_tx_ns {
            return Err(VerifyError {
                code: "complement_window_too_small".to_string(),
                message_zh: format!(
                    "端口 {node} eth{eth_n} 的补集窗容不下一个 MTU 帧（最长连续开窗 {max_open}ns < 所需 {mtu_tx_ns}ns），低优先级门会永久锁死，请缩短 ST 窗或合并 ST 窗口。"
                ),
                node_ref: Some(node.clone()),
            });
        }
        // 补集 → initiallyOpen/offset/durations：以首个圆上开窗段起点 r 为序列原点（保证
        // durations 偶数条、逐周期严格重复），offset = (cycle - r) mod cycle。
        let r = segs[0].0;
        let mut durations: Vec<u64> = Vec::with_capacity(segs.len() * 2);
        for i in 0..segs.len() {
            let (s, len) = segs[i];
            let end = (s + len) % GATE_CYCLE_NS;
            let next_s = segs[(i + 1) % segs.len()].0;
            // 单段时 next=自身：gap = (s + cycle - end) mod cycle = cycle - len，公式统一。
            let gap = (next_s + GATE_CYCLE_NS - end) % GATE_CYCLE_NS;
            durations.push(len);
            durations.push(gap);
        }
        let offset_ns = (GATE_CYCLE_NS - r) % GATE_CYCLE_NS;
        for gate in 0..qc as usize {
            if gate == st_gate {
                continue;
            }
            out.push(GclEntry {
                node: node.clone(),
                eth_n,
                gate_index: gate,
                initially_open: true,
                offset_ns,
                durations_ns: durations.clone(),
                solver: COMPLEMENT_SOLVER.to_string(),
            });
        }
    }
    Ok(out)
}

/// (mid, ethN) → 链路速率 Mbps（U5 互补关窗 MTU 校验用）。速率取 link_rate（speed 列优先、
/// styles_json.speed 兜底、再兜底 DEFAULT_DATARATE_MBPS），与 NED 连线用的口径同源。
fn build_port_rate_map(
    links: &[VerifyLink],
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
) -> BTreeMap<(String, usize), u32> {
    let mut out: BTreeMap<(String, usize), u32> = BTreeMap::new();
    for l in links {
        let rate = link_rate(l);
        if let Some(p) = l.src_port
            && let Some(k) = port_eth.get(&l.src_node).and_then(|m| m.get(&p))
        {
            out.insert((l.src_node.clone(), *k), rate);
        }
        if let Some(p) = l.dst_port
            && let Some(k) = port_eth.get(&l.dst_node).and_then(|m| m.get(&p))
        {
            out.insert((l.dst_node.clone(), *k), rate);
        }
    }
    out
}

/// 断链故障轮参数（U6/KTD2）：verify 编排从重推导路径选定断点后传入。断链语义为**单向 TX
/// 断开**（`ethg$o[N]`，spike run4 逐字语法）：`src_mid`/`src_db_port` 是断链**上游端点**
/// （朝 talker 一侧）的 mid 与其在该链路上的库端口号。builder 负责 mid→NED 名（含 SplitEs
/// 拆分映射：双宿端点的库端口锚在内嵌桥上 → 取桥名）与库端口→ethN（build_port_eth_map 同源）。
#[derive(Debug, Clone)]
pub struct FaultSpec {
    pub src_mid: String,
    pub src_db_port: i64,
    pub t_break_ns: u64,
}

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
    /// flow 专用（U4）：会话**全流集**是否含 RC——plan_tas 的 synth bundle 只装 ST，builder
    /// 无法从入参 streams 判会话是否有 RC，须由调用方从全流集判定后传入（帧开销 +4B R-TAG）。
    /// timesync 忽略。
    pub has_rc: bool,
    /// flow 专用（U6）：断链故障轮。Some → NED 加 scenarioManager 子模块 + ini 出 disconnect
    /// 脚本；None（健康轮/timesync/synth）→ 零输出，产物与无此字段时位级一致。
    pub fault: Option<FaultSpec>,
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

/// talker eth0（最小库端口）所在平面（spike 押注⑤：INET 缺省单播全落该平面）。
/// 无该端口链路或链路无 plane 键 → None（保守视为需钉死）。
fn talker_eth0_plane(
    links: &[VerifyLink],
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    mid: &str,
) -> Option<String> {
    let min_port = port_eth
        .get(mid)?
        .iter()
        .find(|(_, k)| **k == 0)
        .map(|(p, _)| *p)?;
    links
        .iter()
        .find(|l| {
            (l.src_node == mid && l.src_port == Some(min_port))
                || (l.dst_node == mid && l.dst_port == Some(min_port))
        })
        .and_then(crate::flow_route::link_plane)
}

/// 节点在指定链路上的库端口 → ethN（无该端口/无映射 → None）。KTD13：转发表键与 destAddress
/// 后缀共用它取端点 `%ethN`，保证 L2 转发键与 L3 目的解析落同一接口（防多宿端系统失配泛洪）。
fn endpoint_eth(
    link: &VerifyLink,
    node: &str,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
) -> Option<usize> {
    let port = if link.src_node == node {
        link.src_port
    } else if link.dst_node == node {
        link.dst_port
    } else {
        None
    }?;
    port_eth.get(node).and_then(|m| m.get(&port)).copied()
}

/// 路径 listener 侧末链入口端口 → ethN（KTD13 P2：destAddress `%ethN` 与转发表键同源）。
fn route_listener_eth(
    r: &Route,
    by_seq: &BTreeMap<i64, &VerifyLink>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
) -> Option<usize> {
    let listener = r.node_path.last()?;
    let &last_seq = r.link_seqs.last()?;
    let last = by_seq.get(&last_seq)?;
    endpoint_eth(last, listener, port_eth)
}

/// KTD13：把每条 ST/BE 流的路径凭证翻译成逐交换机静态 L2 转发条目（forward-only）。
/// 返回 `交换机 ned 名 → Vec<(目的地址 "ned%ethN", 出口 ethN)>`（(ned,dest) 键有序 → Vec 天然
/// 按 dest 排序，确定性）。每条流沿 `route.egress`（除 talker）每交换机 hop → 去 listener 走该 hop
/// 出口，目的地址锚 listener 末链入口端口（`route_listener_eth`，与 destAddress `%ethN` 同源，消
/// 双宿端系统裸名 MAC 解析歧义）。**不写反向（dest=talker）条目**：返回方向的覆盖由返回那条流自己
/// 的正向条目提供；反向在含环拓扑致伪冲突，纯 talker 的 ARP 单播由 pin bundle 的 GlobalArp 消除、
/// 非靠反向条目。跨流冲突（两流发往同一 listener 在共享交换机要求不同出口）静态 MAC 转发不分流、
/// 物理不可满足 → 响亮 `FORWARDING_CONFLICT`（点名两流 + 交换机 + 消解引导，文案照 flow_route 先例）；
/// 同键同出口去重。终端口从 `link_seqs` + `port_eth` 同源取（凭证已过复验，映射失败属内部不变量
/// 破坏，`FORWARDING_INTERNAL` 直接 Err）。
pub(crate) fn build_forwarding_tables(
    routes: &[(i64, Route)],
    links: &[VerifyLink],
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    ned_names: &BTreeMap<String, String>,
    switch_mids: &std::collections::BTreeSet<String>,
) -> Result<BTreeMap<String, Vec<(String, usize)>>, VerifyError> {
    let by_seq: BTreeMap<i64, &VerifyLink> = links.iter().map(|l| (l.link_seq, l)).collect();
    let internal_err = |seq: i64, what: &str| VerifyError {
        code: "FORWARDING_INTERNAL".to_string(),
        message_zh: format!("流 {seq} 转发表构造内部不变量破坏：{what}（凭证应已过复验）。"),
        node_ref: None,
    };
    // 键 (交换机 ned, 目的地址) → (出口 ethN, 来源 stream_seq)。冲突/去重据此判。
    let mut acc: BTreeMap<(String, String), (usize, i64)> = BTreeMap::new();
    let push = |acc: &mut BTreeMap<(String, String), (usize, i64)>,
                sw_ned: &str,
                dest: String,
                egress: usize,
                seq: i64|
     -> Result<(), VerifyError> {
        match acc.get(&(sw_ned.to_string(), dest.clone())) {
            Some(&(prev_eg, prev_seq)) if prev_eg != egress => Err(VerifyError {
                code: "FORWARDING_CONFLICT".to_string(),
                message_zh: format!(
                    "交换机 {sw_ned} 上流 {prev_seq} 与流 {seq} 对同一目的 {dest} 要求不同出口（eth{prev_eg} vs eth{egress}），静态 MAC 转发无法按流区分。请为共享该端点的流指定与绕路同侧的路径后重试。"
                ),
                node_ref: None,
            }),
            Some(_) => Ok(()), // 同出口重复 → 去重。
            None => {
                acc.insert((sw_ned.to_string(), dest), (egress, seq));
                Ok(())
            }
        }
    };

    for (seq, r) in routes {
        let seq = *seq;
        if r.node_path.len() < 2 {
            continue;
        }
        let talker = &r.node_path[0];
        let listener = &r.node_path[r.node_path.len() - 1];
        // 目的地址锚：listener 末链入口端口经 route_listener_eth（destAddress %ethN 同源，消双宿
        // 裸名歧义）。凭证已过复验，映射失败属内部不变量破坏。
        let Some(l_eth) = route_listener_eth(r, &by_seq, port_eth) else {
            return Err(internal_err(seq, "端点端口无法映射到 ethN"));
        };
        let ned_of = |mid: &str| {
            ned_names
                .get(mid)
                .cloned()
                .unwrap_or_else(|| mid.to_string())
        };
        let listener_addr = format!("{}%eth{l_eth}", ned_of(listener));

        // 正向：egress 除 talker 每交换机 hop → 去 listener（走该 hop 的 egress 端口）。
        // 中间转发节点必须是交换机（端系统无 macTable，钉不了）——非交换机响亮 Err，
        // 不静默跳过（否则漏条目 + 自动配置器已关 → 泛洪）。
        for (mid, eg) in r.egress.iter() {
            if mid == talker {
                continue;
            }
            if !switch_mids.contains(mid) {
                return Err(internal_err(
                    seq,
                    "路径中间转发节点非交换机，无 macTable 可钉",
                ));
            }
            let Some(sw_ned) = ned_names.get(mid) else {
                return Err(internal_err(seq, "交换机无 ned 名"));
            };
            push(&mut acc, sw_ned, listener_addr.clone(), *eg, seq)?;
        }
    }

    let mut out: BTreeMap<String, Vec<(String, usize)>> = BTreeMap::new();
    for ((sw_ned, dest), (egress, _seq)) in acc {
        out.entry(sw_ned).or_default().push((dest, egress));
    }
    Ok(out)
}

/// mid → ned 名（sw{NN}/es{NN}，两位零填充）映射，`map_and_validate` 的命名单一源（按节点
/// 入参顺序计数，不可映射类型跳过）。verify pin 重放（KTD4）在 bundle 构建前需要 ned→mid
/// 反向表，从这里取。零填充是硬约束：INET GateScheduleConfiguratorBase 把 source/destination
/// 当子串 PatternMatcher（两端隐式 **），"es1" 会命中 es10/es11/…，两位零填充消除前缀歧义。
pub(crate) fn node_ned_names(nodes: &[VerifyNode]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut sw_seq = 0u32;
    let mut es_seq = 0u32;
    for node in nodes {
        match map_node_type(node.node_type.as_deref()) {
            Some("TsnSwitch") => {
                sw_seq += 1;
                out.insert(node.mid.clone(), format!("sw{sw_seq:02}"));
            }
            Some(_) => {
                es_seq += 1;
                out.insert(node.mid.clone(), format!("es{es_seq:02}"));
            }
            None => {}
        }
    }
    out
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
    let ned_names = node_ned_names(nodes);

    for node in nodes {
        match map_node_type(node.node_type.as_deref()) {
            Some(ned_type) => {
                mapped.insert(
                    node.mid.as_str(),
                    MappedNode {
                        ned_name: ned_names[node.mid.as_str()].clone(),
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

/// 复合形态（U1 spike 契约改型）：有 RC 流的会话中「RC talker/listener 且双宿（挂两个平面）」
/// 的端系统拆成「TsnDevice（单口 eth0）+ 内嵌 TsnSwitch（原端口数 + 1 内联口）」，分流/合流
/// 发生在内嵌桥——双宿直连形态下 StreamSplitter 复制帧继承 InterfaceReq、两份同口而出，
/// B 树份被邻居 vlanIdFilter 剪掉，冗余是假的（spike 押注①/坑 2）。
/// 端口→ethN 语义保持：原库端口经 `build_port_eth_map` 的门号原样锚在内嵌桥上，内联口取
/// 下一个门号（=原端口数）。
struct SplitEs {
    bridge_ned: String,
    /// 内嵌桥上接设备的门号（排在库端口门号之后）。
    internal_gate: usize,
}

/// 计算拆分集（键=mid）。仅 flow verify 的 RC 会话产生非空集；其余（timesync/synth/无 RC）
/// 均空，NED 生成零变化。
fn compute_rc_splits(
    mapped: &BTreeMap<&str, MappedNode>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    links: &[VerifyLink],
    streams: &[FlowStreamSpec],
) -> BTreeMap<String, SplitEs> {
    let mut planes_of: BTreeMap<&str, std::collections::BTreeSet<String>> = BTreeMap::new();
    for l in links {
        if let Some(p) = crate::flow_route::link_plane(l) {
            planes_of
                .entry(l.src_node.as_str())
                .or_default()
                .insert(p.clone());
            planes_of.entry(l.dst_node.as_str()).or_default().insert(p);
        }
    }
    let mut out: BTreeMap<String, SplitEs> = BTreeMap::new();
    for s in streams {
        if s.class != "RC" {
            continue;
        }
        for mid in [s.talker.as_str(), s.listener.as_str()] {
            if out.contains_key(mid) {
                continue;
            }
            let Some(m) = mapped.get(mid) else { continue };
            // 仅端系统拆（交换机本就是桥）；仅双宿（两个平面都挂）才有分流歧义。
            if m.ned_type != "TsnDevice" || planes_of.get(mid).is_none_or(|p| p.len() < 2) {
                continue;
            }
            out.insert(
                mid.to_string(),
                SplitEs {
                    // es{N} → esb{N}（spike fixture 命名）。
                    bridge_ned: m.ned_name.replacen("es", "esb", 1),
                    internal_gate: port_eth.get(mid).map_or(0, |p| p.len()),
                },
            );
        }
    }
    out
}

/// NED submodule + connection 段（KTD3 显式门号 + `ethg[N];` 声明）。timesync/flow 共享；
/// `splits` 非空（flow RC 会话）时拆分节点生成 device+内嵌桥复合形态。
fn build_submodules_and_connections(
    nodes: &[VerifyNode],
    mapped: &BTreeMap<&str, MappedNode>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    links: &[VerifyLink],
    splits: &BTreeMap<String, SplitEs>,
) -> (String, String) {
    // submodules：`<ned_name>: <ned_type>;`，按入参顺序。
    // 关键（真机校正 2026-06-26）：用显式门号 `ethg[k]` 时 INET 的 `ethg[]` 默认 size 0，
    // 必须在 submodule 里显式声明门向量大小（=该节点用到的端口数），否则 network setup 报
    // 「Gate index 0 out of range ... 'ethg$i[]' with size 0」。`ethg++` 才会自动增长。
    let mut submodules = String::new();
    for node in nodes {
        if let Some(m) = mapped.get(node.mid.as_str()) {
            let gate_count = port_eth.get(node.mid.as_str()).map_or(0, |p| p.len());
            if let Some(sp) = splits.get(node.mid.as_str()) {
                // 复合形态：设备单口 + 内嵌桥（原端口门号原样 + 1 内联口）。
                submodules.push_str(&format!(
                    "        {}: {} {{\n            gates:\n                ethg[1];\n        }}\n",
                    m.ned_name, m.ned_type
                ));
                submodules.push_str(&format!(
                    "        {}: TsnSwitch {{\n            gates:\n                ethg[{}];\n        }}\n",
                    sp.bridge_ned,
                    gate_count + 1
                ));
            } else if gate_count > 0 {
                submodules.push_str(&format!(
                    "        {}: {} {{\n            gates:\n                ethg[{}];\n        }}\n",
                    m.ned_name, m.ned_type, gate_count
                ));
            } else {
                submodules.push_str(&format!("        {}: {};\n", m.ned_name, m.ned_type));
            }
        }
    }

    // connections：显式门号 ethg[k]（k 由端口映射派生），不再 ethg++。拆分节点的库端口
    // 锚在内嵌桥上（门号不变）。
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
        let src_name = splits
            .get(&link.src_node)
            .map_or(src.ned_name.as_str(), |s| s.bridge_ned.as_str());
        let dst_name = splits
            .get(&link.dst_node)
            .map_or(dst.ned_name.as_str(), |s| s.bridge_ned.as_str());
        let rate = link_rate(link);
        connections.push_str(&format!(
            "        {src_name}.ethg[{ks}] <--> EthernetLink {{ datarate = {rate}Mbps; length = {LINK_LENGTH}; }} <--> {dst_name}.ethg[{kd}];\n",
        ));
    }
    // 拆分节点的设备↔内嵌桥内联线（设备 eth0 ↔ 桥内联口），按节点顺序稳定输出。
    for node in nodes {
        if let Some(sp) = splits.get(node.mid.as_str()) {
            let dev = &mapped[node.mid.as_str()].ned_name;
            connections.push_str(&format!(
                "        {dev}.ethg[0] <--> EthernetLink {{ datarate = {DEFAULT_DATARATE_MBPS}Mbps; length = {LINK_LENGTH}; }} <--> {}.ethg[{}];\n",
                sp.bridge_ned, sp.internal_gate
            ));
        }
    }
    (submodules, connections)
}

/// network.ned 文本。网络名参数化（timesync=TsnAgentTimesyncNetwork / flow=TsnAgentFlowTasNetwork），
/// 其余（extends TsnNetworkBase、bitrate 默认、submodule/connection 段）共享。
/// `scenario_manager`（U6 断链故障轮，spike 押注④）：import + 子模块两行即够，`hasStatus`
/// 不需要；false 时输出与加参前位级一致（健康轮/timesync 零变化）。
fn build_network_ned(
    network_name: &str,
    submodules: &str,
    connections: &str,
    scenario_manager: bool,
) -> String {
    let sm_import = if scenario_manager {
        "import inet.common.scenario.ScenarioManager;\n"
    } else {
        ""
    };
    let sm_submodule = if scenario_manager {
        "        scenarioManager: ScenarioManager;\n"
    } else {
        ""
    };
    format!(
        "package tsnagent.generated;\n\n\
{sm_import}import inet.networks.base.TsnNetworkBase;\n\
import inet.node.ethernet.EthernetLink;\n\
import inet.node.tsn.TsnDevice;\n\
import inet.node.tsn.TsnSwitch;\n\n\
network {network_name} extends TsnNetworkBase\n{{\n\
    parameters:\n\
        *.eth[*].bitrate = default({DEFAULT_DATARATE_MBPS}Mbps);\n\
    submodules:\n{sm_submodule}{submodules}\
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
    let no_splits = BTreeMap::new();
    let (submodules, connections) =
        build_submodules_and_connections(nodes, &mapped, &port_eth, links, &no_splits);
    let network_ned =
        build_network_ned("TsnAgentTimesyncNetwork", &submodules, &connections, false);

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
    let no_splits = BTreeMap::new();
    ini.push_str(&build_sync_block(
        mapped, port_eth, gm_ned, timing, overrides, &no_splits,
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
/// `splits` 非空时拆分节点按复合形态发两组角色（gPTP 树多一跳，内嵌桥为 BRIDGE_NODE，spike 净影响）。
fn build_sync_block(
    mapped: &BTreeMap<&str, MappedNode>,
    port_eth: &BTreeMap<String, BTreeMap<i64, usize>>,
    gm_ned: &str,
    timing: &[SimNodeTiming],
    overrides: &SimOverrides,
    splits: &BTreeMap<String, SplitEs>,
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
        if let Some(sp) = splits.get(t.mid.as_str()) {
            // 复合形态：原库端口角色锚到内嵌桥；设备经内联口与桥同步（设备侧恒 eth0）。
            let dev = &m.ned_name;
            let bridge = &sp.bridge_ned;
            let internal_eth = format!("eth{}", sp.internal_gate);
            let mut bridge_masters: Vec<String> = t
                .master_port
                .iter()
                .filter_map(|p| eth_name(port_eth, &t.mid, *p))
                .collect();
            let is_gm = dev == gm_ned;
            let (dev_type, dev_masters, dev_slave, bridge_slave) = if is_gm {
                // 设备是 GM：桥的 slave 朝设备（内联口），原 master 口留桥上向平面下发。
                (
                    "MASTER_NODE",
                    vec!["eth0".to_string()],
                    String::new(),
                    internal_eth,
                )
            } else {
                // 非 GM：桥沿原 slave 口朝 GM，master 集多一个内联口向设备下发。
                bridge_masters.push(internal_eth);
                let slave = t
                    .slave_port
                    .first()
                    .and_then(|p| eth_name(port_eth, &t.mid, *p))
                    .unwrap_or_default();
                ("SLAVE_NODE", vec![], "eth0".to_string(), slave)
            };
            let quote = |v: &[String]| {
                v.iter()
                    .map(|e| format!("\"{e}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            ini.push_str(&format!("*.{dev}.gptp.gptpNodeType = \"{dev_type}\"\n"));
            ini.push_str(&format!(
                "*.{dev}.gptp.masterPorts = [{}]\n",
                quote(&dev_masters)
            ));
            ini.push_str(&format!("*.{dev}.gptp.slavePort = \"{dev_slave}\"\n"));
            ini.push_str(&format!("*.{bridge}.gptp.gptpNodeType = \"BRIDGE_NODE\"\n"));
            ini.push_str(&format!(
                "*.{bridge}.gptp.masterPorts = [{}]\n",
                quote(&bridge_masters)
            ));
            ini.push_str(&format!("*.{bridge}.gptp.slavePort = \"{bridge_slave}\"\n"));
            if let Some(sync) = t.sync_period_ms {
                ini.push_str(&format!("*.{dev}.gptp.syncInterval = {sync}ms\n"));
                ini.push_str(&format!("*.{bridge}.gptp.syncInterval = {sync}ms\n"));
            }
            if let Some(pdelay) = t.measure_period_ms {
                ini.push_str(&format!("*.{dev}.gptp.pdelayInterval = {pdelay}ms\n"));
                ini.push_str(&format!("*.{bridge}.gptp.pdelayInterval = {pdelay}ms\n"));
            }
            continue;
        }
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
/// flow-tas 软仿时长（秒）：**只按 ST+RC 流**的 count×period 取最大值（KTD7——BE 灌流参数
/// 不得主导或截短时长，BE 源本就产包到 sim 结束）；纯 BE 流集回退全量原公式。至少 1ms。
/// 源按固定间隔持续产包，sim 时长即决定产包数（INET 源无产包上限参数）——据此让产包数≈用户
/// count。验证侧用相同公式反推每流实发数（floor(sim/period)+1，含 t=0 包）判丢包。
pub(crate) fn flow_sim_time_s(streams: &[FlowStreamSpec]) -> f64 {
    let time_of = |s: &FlowStreamSpec| s.count.max(1) as f64 * s.period_us as f64 / 1_000_000.0;
    let has_critical = streams.iter().any(|s| s.class == "ST" || s.class == "RC");
    streams
        .iter()
        .filter(|s| !has_critical || s.class == "ST" || s.class == "RC")
        .map(time_of)
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
    splits: &BTreeMap<String, SplitEs>,
    links: &[VerifyLink],
    forwarding: &BTreeMap<String, Vec<(String, usize)>>,
) -> String {
    // sim 时长按流量推导（非固定 60s）：INET ActivePacketSource 无「产 N 个就停」参数、按
    // productionInterval 持续产包直到 sim 结束，故 sim 时长决定产包数。取 ST+RC 流 count×period
    // 最大值（KTD7）→ 源产包数≈count（验证侧按可算的实发数判丢包，见 flow_verify_command）。
    // 允许 overrides 覆盖。
    let sim_time = overrides
        .sim_time_s
        .unwrap_or_else(|| flow_sim_time_s(streams));
    let mut ini = build_general_header("tsnagent.generated.TsnAgentFlowTasNetwork", sim_time);
    ini.push_str(&build_sync_block(
        mapped, port_eth, gm_ned, timing, overrides, splits,
    ));
    ini.push('\n');
    // FRER 会话（U4/spike 契约）：specs 含 RC 流即 verify RC 装配——ST/RC 全交
    // streamRedundancyConfigurator（带 pcp 键），手工 identifier/coder mapping 不再写
    // （configurator 对流经节点整体替换 mapping，叠加会让 ST 掉回 pcp0/gate0，spike 押注①）。
    let frer = streams.iter().any(|s| s.class == "RC");

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

    // --- 无 RC 双平面会话的转发钉死（spike 押注⑤/KTD6，仅 pin/verify）---
    // INET 缺省把单播全送 talker eth0（最小库端口）所在平面，确定性。逐 talker 断言其 eth0
    // 平面==推导平面 A：全部相等 → 零下发（缺省即对齐）；任一不等 → 三件套（`%ethN` 目的地址 +
    // configurator 手工 <route> + addStaticRoutes=false，addStaticRoutes 全局生效故所有流都补
    // route）。macTable 静态下发钉不动平面（决定点在 talker L3 出口，spike 押注⑤实证），不走。
    let is_pin = matches!(&schedule, FlowTasSchedule::Pin(..));
    let dual_plane = links
        .iter()
        .any(|l| crate::flow_route::link_plane(l).is_some());
    let pin_kit = is_pin
        && !frer
        && dual_plane
        && streams
            .iter()
            .any(|s| talker_eth0_plane(links, port_eth, &s.talker).as_deref() != Some("A"));
    // stream_seq → listener 平面 A 侧接口后缀 "%ethK"（与 forward_dest 同键，消费处单一约定）；
    // route 行按 (talker,listener) 去重。
    let mut pin_dest: BTreeMap<i64, String> = BTreeMap::new();
    let mut route_lines: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    if pin_kit {
        for &i in &order {
            let s = &streams[i];
            let Some(seqs) = &s.pin_links else { continue };
            let (Some(&first_seq), Some(&last_seq)) = (seqs.first(), seqs.last()) else {
                continue;
            };
            let find = |seq: i64| {
                links
                    .iter()
                    .find(|l| l.link_seq == seq)
                    .expect("pin_links 来自同一份链路集")
            };
            let (first, last) = (find(first_seq), find(last_seq));
            // 首链 talker 侧出口 / 末链 listener 侧入口（库端口 → ethN 经唯一门号事实源）。
            let t_port = if first.src_node == s.talker {
                first.src_port
            } else {
                first.dst_port
            };
            let l_port = if last.dst_node == s.listener {
                last.dst_port
            } else {
                last.src_port
            };
            let (Some(t_port), Some(l_port)) = (t_port, l_port) else {
                continue;
            };
            let (Some(k_t), Some(k_l)) = (
                port_eth.get(&s.talker).and_then(|m| m.get(&t_port)),
                port_eth.get(&s.listener).and_then(|m| m.get(&l_port)),
            ) else {
                continue;
            };
            pin_dest.insert(s.stream_seq, format!("%eth{k_l}"));
            route_lines.insert(format!(
                "<route hosts='{}' destination='{}%eth{k_l}' netmask='255.255.255.255' interface='eth{k_t}'/>",
                ned(&s.talker),
                ned(&s.listener)
            ));
        }
    }

    // KTD13 P2：发射静态转发表时，listener destAddress 也须带 `%ethN`——转发表键按 `%ethN`
    // 编、自动配置器已关无学习兜底，若 destAddress 是裸名（多宿端系统解析到别的接口 MAC）则
    // 查表 miss → 泛洪。后缀从与转发表同一份 routes 的 listener 末链入口端口取（route_listener_eth
    // 同源），单宿端系统恒 %eth0 与裸名等价、位级不变。仅 is_pin && !frer && 有转发条目时填。
    let mut forward_dest: BTreeMap<i64, String> = BTreeMap::new();
    if is_pin && !frer && !forwarding.is_empty() {
        let by_seq: BTreeMap<i64, &VerifyLink> = links.iter().map(|l| (l.link_seq, l)).collect();
        if let FlowTasSchedule::Pin(_, routes) = &schedule {
            for (seq, r) in *routes {
                if let Some(l_eth) = route_listener_eth(r, &by_seq, port_eth) {
                    forward_dest.insert(*seq, format!("%eth{l_eth}"));
                }
            }
        }
    }

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
            // forward_dest（转发表同源）优先——它保证 L3 目的与 L2 转发键落同一接口；
            // pin_kit 的 pin_dest 在双平面无 RC 场景与之等值，作后备。
            let dest_suffix = forward_dest
                .get(&s.stream_seq)
                .or_else(|| pin_dest.get(&s.stream_seq))
                .cloned()
                .unwrap_or_default();
            ini.push_str(&format!("*.{tned}.app[{a}].typename = \"UdpSourceApp\"\n"));
            ini.push_str(&format!(
                "*.{tned}.app[{a}].io.destAddress = \"{lned}{dest_suffix}\"\n"
            ));
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
    // FRER 会话不写 mapping：configurator 对流经节点的 identifier/coder mapping 是整体替换
    // （非合并），手工条目全变死配置且误导（spike 坑 1）；BE 留在外面走 untagged pcp0→gate0。
    for (talker, sidx) in &talker_streams {
        let tned = ned(talker);
        ini.push_str(&format!("*.{tned}.hasOutgoingStreams = true\n"));
        if frer {
            continue;
        }
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
        if !frer {
            ini.push_str(&format!(
                "*.{sw}.bridging.streamCoder.decoder.mapping = [{decoder_map}]\n"
            ));
            ini.push_str(&format!(
                "*.{sw}.bridging.streamCoder.encoder.mapping = [{encoder_map}]\n"
            ));
        }
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

    // --- FRER 段（spike 逐字语法）---
    // ST/RC 全部进 configurator：每条带 pcp 键（决定替换后 encoder mapping 的 PCP → egress 按
    // PcpTrafficClassClassifier 进对应门）+ udp 守卫 packetFilter + NED 名 trees（ST 单树平面 A、
    // RC 双树 A/B；拆分节点展开为 设备+内嵌桥 全路径）。vlanIdFilter/merger/splitter 由
    // configurator 自管，不写。BE 不进 configuration（untagged pcp0 天然走 gate0）。
    if frer {
        ini.push_str("*.*.hasStreamRedundancy = true\n");
        ini.push_str(
            "*.streamRedundancyConfigurator.typename = \"StreamRedundancyConfigurator\"\n",
        );
        // mid 路径 → NED 名路径：拆分端点展开（首=设备,桥；尾=桥,设备；过境=仅桥）。
        let expand = |path: &[String]| -> Vec<String> {
            let mut out: Vec<String> = Vec::new();
            for (idx, mid) in path.iter().enumerate() {
                match splits.get(mid) {
                    None => out.push(ned(mid)),
                    Some(sp) if idx == 0 => {
                        out.push(ned(mid));
                        out.push(sp.bridge_ned.clone());
                    }
                    Some(sp) if idx == path.len() - 1 => {
                        out.push(sp.bridge_ned.clone());
                        out.push(ned(mid));
                    }
                    Some(sp) => out.push(sp.bridge_ned.clone()),
                }
            }
            out
        };
        let entries = order
            .iter()
            .filter(|&&i| streams[i].frer_trees.is_some())
            .map(|&i| {
                let s = &streams[i];
                let p = &placements[i];
                let trees = s
                    .frer_trees
                    .as_ref()
                    .expect("filtered on frer_trees")
                    .iter()
                    .map(|path| {
                        let hops = expand(path)
                            .iter()
                            .map(|n| format!("\"{n}\""))
                            .collect::<Vec<_>>()
                            .join(",");
                        format!("[[{hops}]]")
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!(
                    "{{name: \"{}{}\", pcp: {}, packetFilter: expr(udp != nullptr && udp.destPort == {}), source: \"{}\", destination: \"{}\", trees: [{trees}]}}",
                    s.class.to_lowercase(),
                    s.stream_seq,
                    s.pcp,
                    p.port,
                    ned(&s.talker),
                    ned(&s.listener)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        ini.push_str(&format!(
            "*.streamRedundancyConfigurator.configuration = [{entries}]\n"
        ));
    }

    // --- 转发钉死三件套（spike 逐字：%ethN 目的地址已在 app 段、此处 route xml + 关 auto 路由）---
    if pin_kit && !route_lines.is_empty() {
        ini.push_str("*.configurator.addStaticRoutes = false\n");
        ini.push_str(&format!(
            "*.configurator.config = xml(\"<config><interface hosts='**' address='10.0.0.x' netmask='255.255.255.x'/>{}</config>\")\n",
            route_lines.iter().cloned().collect::<Vec<_>>().join("")
        ));
    }

    // --- 静态 L2 转发钉死（KTD13，is_pin && !frer）---
    // 关自动配置器（否则整体覆盖 forwardingTable）+ 显式 GlobalArp + 逐交换机 forwardingTable +
    // 拉大 agingTime（默认 120s 会淘汰静态条目，RC 守卫加大 count 时理论越界）。行序由 BTreeMap
    // 保证确定性。与 pin_kit（L3 出口平面选择）互补：那锚 talker L3 出口平面，这钉每跳 L2 转发。
    if is_pin && !frer && !forwarding.is_empty() {
        ini.push_str("*.macForwardingTableConfigurator.typename = \"\"\n");
        // GlobalArp：全网 init 解析 IP→MAC、零 ARP 帧上线 → forward-only 只钉 dest=listener，纯
        // talker（无正向覆盖的目的）也无单播 ARP-reply 命中缺条目泛洪（学习随静态表禁用，环拓扑成风暴）。
        ini.push_str("**.arp.typename = \"GlobalArp\"\n");
        for (sw, entries) in forwarding {
            let items = entries
                .iter()
                .map(|(dest, eth)| format!("{{address: \"{dest}\", interface: \"eth{eth}\"}}"))
                .collect::<Vec<_>>()
                .join(", ");
            ini.push_str(&format!("*.{sw}.macTable.forwardingTable = [{items}]\n"));
        }
        ini.push_str("**.macTable.agingTime = 1000000s\n");
    }

    // --- 门控段 ---
    match schedule {
        FlowTasSchedule::Synth => {
            ini.push_str("*.gateScheduleConfigurator.typename = \"Z3GateScheduleConfigurator\"\n");
            ini.push_str("*.gateScheduleConfigurator.gateCycleDuration = 1ms\n");
            // 帧开销：有 RC 的会话 +4B R-TAG（62B）——synth bundle 只装 ST，但会话是否有 RC
            // 由调用方经 overrides.has_rc 传入（KTD/spike：不计 R-TAG 的零余量窗必跨窗）。
            let overhead = flow_frame_overhead_bytes(overrides.has_rc);
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
                        overhead,
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
        FlowTasSchedule::Pin(gcl, _) => {
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
                // 关隐式保护带（仅 ST 门）：Z3 门窗是零余量（开窗=正好一帧传输时间），而
                // enableImplicitGuardBand 默认 true 会禁止「发不完就不许进本窗」的帧——包恰好卡在
                // 窗边界即被拒、滑到下一周期(+一个门周期≈500us)。Z3 已保证帧在窗内放得下，此处关掉
                // 这层运行时严格边界检查，honor Z3 排程。真机实证：关掉后 6 跳链 527us→27.66us。
                // 补集门（solver=complement，U5/KTD5）**不写**该行——保持 INET 默认 true：帧发不完
                // 不许进窗，天然防低优先级帧跨入 ST 窗。
                if g.solver != COMPLEMENT_SOLVER {
                    ini.push_str(&format!("{base}.enableImplicitGuardBand = false\n"));
                }
            }
        }
    }

    // --- 断链故障轮（U6/KTD2，spike run4 逐字语法）：ScenarioManager 单向 TX 断开 ---
    // src-module = 断链上游端点（朝 talker 一侧）的 NED 名——拆分节点（SplitEs）的库端口锚在
    // 内嵌桥上，故取桥名；gate 下标即 ethN（build_port_eth_map 同源）；t 用 ns 精确值。
    // 健康轮（fault=None）零输出，ini 与现状位级一致。
    if let Some(f) = &overrides.fault {
        let module = splits
            .get(&f.src_mid)
            .map(|sp| sp.bridge_ned.clone())
            .unwrap_or_else(|| ned(&f.src_mid));
        // 映射存在性已在 build_flow_tas_sim_bundle 前置校验。
        let eth_n = port_eth[&f.src_mid][&f.src_db_port];
        ini.push_str(&format!(
            "*.scenarioManager.script = xml(\"<script><at t='{}ns'><disconnect src-module='{module}' src-gate='ethg$o[{eth_n}]'/></at></script>\")\n",
            f.t_break_ns
        ));
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
    // 断链端点（U6）：进装配前校验可映射（mid 在拓扑、库端口有 ethN 门号），坏输入响亮失败
    // 而非 panic——断点由 verify 编排从同一份链路集的重推导路径选出，正常不该失配。
    if let Some(f) = &overrides.fault {
        let mappable = mapped.contains_key(f.src_mid.as_str())
            && port_eth
                .get(&f.src_mid)
                .is_some_and(|m| m.contains_key(&f.src_db_port));
        if !mappable {
            return Err(vec![VerifyError {
                code: "fault_endpoint_unmapped".to_string(),
                message_zh: format!(
                    "断链端点（节点 {} 端口 {}）无法映射到 NED/ethN，故障轮无法装配。",
                    f.src_mid, f.src_db_port
                ),
                node_ref: Some(f.src_mid.clone()),
            }]);
        }
    }
    // RC 会话的双宿端系统拆分（spike 契约改型）；非 RC 会话恒空、NED 零变化。
    let splits = compute_rc_splits(&mapped, &port_eth, links, streams);
    let (submodules, connections) =
        build_submodules_and_connections(nodes, &mapped, &port_eth, links, &splits);
    let network_ned = build_network_ned(
        "TsnAgentFlowTasNetwork",
        &submodules,
        &connections,
        overrides.fault.is_some(),
    );

    // 互补关窗（U5/KTD5，仅 pin）：会话存在 BE/RC 流才从 ST 门表推导补集条目追加进 pin 集；
    // 纯 ST 会话补集恒空、ini 位级不变。BE/RC 存在性从全流集判定（verify 传入全流集；
    // has_rc 兼看 overrides——与帧开销的会话级口径同源）。推导失败（占满/容不下 MTU 帧）响亮返错。
    // KTD13 静态转发表（仅 pin && 无 RC）：从路径凭证算逐交换机正向（forward-only，dest=listener）
    // 条目，跨流冲突/歧义响亮 Err。含 RC 会话（FRER 单写入者，KTD3）由调用方传空 routes → 空表 → ini 零改动。
    let forwarding: BTreeMap<String, Vec<(String, usize)>> = match &schedule {
        FlowTasSchedule::Pin(_, routes) => {
            let frer = streams.iter().any(|s| s.class == "RC");
            if frer || routes.is_empty() {
                BTreeMap::new()
            } else {
                let ned_names = node_ned_names(nodes);
                let switch_mids: std::collections::BTreeSet<String> = nodes
                    .iter()
                    .filter(|n| map_node_type(n.node_type.as_deref()) == Some("TsnSwitch"))
                    .map(|n| n.mid.clone())
                    .collect();
                build_forwarding_tables(routes, links, &port_eth, &ned_names, &switch_mids)
                    .map_err(|e| vec![e])?
            }
        }
        FlowTasSchedule::Synth => BTreeMap::new(),
    };

    let pin_with_complement: Vec<GclEntry>;
    let schedule = match schedule {
        FlowTasSchedule::Pin(gcl, routes) => {
            let has_rc = overrides.has_rc || streams.iter().any(|s| s.class == "RC");
            let has_be = streams.iter().any(|s| s.class == "BE");
            let queue_counts: BTreeMap<String, i64> = mapped
                .iter()
                .map(|(mid, m)| ((*mid).to_string(), m.queue_count))
                .collect();
            let port_rates = build_port_rate_map(links, &port_eth);
            let comp = complement_gcl(gcl, &queue_counts, &port_rates, has_rc, has_be)
                .map_err(|e| vec![e])?;
            pin_with_complement = gcl.iter().cloned().chain(comp).collect();
            FlowTasSchedule::Pin(&pin_with_complement, routes)
        }
        FlowTasSchedule::Synth => FlowTasSchedule::Synth,
    };

    let gm_ned = &mapped[gm_mid].ned_name;
    let omnetpp_ini = build_flow_tas_ini(
        &mapped,
        &port_eth,
        gm_ned,
        timing,
        overrides,
        streams,
        schedule,
        &splits,
        links,
        &forwarding,
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

    /// 防回归锁（P0）：INET GateScheduleConfiguratorBase 把 source/destination 当子串
    /// PatternMatcher——"es1" 会同时命中 es1/es10/es11/es12，一条 entry 展开成多条流 →
    /// Z3 unsat。两位零填充后任一 ned 名不得是另一名字的子串。
    #[test]
    fn ned_names_zero_padded_no_prefix_ambiguity() {
        let mut nodes = vec![node("sw-a", "switch")];
        for i in 0..12 {
            nodes.push(node(&format!("m{i}"), "endSystem"));
        }
        let names = node_ned_names(&nodes);
        assert_eq!(names.get("sw-a").map(String::as_str), Some("sw01"));
        for i in 0..12u32 {
            assert_eq!(
                names.get(&format!("m{i}")).map(String::as_str),
                Some(format!("es{:02}", i + 1).as_str())
            );
        }
        let all: Vec<&String> = names.values().collect();
        for a in &all {
            for b in &all {
                assert!(
                    a == b || !b.contains(a.as_str()),
                    "ned 名前缀/子串歧义：{a} 是 {b} 的子串"
                );
            }
        }
    }

    // GM=es01(mid 1)，sw(mid 0) 连两个 ES。端口升序映射：sw 端口 {2,5}→eth0/eth1。
    fn sample() -> (Vec<VerifyNode>, Vec<VerifyLink>, Vec<SimNodeTiming>) {
        let nodes = vec![
            node("0", "switch"),
            node("1", "endSystem"),
            node("2", "endSystem"),
        ];
        // sw0 用端口 5 接 es01，端口 2 接 es02（故意乱序，验证升序取下标）。
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
        // es01/es02 各只有端口 0 → eth0。
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
        // sample：GM mid"1"→es01、switch mid"0"→sw01、mid"2"→es02。
        assert_eq!(b.node_ned_names.get("0").map(String::as_str), Some("sw01"));
        assert_eq!(b.node_ned_names.get("1").map(String::as_str), Some("es01"));
        assert_eq!(b.node_ned_names.get("2").map(String::as_str), Some("es02"));
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
        // referenceClock 指向 GM 的 ned 名（es01）。
        assert!(ini.contains("**.referenceClock = \"es01.clock\""), "{ini}");
        // sw0 master 端口 2 → eth0；slave 端口 5 → eth1。
        assert!(
            ini.contains("*.sw01.gptp.masterPorts = [\"eth0\"]"),
            "{ini}"
        );
        assert!(ini.contains("*.sw01.gptp.slavePort = \"eth1\""), "{ini}");
        // gptpNodeType 按角色：GM=MASTER、有 master+slave=BRIDGE、只有 slave=SLAVE。
        assert!(
            ini.contains("*.es01.gptp.gptpNodeType = \"MASTER_NODE\""),
            "{ini}"
        );
        assert!(
            ini.contains("*.sw01.gptp.gptpNodeType = \"BRIDGE_NODE\""),
            "{ini}"
        );
        assert!(
            ini.contains("*.es02.gptp.gptpNodeType = \"SLAVE_NODE\""),
            "{ini}"
        );
        // GM 显式空 slavePort 覆盖 TsnDevice 默认（否则 MASTER_NODE 报 slave port 冲突）。
        assert!(ini.contains("*.es01.gptp.slavePort = \"\""), "{ini}");
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
        // sw0 端口5→eth1 接 es01.eth0；端口2→eth0 接 es02.eth0。
        assert!(ned.contains("sw01.ethg[1] <-->"), "{ned}");
        assert!(ned.contains("sw01.ethg[0] <-->"), "{ned}");
        assert!(ned.contains("allowunconnected"));
        // 真机校正：显式门号必须配门向量大小声明，否则 INET ethg[] size 0 报错。
        // sw0 用 2 个端口 → ethg[2]；es01/es02 各 1 个端口 → ethg[1]。
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
            has_rc: false,
            fault: None,
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
            has_rc: false,
            fault: None,
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
    const GOLDEN_TIMESYNC_NED: &str = "package tsnagent.generated;\n\nimport inet.networks.base.TsnNetworkBase;\nimport inet.node.ethernet.EthernetLink;\nimport inet.node.tsn.TsnDevice;\nimport inet.node.tsn.TsnSwitch;\n\nnetwork TsnAgentTimesyncNetwork extends TsnNetworkBase\n{\nparameters:\n*.eth[*].bitrate = default(1000Mbps);\nsubmodules:\n        sw01: TsnSwitch {\n            gates:\n                ethg[2];\n        }\n        es01: TsnDevice {\n            gates:\n                ethg[1];\n        }\n        es02: TsnDevice {\n            gates:\n                ethg[1];\n        }\nconnections allowunconnected:\n        sw01.ethg[1] <--> EthernetLink { datarate = 1000Mbps; length = 10m; } <--> es01.ethg[0];\n        sw01.ethg[0] <--> EthernetLink { datarate = 1000Mbps; length = 10m; } <--> es02.ethg[0];\n}\n";
    const GOLDEN_TIMESYNC_INI: &str = "[General]\nnetwork = tsnagent.generated.TsnAgentTimesyncNetwork\nsim-time-limit = 60s\nsimtime-resolution = fs\nseed-set = 0\ncmdenv-interactive = false\ncmdenv-express-mode = true\n*.*.hasTimeSynchronization = true\n**.transmitter.typename = \"StreamingTransmitter\"\n**.receiver.typename = \"DestreamingReceiver\"\n**.clock.oscillator.typename = \"RandomDriftOscillator\"\n**.clock.oscillator.changeInterval = 50ms\n**.clock.oscillator.initialDriftRate = uniform(-100ppm, 100ppm)\n**.clock.oscillator.driftRateChange = uniform(-0.3ppm, 0.3ppm)\n**.clock.oscillator.driftRateChangeLowerLimit = -100ppm\n**.clock.oscillator.driftRateChangeUpperLimit = 100ppm\n**.clock.oscillator.nominalTickLength = 10ns\n**.referenceClock = \"es01.clock\"\n**.clock.result-recording-modes = +vector\n\n*.es01.gptp.gptpNodeType = \"MASTER_NODE\"\n*.es01.gptp.masterPorts = [\"eth0\"]\n*.es01.gptp.slavePort = \"\"\n*.es01.gptp.syncInterval = 125ms\n*.es01.gptp.pdelayInterval = 1000ms\n*.sw01.gptp.gptpNodeType = \"BRIDGE_NODE\"\n*.sw01.gptp.masterPorts = [\"eth0\"]\n*.sw01.gptp.slavePort = \"eth1\"\n*.es02.gptp.gptpNodeType = \"SLAVE_NODE\"\n*.es02.gptp.masterPorts = []\n*.es02.gptp.slavePort = \"eth0\"\n";

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

    /// 两条流：ST(pcp7) es01→es02、BE(pcp0) es01→es02。
    fn flow_streams() -> Vec<FlowStreamSpec> {
        vec![
            spec(0, "BE", 0, "1", "2", 500, 1000, 1000),
            FlowStreamSpec {
                max_latency_us: Some(300),
                path_fragments: Some(vec!["1".into(), "0".into(), "2".into()]),
                ..spec(1, "ST", 7, "1", "2", 250, 500, 10000)
            },
        ]
    }

    /// FlowStreamSpec 简写（新字段全 None，各测试按需覆写）。
    #[allow(clippy::too_many_arguments)]
    fn spec(
        seq: i64,
        class: &str,
        pcp: i64,
        talker: &str,
        listener: &str,
        period_us: i64,
        frame_bytes: i64,
        count: i64,
    ) -> FlowStreamSpec {
        FlowStreamSpec {
            stream_seq: seq,
            class: class.into(),
            pcp,
            talker: talker.into(),
            listener: listener.into(),
            period_us,
            frame_bytes,
            count,
            max_latency_us: None,
            path_fragments: None,
            frer_trees: None,
            pin_links: None,
        }
    }

    /// pin 模式：写死 GCL → transmissionGate 参数逐值写入；配置器不实例化。
    #[test]
    fn flow_pin_mode_writes_gate_params_no_configurator() {
        let (nodes, links, timing) = sample();
        let gcl = vec![GclEntry {
            node: "0".into(), // sw01
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
            FlowTasSchedule::Pin(&gcl, &[]),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(
            ini.contains("*.sw01.hasEgressTrafficShaping = true"),
            "{ini}"
        );
        assert!(
            ini.contains(
                "*.sw01.eth[0].macLayer.queue.transmissionGate[1].durations = [500000ns, 500000ns]"
            ),
            "{ini}"
        );
        assert!(
            ini.contains("*.sw01.eth[0].macLayer.queue.transmissionGate[1].offset = 100ns"),
            "{ini}"
        );
        assert!(
            !ini.contains("Z3GateScheduleConfigurator"),
            "pin 模式不得实例化配置器：{ini}"
        );
        // 零余量门窗须关隐式保护带，否则包卡窗边界被拒、滑一个门周期（真机 527us→27us）。
        assert!(
            ini.contains(
                "*.sw01.eth[0].macLayer.queue.transmissionGate[1].enableImplicitGuardBand = false"
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

    // ---------- U2（KTD13）：ini 发射转发钉死段 ----------

    /// Pin + 纯 ST/BE + 非空 routes：ini 含关配置器行、GlobalArp 行、逐交换机 forwardingTable
    /// 行（forward-only：仅 dest=listener）、agingTime 行。
    #[test]
    fn pin_pure_stbe_emits_forwarding_table() {
        let (nodes, links, timing) = sample();
        // 1→2 经 sw0：link_seqs [0,1]，node_path [1,0,2]。
        let r = crate::flow_route::build_route_from_link_seqs(&[0, 1], "1", "2", &links).unwrap();
        let routes = vec![(0i64, r.clone()), (1i64, r)]; // BE(seq0)+ST(seq1) 同路 → 去重
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            &flow_streams(),
            FlowTasSchedule::Pin(&[], &routes),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(
            ini.contains("*.macForwardingTableConfigurator.typename = \"\""),
            "{ini}"
        );
        // GlobalArp：坐实零 ARP 帧（forward-only 纯 talker 防泛洪护栏）。
        assert!(
            ini.contains("**.arp.typename = \"GlobalArp\""),
            "pin 段须显式 GlobalArp：{ini}"
        );
        // forward-only：sw01 只余去 listener(es02) 的正向条目，无 dest=talker(es01) 反向项。
        assert!(
            ini.contains(
                "*.sw01.macTable.forwardingTable = [{address: \"es02%eth0\", interface: \"eth0\"}]"
            ),
            "{ini}"
        );
        assert!(ini.contains("**.macTable.agingTime = 1000000s"), "{ini}");
        // P2：发射转发表时 destAddress 也带 %ethN（与转发键同源）——单宿端系统恒 %eth0。
        assert!(
            ini.contains("io.destAddress = \"es02%eth0\""),
            "destAddress 须带 %ethN 后缀与转发键一致：{ini}"
        );
    }

    /// P3：路径中间转发节点是端系统（无 macTable）→ 响亮 FORWARDING_INTERNAL，不静默漏条目。
    #[test]
    fn forwarding_transit_end_system_errors_loud() {
        let nodes = vec![
            node("t", "endSystem"),
            node("x", "endSystem"), // 多口端系统当中转——无 macTable，钉不了。
            node("l", "endSystem"),
        ];
        let links = vec![plink(0, "t", 0, "x", 0), plink(1, "x", 1, "l", 0)];
        let port_eth = build_port_eth_map(&links);
        let ned = node_ned_names(&nodes);
        let r = route_via(&[0, 1], "t", "l", &links);
        let err = build_forwarding_tables(&[(0, r)], &links, &port_eth, &ned, &sw_set(&nodes))
            .unwrap_err();
        assert_eq!(err.code, "FORWARDING_INTERNAL");
    }

    /// Pin + 含 RC（即便传了 routes）：转发钉死三类行全不出现（FRER 单写入者），FRER 段仍在。
    #[test]
    fn pin_with_rc_omits_forwarding_table() {
        let (nodes, links, timing) = dual_plane_sample();
        let r = crate::flow_route::build_route_from_link_seqs(&[0, 1], "1", "2", &links).unwrap();
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "0",
            &timing,
            &SimOverrides {
                has_rc: true,
                ..Default::default()
            },
            &rc_session_streams(),
            FlowTasSchedule::Pin(&[], &[(0, r)]),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(!ini.contains("forwardingTable"), "含 RC 不钉死：{ini}");
        assert!(
            !ini.contains("*.macForwardingTableConfigurator.typename = \"\""),
            "{ini}"
        );
        assert!(!ini.contains("GlobalArp"), "含 RC 不发 GlobalArp：{ini}");
        assert!(
            ini.contains("*.*.hasStreamRedundancy = true"),
            "FRER 段仍在：{ini}"
        );
    }

    /// Synth 模式：转发钉死段不出现（规划 bundle 零影响）。
    #[test]
    fn synth_mode_omits_forwarding_table() {
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
        assert!(!b.bundle.omnetpp_ini.contains("forwardingTable"));
        assert!(!b.bundle.omnetpp_ini.contains("GlobalArp"));
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
            ini.contains("pathFragments: [[\"es01\", \"sw01\", \"es02\"]]"),
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
            ini.contains("*.sw01.eth[*].macLayer.queue.numTrafficClasses = 8"),
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
            spec(0, "ST", 7, "1", "2", 500, 512, 10000),
            spec(1, "BE", 0, "1", "2", 1000, 512, 100),
        ];
        // 最大流 10000×500us=5s；BE 100×1000us=0.1s → 取 5s。
        assert!((flow_sim_time_s(&streams) - 5.0).abs() < 1e-9);
        // 5s 下：ST(500us) 产 10001；BE(1000us) 产 5001（远超其 count=100，故须按 sim 反推非 count）。
        assert_eq!(flow_expected_sent(5.0, 500), 10001);
        assert_eq!(flow_expected_sent(5.0, 1000), 5001);
        // 空流兜底 ≥1ms。
        assert!((flow_sim_time_s(&[]) - 0.001).abs() < 1e-9);
    }

    /// Covers KTD7（U4⑦）：sim 时长只按 ST+RC 计——BE 灌流参数（count×period 远大于 ST）
    /// 不得主导时长；RC 参与取最大；纯 BE 流集回退全量原公式。
    #[test]
    fn sim_time_ignores_be_unless_pure_be() {
        // BE 100000×1000us=100s 远超 ST 1000×500us=0.5s → 仍取 ST 的 0.5s。
        let st_be = vec![
            spec(0, "ST", 7, "1", "2", 500, 512, 1000),
            spec(1, "BE", 0, "1", "2", 1000, 512, 100_000),
        ];
        assert!(
            (flow_sim_time_s(&st_be) - 0.5).abs() < 1e-9,
            "BE 不得主导时长"
        );
        // RC 2000×1000us=2s > ST 0.5s → 取 RC 的 2s（ST+RC 内取最大）。
        let st_rc_be = vec![
            spec(0, "ST", 7, "1", "2", 500, 512, 1000),
            spec(1, "RC", 6, "1", "2", 1000, 512, 2000),
            spec(2, "BE", 0, "1", "2", 1000, 512, 100_000),
        ];
        assert!(
            (flow_sim_time_s(&st_rc_be) - 2.0).abs() < 1e-9,
            "RC 应参与时长"
        );
        // 纯 BE 回退原公式（全量取最大）。
        let pure_be = vec![spec(0, "BE", 0, "1", "2", 1000, 512, 100)];
        assert!(
            (flow_sim_time_s(&pure_be) - 0.1).abs() < 1e-9,
            "纯 BE 回退原公式"
        );
    }

    /// Covers U4⑥：帧开销选择——有 RC 的会话 58B→62B（+4B R-TAG）。
    #[test]
    fn frame_overhead_adds_rtag_only_with_rc() {
        assert_eq!(flow_frame_overhead_bytes(false), 58);
        assert_eq!(flow_frame_overhead_bytes(true), 62);
    }

    /// Covers U4⑥：synth configuration 的 packetLength 在有 RC 的会话（overrides.has_rc，
    /// 全流集判定后传入）用 +62B；无 RC（默认）用 +58B（既有 flow_synth_mode 测试覆盖）。
    #[test]
    fn synth_packet_length_uses_rtag_overhead_when_session_has_rc() {
        let (nodes, links, timing) = sample();
        let ov = SimOverrides {
            has_rc: true,
            ..Default::default()
        };
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &ov,
            &flow_streams(),
            FlowTasSchedule::Synth,
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(ini.contains("packetLength: 500B + 62B"), "{ini}");
        assert!(!ini.contains("+ 58B"), "{ini}");
    }

    // ---------- U4：RC FRER 装配 / 双宿拆分 / 平面钉死 ----------

    // ---------- U1（KTD13）：静态转发表构造 ----------

    /// 无 plane 键的单平面链路（转发表构造与平面无关，derive 用 plane=None 全链路）。
    fn plink(seq: i64, src: &str, sp: i64, dst: &str, dp: i64) -> VerifyLink {
        VerifyLink {
            link_seq: seq,
            src_node: src.into(),
            dst_node: dst.into(),
            src_port: Some(sp),
            dst_port: Some(dp),
            speed: None,
            styles_json: "{}".into(),
        }
    }

    fn route_via(
        seqs: &[i64],
        talker: &str,
        listener: &str,
        links: &[VerifyLink],
    ) -> crate::flow_route::Route {
        crate::flow_route::build_route_from_link_seqs(seqs, talker, listener, links).unwrap()
    }

    fn sw_set(nodes: &[VerifyNode]) -> std::collections::BTreeSet<String> {
        nodes
            .iter()
            .filter(|n| map_node_type(n.node_type.as_deref()) == Some("TsnSwitch"))
            .map(|n| n.mid.clone())
            .collect()
    }

    /// 直路 t—s1—s2—l（forward-only）：沿途每交换机只含去 listener 的正向条目，出口 ethN 与
    /// links 一致，地址带 %ethN；无 dest=talker 反向条目。
    #[test]
    fn forwarding_linear_forward_only_entries() {
        let nodes = vec![
            node("t", "endSystem"),
            node("l", "endSystem"),
            node("s1", "switch"),
            node("s2", "switch"),
        ];
        let links = vec![
            plink(0, "t", 0, "s1", 0),
            plink(1, "s1", 1, "s2", 0),
            plink(2, "s2", 1, "l", 0),
        ];
        let port_eth = build_port_eth_map(&links);
        let ned = node_ned_names(&nodes);
        let r = route_via(&[0, 1, 2], "t", "l", &links);
        let fwd =
            build_forwarding_tables(&[(0, r)], &links, &port_eth, &ned, &sw_set(&nodes)).unwrap();
        // t=es01, l=es02, s1=sw01, s2=sw02。仅去 listener(es02) 正向条目、无 es01 反向。
        assert_eq!(
            fwd.get("sw01").unwrap(),
            &vec![("es02%eth0".to_string(), 1)]
        );
        assert_eq!(
            fwd.get("sw02").unwrap(),
            &vec![("es02%eth0".to_string(), 1)]
        );
        // talker/listener 不进表。
        assert!(!fwd.contains_key("es01") && !fwd.contains_key("es02"));
    }

    /// 绕路流（三角拓扑）：中间交换机 s2 出现；直连口交换机 s1 的正向条目指向绕路端口（eth2）
    /// 而非直连端口（eth1）。
    #[test]
    fn forwarding_detour_uses_detour_port() {
        let nodes = vec![
            node("t", "endSystem"),
            node("l", "endSystem"),
            node("s1", "switch"),
            node("s2", "switch"),
            node("s3", "switch"),
        ];
        let links = vec![
            plink(0, "t", 0, "s1", 0),
            plink(1, "s1", 1, "s3", 0), // 直连 s1—s3
            plink(2, "s3", 1, "l", 0),
            plink(3, "s1", 2, "s2", 0), // 绕路 s1—s2—s3
            plink(4, "s2", 1, "s3", 2),
        ];
        let port_eth = build_port_eth_map(&links);
        let ned = node_ned_names(&nodes);
        // 绕路 link_seqs [0,3,4,2]：t-s1-s2-s3-l。
        let r = route_via(&[0, 3, 4, 2], "t", "l", &links);
        let fwd =
            build_forwarding_tables(&[(0, r)], &links, &port_eth, &ned, &sw_set(&nodes)).unwrap();
        // forward-only：沿途每交换机只含去 listener=es02%eth0 的正向条目（无 dest=talker 反向）。
        // s1 走绕路口 eth2（非直连 eth1）、s2 走 eth1、s3 走 eth1。
        assert_eq!(
            fwd.get("sw01").unwrap(),
            &vec![("es02%eth0".to_string(), 2)]
        );
        assert_eq!(
            fwd.get("sw02").unwrap(),
            &vec![("es02%eth0".to_string(), 1)]
        );
        assert_eq!(
            fwd.get("sw03").unwrap(),
            &vec![("es02%eth0".to_string(), 1)]
        );
    }

    /// 两流同 (sw, 目的地址) 同出口（同路径）→ 去重为一条（forward-only 每交换机恰 1 条目）。
    #[test]
    fn forwarding_dedup_same_egress() {
        let nodes = vec![
            node("t", "endSystem"),
            node("l", "endSystem"),
            node("s1", "switch"),
            node("s2", "switch"),
        ];
        let links = vec![
            plink(0, "t", 0, "s1", 0),
            plink(1, "s1", 1, "s2", 0),
            plink(2, "s2", 1, "l", 0),
        ];
        let port_eth = build_port_eth_map(&links);
        let ned = node_ned_names(&nodes);
        let r0 = route_via(&[0, 1, 2], "t", "l", &links);
        let r1 = route_via(&[0, 1, 2], "t", "l", &links);
        let fwd = build_forwarding_tables(
            &[(0, r0), (1, r1)],
            &links,
            &port_eth,
            &ned,
            &sw_set(&nodes),
        )
        .unwrap();
        assert_eq!(fwd.get("sw01").unwrap().len(), 1, "去重后每交换机 1 条目");
        assert_eq!(fwd.get("sw02").unwrap().len(), 1);
    }

    /// 主用例冲突：同 talker/listener 的绕路流（seq0）+ 最短路流（seq1）→ 正向分叉交换机 s1
    /// 对同一 listener 目的要求不同出口 → FORWARDING_CONFLICT，点名两流 + 交换机 + 消解引导。
    #[test]
    fn forwarding_forward_fork_conflict() {
        let nodes = vec![
            node("t", "endSystem"),
            node("l", "endSystem"),
            node("s1", "switch"),
            node("s2", "switch"),
            node("s3", "switch"),
        ];
        let links = vec![
            plink(0, "t", 0, "s1", 0),
            plink(1, "s1", 1, "s3", 0), // 直连
            plink(2, "s3", 1, "l", 0),
            plink(3, "s1", 2, "s2", 0), // 绕路
            plink(4, "s2", 1, "s3", 2),
        ];
        let port_eth = build_port_eth_map(&links);
        let ned = node_ned_names(&nodes);
        let detour = route_via(&[0, 3, 4, 2], "t", "l", &links); // s1 出口 eth2
        let shortest = route_via(&[0, 1, 2], "t", "l", &links); // s1 出口 eth1
        let err = build_forwarding_tables(
            &[(0, detour), (1, shortest)],
            &links,
            &port_eth,
            &ned,
            &sw_set(&nodes),
        )
        .unwrap_err();
        assert_eq!(err.code, "FORWARDING_CONFLICT");
        assert!(
            err.message_zh.contains("流 0") && err.message_zh.contains("流 1"),
            "{}",
            err.message_zh
        );
        assert!(err.message_zh.contains("sw01"), "{}", err.message_zh);
        assert!(
            err.message_zh.contains("同侧"),
            "含消解引导：{}",
            err.message_zh
        );
    }

    /// 本 session fix 核心回归：同 talker、不同 listener、经环拓扑不同路径汇合于交换机 s。
    /// 旧代码反向条目在 s 对 dest=talker 伪冲突（挡住合法配置）；forward-only 只钉各自 listener
    /// → 无冲突，汇合交换机对两个不同 listener 各持一条正向条目。
    #[test]
    fn forwarding_shared_talker_ring_no_false_conflict() {
        let nodes = vec![
            node("t", "endSystem"),
            node("l1", "endSystem"),
            node("l2", "endSystem"),
            node("s1", "switch"),
            node("s2", "switch"),
            node("s", "switch"),
        ];
        let links = vec![
            plink(0, "t", 0, "s1", 0),
            plink(1, "s1", 1, "s", 0),  // flow A: s1→s 直连
            plink(2, "s", 1, "l1", 0),  // flow A 终
            plink(3, "s1", 2, "s2", 0), // flow B: s1→s2
            plink(4, "s2", 1, "s", 2),  // flow B: s2→s（环：s1-s2-s-s1）
            plink(5, "s", 3, "l2", 0),  // flow B 终
        ];
        let port_eth = build_port_eth_map(&links);
        let ned = node_ned_names(&nodes);
        let flow_a = route_via(&[0, 1, 2], "t", "l1", &links); // t-s1-s-l1
        let flow_b = route_via(&[0, 3, 4, 5], "t", "l2", &links); // t-s1-s2-s-l2
        // forward-only：无伪冲突（旧代码在此对 dest=es01 反向冲突而失败）。
        let fwd = build_forwarding_tables(
            &[(0, flow_a), (1, flow_b)],
            &links,
            &port_eth,
            &ned,
            &sw_set(&nodes),
        )
        .unwrap();
        // t=es01, l1=es02, l2=es03；s1=sw01, s2=sw02, s=sw03。
        // sw01：去 l1(es02) 经 eth1、去 l2(es03) 经 eth2（不同 dest 共存）。
        assert_eq!(
            fwd.get("sw01").unwrap(),
            &vec![("es02%eth0".to_string(), 1), ("es03%eth0".to_string(), 2)]
        );
        // sw02：只 flow B 经过，去 l2(es03) 经 eth1。
        assert_eq!(
            fwd.get("sw02").unwrap(),
            &vec![("es03%eth0".to_string(), 1)]
        );
        // 汇合交换机 sw03：去 l1(es02) 经 eth1、去 l2(es03) 经 eth3——两不同 listener 各一条，
        // 不再对 dest=talker 伪冲突（fix 核心）。
        assert_eq!(
            fwd.get("sw03").unwrap(),
            &vec![("es02%eth0".to_string(), 1), ("es03%eth0".to_string(), 3)]
        );
    }

    /// 双平面 fixture：es01(mid1) 双宿 —A— sw01(mid0) —A— es02(mid2)；—B— sw02(mid3) —B—。
    /// GM=sw01(mid0)。es01/es02 端口 {0,1}：0→平面 A、1→平面 B（即 talker eth0 落平面 A）。
    fn dual_plane_sample() -> (Vec<VerifyNode>, Vec<VerifyLink>, Vec<SimNodeTiming>) {
        let nodes = vec![
            node("0", "switch"),
            node("1", "endSystem"),
            node("2", "endSystem"),
            node("3", "switch"),
        ];
        let plink = |seq: i64, src: &str, sp: i64, dst: &str, dp: i64, plane: &str| VerifyLink {
            link_seq: seq,
            src_node: src.into(),
            dst_node: dst.into(),
            src_port: Some(sp),
            dst_port: Some(dp),
            speed: None,
            styles_json: format!(r#"{{"plane":"{plane}"}}"#),
        };
        let links = vec![
            plink(0, "1", 0, "0", 0, "A"),
            plink(1, "0", 1, "2", 0, "A"),
            plink(2, "1", 1, "3", 0, "B"),
            plink(3, "3", 1, "2", 1, "B"),
        ];
        let t = |mid: &str, master: Vec<i64>, slave: Vec<i64>| SimNodeTiming {
            mid: mid.into(),
            master_port: master,
            slave_port: slave,
            sync_period_ms: None,
            measure_period_ms: None,
            offset_threshold_ns: None,
        };
        let timing = vec![
            t("0", vec![0, 1], vec![]), // GM sw01
            t("1", vec![], vec![0]),    // es01 slave 朝平面 A
            t("2", vec![], vec![0]),    // es02 slave 朝平面 A
            t("3", vec![], vec![0]),    // sw02 叶子
        ];
        (nodes, links, timing)
    }

    /// RC 会话流集：ST 单树（平面 A）+ RC 双树（A/B）+ BE（不进 configurator）。
    /// 端口按稠密下标：ST→1000、RC→1001、BE→1002。
    fn rc_session_streams() -> Vec<FlowStreamSpec> {
        vec![
            FlowStreamSpec {
                frer_trees: Some(vec![vec!["1".into(), "0".into(), "2".into()]]),
                ..spec(0, "ST", 7, "1", "2", 500, 512, 2000)
            },
            FlowStreamSpec {
                frer_trees: Some(vec![
                    vec!["1".into(), "0".into(), "2".into()],
                    vec!["1".into(), "3".into(), "2".into()],
                ]),
                ..spec(1, "RC", 6, "1", "2", 1000, 512, 1000)
            },
            spec(2, "BE", 0, "1", "2", 500, 512, 1000),
        ]
    }

    fn build_rc_session() -> TimesyncSimBundle {
        let (nodes, links, timing) = dual_plane_sample();
        build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "0",
            &timing,
            &SimOverrides {
                has_rc: true,
                ..Default::default()
            },
            &rc_session_streams(),
            FlowTasSchedule::Pin(&[], &[]),
            "s1",
            7,
        )
        .unwrap()
    }

    /// Covers R7（U4①）：RC 会话 ini 含 hasStreamRedundancy；configuration 里 ST 单树 +
    /// RC 双树（NED 名含拆分后的内嵌桥全路径）、每条带 pcp 键；ST/RC 不再写手工
    /// identifier/coder mapping；BE 不进 configuration。
    #[test]
    fn flow_rc_bundle_emits_frer_configuration() {
        let b = build_rc_session();
        let ini = &b.bundle.omnetpp_ini;
        assert!(ini.contains("*.*.hasStreamRedundancy = true"), "{ini}");
        assert!(
            ini.contains(
                "*.streamRedundancyConfigurator.typename = \"StreamRedundancyConfigurator\""
            ),
            "{ini}"
        );
        let cfg = ini
            .lines()
            .find(|l| l.starts_with("*.streamRedundancyConfigurator.configuration = "))
            .expect("应有 configuration 行");
        // ST 单树：平面 A 路径，双宿端点展开为 设备+内嵌桥（spike 契约改型）。
        assert!(
            cfg.contains(
                "{name: \"st0\", pcp: 7, packetFilter: expr(udp != nullptr && udp.destPort == 1000), source: \"es01\", destination: \"es02\", trees: [[[\"es01\",\"esb01\",\"sw01\",\"esb02\",\"es02\"]]]}"
            ),
            "{cfg}"
        );
        // RC 双树：A/B 各一棵。
        assert!(
            cfg.contains(
                "{name: \"rc1\", pcp: 6, packetFilter: expr(udp != nullptr && udp.destPort == 1001), source: \"es01\", destination: \"es02\", trees: [[[\"es01\",\"esb01\",\"sw01\",\"esb02\",\"es02\"]],[[\"es01\",\"esb01\",\"sw02\",\"esb02\",\"es02\"]]]}"
            ),
            "{cfg}"
        );
        // BE 不进 configuration（untagged pcp0 走 gate0）。
        assert!(!cfg.contains("1002"), "BE 不得进 configuration：{cfg}");
        assert!(!cfg.contains("\"be"), "BE 不得进 configuration：{cfg}");
        // ST/RC 不写手工 mapping（configurator 整体替换，叠加会让 ST 掉回 gate0——spike 押注①）。
        assert!(
            !ini.contains("streamIdentifier.identifier.mapping"),
            "RC 会话不得写手工 identifier mapping：{ini}"
        );
        assert!(
            !ini.contains("streamCoder"),
            "RC 会话不得写手工 coder mapping：{ini}"
        );
    }

    /// Covers U4②：无 RC 流 → ini 无 FRER 段、identifier/coder mapping 照旧（纯 ST 零变化）。
    #[test]
    fn flow_without_rc_has_no_frer_section() {
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
        assert!(!ini.contains("hasStreamRedundancy"), "{ini}");
        assert!(!ini.contains("streamRedundancyConfigurator"), "{ini}");
        // mapping 照旧。
        assert!(
            ini.contains("bridging.streamIdentifier.identifier.mapping"),
            "{ini}"
        );
        assert!(
            ini.contains("bridging.streamCoder.encoder.mapping"),
            "{ini}"
        );
        assert!(
            ini.contains("bridging.streamCoder.decoder.mapping"),
            "{ini}"
        );
        // NED 无拆分。
        assert!(
            !b.bundle.network_ned.contains("esb"),
            "{}",
            b.bundle.network_ned
        );
    }

    /// Covers U4③（镜像 stream_filter_guards_against_non_udp_packets）：FRER 段 packetFilter
    /// 必须带 udp != nullptr 守卫，不得出现裸 `expr(udp.destPort`。
    #[test]
    fn frer_packet_filter_guards_against_non_udp_packets() {
        let b = build_rc_session();
        let ini = &b.bundle.omnetpp_ini;
        assert!(
            ini.contains("packetFilter: expr(udp != nullptr && udp.destPort =="),
            "{ini}"
        );
        assert!(!ini.contains("expr(udp.destPort"), "{ini}");
    }

    /// Covers U4⑤：RC 会话的双宿端系统拆「TsnDevice + 内嵌 3 口 TsnSwitch」（spike 指令 1）：
    /// 设备单口、桥=原端口门号原样+内联口、库端口锚桥、内联线接通；gPTP 树多一跳（桥 BRIDGE_NODE）。
    #[test]
    fn dual_homed_rc_endpoint_splits_into_device_plus_bridge() {
        let b = build_rc_session();
        let ned = &b.bundle.network_ned;
        // 设备单口 + 内嵌桥（2 库端口 + 1 内联 = ethg[3]）。
        assert!(
            ned.contains(
                "        es01: TsnDevice {\n            gates:\n                ethg[1];\n        }"
            ),
            "{ned}"
        );
        assert!(
            ned.contains(
                "        esb01: TsnSwitch {\n            gates:\n                ethg[3];\n        }"
            ),
            "{ned}"
        );
        assert!(ned.contains("esb02: TsnSwitch"), "{ned}");
        // 库端口（门号原样）锚在内嵌桥上：es01 端口0→esb01.ethg[0] 接 sw01。
        assert!(
            ned.contains("        esb01.ethg[0] <--> EthernetLink { datarate = 1000Mbps; length = 10m; } <--> sw01.ethg[0];"),
            "{ned}"
        );
        // 内联线：设备 eth0 ↔ 桥内联口（=原端口数 2）。
        assert!(
            ned.contains("        es01.ethg[0] <--> EthernetLink { datarate = 1000Mbps; length = 10m; } <--> esb01.ethg[2];"),
            "{ned}"
        );
        // 非拆分节点零变化：交换机仍直接挂线。
        assert!(ned.contains("sw01: TsnSwitch"), "{ned}");
        // gPTP：设备成叶子（内联口 slave）、内嵌桥 BRIDGE_NODE（原 slave 口朝 GM + 内联口 master）。
        let ini = &b.bundle.omnetpp_ini;
        assert!(
            ini.contains("*.es01.gptp.gptpNodeType = \"SLAVE_NODE\""),
            "{ini}"
        );
        assert!(ini.contains("*.es01.gptp.slavePort = \"eth0\""), "{ini}");
        assert!(
            ini.contains("*.esb01.gptp.gptpNodeType = \"BRIDGE_NODE\""),
            "{ini}"
        );
        assert!(ini.contains("*.esb01.gptp.slavePort = \"eth0\""), "{ini}");
        assert!(
            ini.contains("*.esb01.gptp.masterPorts = [\"eth2\"]"),
            "{ini}"
        );
        // GM 是 sw01（未拆分），referenceClock 不变。
        assert!(ini.contains("**.referenceClock = \"sw01.clock\""), "{ini}");
    }

    /// Covers U4⑧（spike 押注⑤/KTD6）前半：无 RC 双平面且 talker eth0（最小库端口）所在
    /// 平面==推导平面 A → 零下发（缺省转发已确定性落 eth0 平面）。
    #[test]
    fn no_rc_dual_plane_talker_eth0_on_plane_a_emits_nothing() {
        let (nodes, links, timing) = dual_plane_sample();
        // es01 端口 0（→eth0）在平面 A 链路上。
        let streams = vec![FlowStreamSpec {
            pin_links: Some(vec![0, 1]),
            ..spec(0, "ST", 7, "1", "2", 500, 512, 2000)
        }];
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "0",
            &timing,
            &SimOverrides::default(),
            &streams,
            FlowTasSchedule::Pin(&[], &[]),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(!ini.contains("%eth"), "零下发：{ini}");
        assert!(!ini.contains("addStaticRoutes"), "零下发：{ini}");
        assert!(!ini.contains("configurator.config"), "零下发：{ini}");
        assert!(!b.bundle.network_ned.contains("esb"), "无 RC 不拆分");
    }

    /// Covers U4⑧ 后半：talker eth0 落平面 B（≠A）→ 三件套（%ethN 目的地址 + 手工 <route>
    /// + addStaticRoutes=false）出现在 ini。macTable 路线钉不动平面（spike 押注⑤），不生成。
    #[test]
    fn no_rc_dual_plane_talker_eth0_off_plane_a_emits_pin_kit() {
        let (nodes, mut links, timing) = dual_plane_sample();
        // 换 es01 端口：平面 A 用端口 5、平面 B 用端口 2 → eth0=端口2=平面 B。
        links[0].src_port = Some(5); // 1(p5) —A— 0
        links[2].src_port = Some(2); // 1(p2) —B— 3
        // 平面 A 路径 [1,0,2]：talker 出口端口5→eth1；listener 入口端口0→eth0。
        let streams = vec![FlowStreamSpec {
            pin_links: Some(vec![0, 1]),
            ..spec(0, "ST", 7, "1", "2", 500, 512, 2000)
        }];
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "0",
            &timing,
            &SimOverrides::default(),
            &streams,
            FlowTasSchedule::Pin(&[], &[]),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert!(
            ini.contains("*.es01.app[0].io.destAddress = \"es02%eth0\""),
            "{ini}"
        );
        assert!(
            ini.contains("*.configurator.addStaticRoutes = false"),
            "{ini}"
        );
        assert!(
            ini.contains(
                "<route hosts='es01' destination='es02%eth0' netmask='255.255.255.255' interface='eth1'/>"
            ),
            "{ini}"
        );
        assert!(ini.contains("<interface hosts='**'"), "{ini}");
        assert!(!ini.contains("macTable"), "不得走 macTable 路线：{ini}");
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

    // ---------- U5：互补关窗推导（R8/AE4 保护前提，KTD5）----------

    /// ST 门（gate7）GclEntry 简写。
    fn st_gate7(node: &str, eth_n: usize, init: bool, offset: u64, durs: Vec<u64>) -> GclEntry {
        GclEntry {
            node: node.into(),
            eth_n,
            gate_index: 7,
            initially_open: init,
            offset_ns: offset,
            durations_ns: durs,
            solver: "Z3".into(),
        }
    }
    fn qc_map(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs.iter().map(|(n, q)| (n.to_string(), *q)).collect()
    }
    fn rate_map(pairs: &[(&str, usize, u32)]) -> BTreeMap<(String, usize), u32> {
        pairs
            .iter()
            .map(|(n, e, r)| ((n.to_string(), *e), *r))
            .collect()
    }

    /// Covers R8（U5①⑥域）：单 ST 窗端口（开 [0,300us)）→ 每个非 ST 门（0..6）一条补集，
    /// 补集 = 周期减窗口：开 [300us,1ms)，表达为 offset=700000（序列原点=补集窗起点 300000）、
    /// durations=[700000,300000]。gate7 不生成；queue_count=8 的门下标域正确。
    #[test]
    fn complement_single_st_window_hand_computed() {
        let pinned = vec![st_gate7("0", 0, true, 0, vec![300_000, 700_000])];
        let out = complement_gcl(
            &pinned,
            &qc_map(&[("0", 8)]),
            &rate_map(&[("0", 0, 1000)]),
            false,
            true,
        )
        .unwrap();
        let gates: Vec<usize> = out.iter().map(|e| e.gate_index).collect();
        assert_eq!(gates, vec![0, 1, 2, 3, 4, 5, 6], "0..queue_count 除 gate7");
        for e in &out {
            assert_eq!(e.node, "0");
            assert_eq!(e.eth_n, 0);
            assert!(e.initially_open, "序列原点=补集窗起点，恒以开态起");
            assert_eq!(e.offset_ns, 700_000, "offset=(cycle-300000) mod cycle");
            assert_eq!(e.durations_ns, vec![700_000, 300_000]);
            assert_eq!(e.solver, COMPLEMENT_SOLVER);
        }
    }

    /// Covers R8（U5②）：同端口两条 ST 流两窗、其一跨 1ms 周期边界（offset 回绕）→
    /// 并集 [900k,1M)∪[0,100k)∪[400k,500k) 的补集 = [100k,400k)∪[500k,900k)，
    /// 表达为 offset=900000、durations=[300k,100k,400k,200k]（逐 ns 手算）。
    #[test]
    fn complement_union_multi_windows_with_wraparound() {
        let pinned = vec![
            // seq 开 [0,200k)，offset=100k → 绝对开窗 [900k,1M)∪[0,100k)（跨界拆两段）。
            st_gate7("0", 1, true, 100_000, vec![200_000, 800_000]),
            // seq 开 [0,100k)，offset=600k → 绝对开窗 [400k,500k)。
            st_gate7("0", 1, true, 600_000, vec![100_000, 900_000]),
        ];
        let out = complement_gcl(
            &pinned,
            &qc_map(&[("0", 8)]),
            &rate_map(&[("0", 1, 1000)]),
            false,
            true,
        )
        .unwrap();
        assert_eq!(out.len(), 7);
        for e in &out {
            assert!(e.initially_open);
            assert_eq!(e.offset_ns, 900_000, "序列原点=首个补集窗起点 100000");
            assert_eq!(
                e.durations_ns,
                vec![300_000, 100_000, 400_000, 200_000],
                "开300k/关100k/开400k/关200k，总和=1ms"
            );
        }
    }

    /// Covers R8（U5③）：补集碎片全部短于 MTU 帧发送时长（1Gbps 下 (1500+58)B→12464ns，
    /// 碎片各 5000ns）→ 响亮 Err，低优先级门不许永久锁死。
    #[test]
    fn complement_err_when_fragments_below_mtu_frame() {
        let pinned = vec![st_gate7(
            "0",
            0,
            true,
            0,
            vec![495_000, 5_000, 495_000, 5_000],
        )];
        let err = complement_gcl(
            &pinned,
            &qc_map(&[("0", 8)]),
            &rate_map(&[("0", 0, 1000)]),
            false,
            true,
        )
        .unwrap_err();
        assert_eq!(err.code, "complement_window_too_small");
        assert!(err.message_zh.contains("eth0"), "{}", err.message_zh);
        assert!(err.message_zh.contains("12464"), "{}", err.message_zh);
    }

    /// Covers R8（U5④）：ST 开窗占满整周期 → 补集为空，响亮 Err。
    #[test]
    fn complement_err_when_st_saturates_port() {
        let pinned = vec![st_gate7("0", 0, true, 0, vec![1_000_000])];
        let err = complement_gcl(
            &pinned,
            &qc_map(&[("0", 8)]),
            &rate_map(&[("0", 0, 1000)]),
            false,
            true,
        )
        .unwrap_err();
        assert_eq!(err.code, "st_windows_saturate_port");
        assert!(err.message_zh.contains("占满"), "{}", err.message_zh);
    }

    /// Covers KTD5（U5⑤/⑦域）：纯 ST 会话（无 BE/RC）→ 补集恒空；pin bundle 的 ini 只含
    /// gate7 的 4 行 transmissionGate 参数（initiallyOpen/offset/durations/guard band）——
    /// 与 U5 之前的 pin 输出逐行一致（位级回归口径）。
    #[test]
    fn complement_empty_for_pure_st_session_pin_ini_unchanged() {
        // 纯函数：生成门条件不满足 → 空集（连 Err 校验都不触发）。
        let pinned = vec![st_gate7("0", 1, true, 0, vec![300_000, 700_000])];
        assert!(
            complement_gcl(
                &pinned,
                &qc_map(&[("0", 8)]),
                &rate_map(&[("0", 1, 1000)]),
                false,
                false
            )
            .unwrap()
            .is_empty()
        );
        // bundle：纯 ST 流集 → ini 恰 4 行 transmissionGate（全在 gate7），无补集痕迹。
        let (nodes, links, timing) = sample();
        let streams = vec![FlowStreamSpec {
            max_latency_us: Some(300),
            ..spec(1, "ST", 7, "1", "2", 250, 500, 10000)
        }];
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            &streams,
            FlowTasSchedule::Pin(&pinned, &[]),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        assert_eq!(
            ini.matches(".macLayer.queue.transmissionGate[").count(),
            4,
            "纯 ST 会话 pin 段只该有 gate7 的 4 行：{ini}"
        );
        assert!(ini.contains("transmissionGate[7].enableImplicitGuardBand = false"));
        assert!(!ini.contains("transmissionGate[0]"), "{ini}");
    }

    /// Covers R8（U5⑥⑧ ini 面）：混流会话（ST+BE）→ ST 门带 enableImplicitGuardBand=false，
    /// 补集门（0..6）有 initiallyOpen/offset/durations 但**无**该行（保持 INET 默认 true）；
    /// 无 ST 窗的端口（sw01 eth0）不生成任何 transmissionGate 条目（各门恒开）。
    #[test]
    fn pin_complement_gates_omit_implicit_guard_band() {
        let (nodes, links, timing) = sample();
        let pinned = vec![st_gate7("0", 1, true, 0, vec![300_000, 700_000])];
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "1",
            &timing,
            &SimOverrides::default(),
            &flow_streams(), // BE + ST 混流
            FlowTasSchedule::Pin(&pinned, &[]),
            "s1",
            7,
        )
        .unwrap();
        let ini = &b.bundle.omnetpp_ini;
        // ST 门维持显式关隐式保护带（真机验证关键行，勿回退）。
        assert!(
            ini.contains(
                "*.sw01.eth[1].macLayer.queue.transmissionGate[7].enableImplicitGuardBand = false"
            ),
            "{ini}"
        );
        // 补集门 0..6 全在、参数为手算补集，且不带 enableImplicitGuardBand 行。
        for gate in 0..7 {
            let base = format!("*.sw01.eth[1].macLayer.queue.transmissionGate[{gate}]");
            assert!(
                ini.contains(&format!("{base}.initiallyOpen = true")),
                "{ini}"
            );
            assert!(ini.contains(&format!("{base}.offset = 700000ns")), "{ini}");
            assert!(
                ini.contains(&format!("{base}.durations = [700000ns, 300000ns]")),
                "{ini}"
            );
            assert!(
                !ini.contains(&format!("{base}.enableImplicitGuardBand")),
                "补集门不得写 enableImplicitGuardBand（保持默认 true）：{ini}"
            );
        }
        // 无 ST 窗端口零条目（R8：各门恒开）。
        assert!(
            !ini.contains("eth[0].macLayer.queue.transmissionGate"),
            "无 ST 窗端口不得生成补集：{ini}"
        );
    }

    /// Covers U5⑦：queue_count=4 的节点带 gate7 ST 条目 → 门表与节点配置矛盾，响亮 Err
    /// （口径：Err 而非跳过——该 pin 在 INET 里本身就越界，静默跳过会掩盖坏配置）。
    #[test]
    fn complement_err_when_st_gate_exceeds_queue_count() {
        let pinned = vec![st_gate7("0", 0, true, 0, vec![300_000, 700_000])];
        let err = complement_gcl(
            &pinned,
            &qc_map(&[("0", 4)]),
            &rate_map(&[("0", 0, 1000)]),
            false,
            true,
        )
        .unwrap_err();
        assert_eq!(err.code, "st_gate_exceeds_queue_count");
        assert!(err.message_zh.contains("队列数 4"), "{}", err.message_zh);
    }

    /// Covers R8（U5⑧ 纯函数面）：混流会话里只有 ("0",eth1) 有 ST 窗 → 其余节点/端口
    /// （含 queue_counts 里的 "3"、同节点 eth0）不生成任何条目。
    #[test]
    fn complement_only_for_ports_with_st_windows() {
        let pinned = vec![st_gate7("0", 1, true, 0, vec![300_000, 700_000])];
        let out = complement_gcl(
            &pinned,
            &qc_map(&[("0", 8), ("3", 8)]),
            &rate_map(&[("0", 1, 1000), ("0", 0, 1000), ("3", 0, 1000)]),
            true,
            true,
        )
        .unwrap();
        assert_eq!(out.len(), 7);
        assert!(
            out.iter().all(|e| e.node == "0" && e.eth_n == 1),
            "只有带 ST 窗的端口生成补集：{out:?}"
        );
    }

    /// Covers KTD5 帧开销口径：MTU 校验用 flow_frame_overhead_bytes(has_rc)——补集窗 12480ns
    /// 在无 RC（需 12464ns）时通过、有 RC（+4B R-TAG → 需 12496ns）时响亮 Err。
    #[test]
    fn complement_mtu_check_includes_rtag_overhead_when_rc() {
        let pinned = vec![st_gate7("0", 0, true, 0, vec![987_520, 12_480])];
        let qc = qc_map(&[("0", 8)]);
        let rates = rate_map(&[("0", 0, 1000)]);
        assert!(complement_gcl(&pinned, &qc, &rates, false, true).is_ok());
        let err = complement_gcl(&pinned, &qc, &rates, true, false).unwrap_err();
        assert_eq!(err.code, "complement_window_too_small");
        assert!(err.message_zh.contains("12496"), "{}", err.message_zh);
    }

    /// ST 门表周期 ≠ 1ms 门控周期 → 无法取补，响亮 Err（防对错周期做补集算术）。
    #[test]
    fn complement_err_on_cycle_mismatch() {
        let pinned = vec![st_gate7("0", 0, true, 0, vec![300_000])];
        let err = complement_gcl(
            &pinned,
            &qc_map(&[("0", 8)]),
            &rate_map(&[("0", 0, 1000)]),
            false,
            true,
        )
        .unwrap_err();
        assert_eq!(err.code, "gcl_cycle_mismatch");
    }

    // ---------- U6：断链故障轮（ScenarioManager disconnect）----------

    /// Covers U6①⑦（bundle 面，spike run4 逐字）：fault 参数 → NED 加 import + scenarioManager
    /// 子模块（押注④：hasStatus 不需要）、ini 出单向 TX disconnect 脚本。src-module 经 SplitEs
    /// 映射（断双宿 talker 首跳 → esb 桥名）、ethN 经 build_port_eth_map、t 为 ns 精确值。
    #[test]
    fn fault_emits_scenario_manager_and_disconnect_script() {
        let (nodes, links, timing) = dual_plane_sample();
        let b = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "0",
            &timing,
            &SimOverrides {
                has_rc: true,
                fault: Some(FaultSpec {
                    src_mid: "1".into(),
                    src_db_port: 0,
                    t_break_ns: 400_000_000,
                }),
                ..Default::default()
            },
            &rc_session_streams(),
            FlowTasSchedule::Pin(&[], &[]),
            "s1",
            7,
        )
        .unwrap();
        let ned = &b.bundle.network_ned;
        assert!(
            ned.contains("import inet.common.scenario.ScenarioManager;"),
            "{ned}"
        );
        assert!(
            ned.contains("        scenarioManager: ScenarioManager;\n"),
            "{ned}"
        );
        assert!(!ned.contains("hasStatus"), "押注④ hasStatus 不需要：{ned}");
        // es01(mid1) 是 RC talker 且双宿 → 拆分：库端口 0 锚在 esb01 → src-module=esb01、eth0。
        let ini = &b.bundle.omnetpp_ini;
        assert!(
            ini.contains(
                "*.scenarioManager.script = xml(\"<script><at t='400000000ns'><disconnect src-module='esb01' src-gate='ethg$o[0]'/></at></script>\")"
            ),
            "{ini}"
        );
    }

    /// U6 健康轮零变化：fault=None → NED/ini 均无 scenarioManager 痕迹（RC 会话也不例外）。
    #[test]
    fn no_fault_has_no_scenario_manager() {
        let b = build_rc_session();
        assert!(
            !b.bundle.network_ned.contains("ScenarioManager"),
            "{}",
            b.bundle.network_ned
        );
        assert!(
            !b.bundle.omnetpp_ini.contains("scenarioManager"),
            "{}",
            b.bundle.omnetpp_ini
        );
    }

    /// 断链端点映射不上（未知库端口）→ 响亮 Err 不装配。
    #[test]
    fn fault_unmapped_endpoint_errors() {
        let (nodes, links, timing) = dual_plane_sample();
        let err = build_flow_tas_sim_bundle(
            &nodes,
            &links,
            "0",
            &timing,
            &SimOverrides {
                has_rc: true,
                fault: Some(FaultSpec {
                    src_mid: "1".into(),
                    src_db_port: 9, // es01 没有库端口 9。
                    t_break_ns: 400_000_000,
                }),
                ..Default::default()
            },
            &rc_session_streams(),
            FlowTasSchedule::Pin(&[], &[]),
            "s1",
            7,
        )
        .unwrap_err();
        assert!(
            err.iter().any(|e| e.code == "fault_endpoint_unmapped"),
            "{err:?}"
        );
    }
}
