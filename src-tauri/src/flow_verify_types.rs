//! `verify_tas` 的共享 DTO 与跨簇常量（自 `flow_verify_command` 拆出；消费方：
//! `flow_verify_command` / `flow_verify_verdict`）。

use serde::Serialize;

pub const CALIBER_FLOW_TAS_VERIFIED: &str = "flow_tas_verified";
/// 抖动上限 1us（R15）。
pub(crate) const JITTER_LIMIT_NS: f64 = 1_000.0;
/// per-packet 时延 + 抖动向量 + clock timeChanged 向量 filter（U1 spike 钉死流量向量名；
/// 时钟子句与 timesync 的 TIMECHANGED_FILTER 同形，R15 诊断行取数——同一份 CSV 流量向量走
/// `parse_vec_csv`、时钟向量走 `parse_timechanged_csv`）。
pub(crate) const FLOW_VERIFY_FILTER: &str = "name=~\"packetLifeTime:vector\" OR name=~\"packetJitter:vector\" OR (module=~\"**.clock\" AND name=~\"timeChanged:vector\")";

/// 单流实测判决。U7 additive 新增：class（分级判据）、judged（该轮是否下判——故障轮 ST/BE
/// 与未被断链覆盖的 RC 只报告不判，judged=false 时 pass 恒 true 不阻塞轮次聚合、note 说明
/// 报告态）、delivery_ratio（BE 送达率=收/实发，只展示不判，R13）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamVerdict {
    pub stream_seq: i64,
    /// 流类别（ST/RC/BE）。
    pub class: String,
    pub talker: String,
    pub listener: String,
    pub received: usize,
    pub expected: i64,
    pub jitter_max_ns: f64,
    pub latency_max_ns: f64,
    pub window_ns: f64,
    pub pass: bool,
    /// 该轮是否对此流下判（U7 分级）。
    pub judged: bool,
    /// BE 送达率（收/实发）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_ratio: Option<f64>,
    /// 报告态备注（「仅健康轮判」/「未测容错」）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 每轮 gPTP 收敛诊断（R15，只报告、不参与任何 verdict）：复用 timesync 判据三件套
/// （parse_timechanged_csv / steady_state_offset / 逐节点 offset_threshold，缺省回退
/// 1000ns 全局兜底）。故障轮断链下游时钟劣化属预期，照实报告（断链标注在 annotations）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GptpDiag {
    pub converged_nodes: usize,
    pub total_nodes: usize,
    /// 阈值概览：各节点生效阈值全相同 → 「1000ns」；逐节点混合 → 「200–1000ns」。
    pub threshold_summary: String,
    /// 稳态 offset 最大的节点（ned 名）。
    pub worst_node: String,
    pub worst_offset_ns: f64,
}

/// 单轮验证结果（U6 断链故障轮编排，R9/AE2）。healthy 轮无断链；fault_a/fault_b 各断该平面
/// 覆盖最多 RC 流的一条链路（KTD8）。U7：per_stream 按类分级判决 + gPTP 诊断行。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRound {
    /// healthy | fault_a | fault_b
    pub round: String,
    /// ok | fail | empty | load_failed | unreachable | busy | bundle_error。
    /// busy = 服务端 409 单运行锁（环境冲突，不判验证 FAIL）；顶层 status 仍归 unreachable
    /// 保持既有前端词表。ok/fail 只看该轮**下判**的流（judged=false 的报告态不计）。
    pub status: String,
    pub per_stream: Vec<StreamVerdict>,
    /// 响亮标注（KTD2）：断点描述 / 时钟树边重叠 / ST 路由重叠 / 运行错误详情。
    pub annotations: Vec<String>,
    /// 该轮未被断链途经的 RC 流（「未测容错」字符串；KTD8。per_stream 行同时带 note）。
    pub untested_streams: Vec<String>,
    /// gPTP 收敛诊断行（R15，只报告不判）。取不到时钟向量（旧结果/该轮失败）→ None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gptp_diag: Option<GptpDiag>,
}

/// 验证结果（前端/agent 消费）。KTD7 诚实边界：caliber 恒 flow_tas_verified（仿真实测·非 T10）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTasResult {
    pub caliber: String,
    /// ok | no_plan | no_streams | pcp_mismatch | no_gm | route_error | bundle_error | unreachable | load_failed | empty | fail | fault_window_too_short
    pub status: String,
    pub per_stream: Vec<StreamVerdict>,
    pub overall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// U6 多轮结果：有 RC 流 → [healthy, fault_a, fault_b]；无 RC → None（序列化零变化，
    /// 现状回归）。顶层 status/per_stream 恒为健康轮结果（向后兼容），overall 串联各轮摘要
    /// （最差轮可见，KTD3）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rounds: Option<Vec<VerifyRound>>,
    /// 顶层 gPTP 收敛诊断（R15 收尾，U8）：恒为健康轮诊断——有 rounds 时与健康轮的
    /// gptpDiag 同值；无 rounds（纯 ST / ST+BE / 纯 BE 会话）时从该次运行 CSV 算，
    /// 使无 RC 会话也有诊断行。取不到时钟向量 → None（缺席，不臆造）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gptp_diag: Option<GptpDiag>,
}

impl VerifyTasResult {
    pub(crate) fn simple(status: &str, overall: &str, message: Option<String>) -> Self {
        Self {
            caliber: CALIBER_FLOW_TAS_VERIFIED.to_string(),
            status: status.to_string(),
            per_stream: vec![],
            overall: overall.to_string(),
            message,
            rounds: None,
            gptp_diag: None,
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTasRequest {
    pub session_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R15：filter 拼了 clock timeChanged 子句（与 timesync TIMECHANGED_FILTER 同形），
    /// 流量向量子句不动。
    #[test]
    fn flow_verify_filter_includes_clock_clause() {
        assert!(FLOW_VERIFY_FILTER.contains("name=~\"packetLifeTime:vector\""));
        assert!(FLOW_VERIFY_FILTER.contains("name=~\"packetJitter:vector\""));
        assert!(
            FLOW_VERIFY_FILTER
                .contains("OR (module=~\"**.clock\" AND name=~\"timeChanged:vector\")"),
            "{FLOW_VERIFY_FILTER}"
        );
    }

    /// Covers U6⑧ + U7⑦：rounds serde 契约——camelCase（rounds/round/perStream/annotations/
    /// untestedStreams/gptpDiag 及 StreamVerdict 新字段 class/judged/deliveryRatio/note），
    /// 无 snake_case 泄漏。
    #[test]
    fn rounds_serde_camel_case() {
        let r = VerifyTasResult {
            caliber: CALIBER_FLOW_TAS_VERIFIED.to_string(),
            status: "ok".into(),
            per_stream: vec![],
            overall: "x".into(),
            message: None,
            rounds: Some(vec![VerifyRound {
                round: "fault_a".into(),
                status: "busy".into(),
                per_stream: vec![StreamVerdict {
                    stream_seq: 0,
                    class: "BE".into(),
                    talker: "1".into(),
                    listener: "2".into(),
                    received: 2,
                    expected: 4,
                    jitter_max_ns: 1.0,
                    latency_max_ns: 2.0,
                    window_ns: 3.0,
                    pass: true,
                    judged: false,
                    delivery_ratio: Some(0.5),
                    note: Some("仅健康轮判（故障轮不判）".into()),
                    reason: None,
                }],
                annotations: vec!["a".into()],
                untested_streams: vec!["流 1：未测容错".into()],
                gptp_diag: Some(GptpDiag {
                    converged_nodes: 3,
                    total_nodes: 4,
                    threshold_summary: "1000ns".into(),
                    worst_node: "sw02".into(),
                    worst_offset_ns: 1500.0,
                }),
            }]),
            // R15 收尾：顶层诊断键与轮内同名（camelCase gptpDiag），serde 断言共用下方检查。
            gptp_diag: Some(GptpDiag {
                converged_nodes: 3,
                total_nodes: 4,
                threshold_summary: "1000ns".into(),
                worst_node: "sw02".into(),
                worst_offset_ns: 1500.0,
            }),
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"rounds\""), "{json}");
        assert!(json.contains("\"round\":\"fault_a\""), "{json}");
        assert!(json.contains("\"untestedStreams\""), "{json}");
        assert!(json.contains("\"perStream\""), "{json}");
        assert!(json.contains("\"annotations\""), "{json}");
        assert!(json.contains("\"class\":\"BE\""), "{json}");
        assert!(json.contains("\"judged\":false"), "{json}");
        assert!(json.contains("\"deliveryRatio\":0.5"), "{json}");
        assert!(json.contains("\"note\""), "{json}");
        assert!(json.contains("\"gptpDiag\""), "{json}");
        assert!(json.contains("\"convergedNodes\":3"), "{json}");
        assert!(json.contains("\"totalNodes\":4"), "{json}");
        assert!(json.contains("\"thresholdSummary\":\"1000ns\""), "{json}");
        assert!(json.contains("\"worstNode\":\"sw02\""), "{json}");
        assert!(json.contains("\"worstOffsetNs\":1500.0"), "{json}");
        assert!(!json.contains("untested_streams"), "{json}");
        assert!(!json.contains("per_stream"), "{json}");
        assert!(!json.contains("delivery_ratio"), "{json}");
        assert!(!json.contains("gptp_diag"), "{json}");
    }
}
