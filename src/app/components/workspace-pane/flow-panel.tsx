import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionDbListener } from "../../hooks/use-session-db-listener";
import { FlowDetailModal } from "./flow-detail-modal";
import {
  buildGclOverview,
  type GclDetail,
  gclPresentation,
  gptpDiagLine,
  invokeGetGclDetail,
  invokeListFlowStreams,
  invokePlanTas,
  invokeVerifyTas,
  isZ3Guaranteed,
  type ListFlowStreamRow,
  type ListFlowStreamsResult,
  type PlanResult,
  type PlanUiState,
  planAllowsVerify,
  planSucceeded,
  roundLabel,
  roundStatusLabel,
  type StreamVerdict,
  showVerifyTable,
  type VerifyRound,
  type VerifyTasResult,
  type VerifyUiState,
  verifyAllPass,
} from "./flow-sim";
import { FlowStreamList } from "./flow-stream-list";
import { type FlowSubTab, FlowSubTabs } from "./flow-subtabs";
import { GclDetailModal } from "./gcl-detail-modal";
import { GclOverviewSection, SolverBadge } from "./gcl-overview";
import { PanelCta } from "./panel-cta";

export interface FlowPanelProps {
  /** 当前阶段是否 flow-template。 */
  inFlowStage: boolean;
  sessionId: string;
  /** App 级规划/验证运行态（切 tab 不取消命令，同 timesync 先例）。 */
  planState: PlanUiState;
  onPlanStateChange: (state: PlanUiState) => void;
  verifyState: VerifyUiState;
  onVerifyStateChange: (state: VerifyUiState) => void;
  /** 流量规划面板当前子 tab（App 级，随会话重置）。 */
  activeFlowSubTab: FlowSubTab;
  onSelectFlowSubTab: (tab: FlowSubTab) => void;
  /** 选中流量序号（flow-list 子 tab 用，null 表示未选；随会话重置）。 */
  selectedFlowSeq: number | null;
  onSelectFlowSeq: (seq: number | null) => void;
  /** 写通道（测试注入替身）。 */
  planTas?: (sessionId: string) => Promise<PlanResult>;
  verifyTas?: (sessionId: string) => Promise<VerifyTasResult>;
  /** 流集查询读通道（U4，测试注入替身）。 */
  listFlowStreams?: (sessionId: string) => Promise<ListFlowStreamsResult>;
  /** 门控明细读通道（KTD1/KTD8 单查询：头行三态 + 概览八卡 + 透传 GclDetailModal；
   * 测试注入替身）。 */
  getGclDetail?: (sessionId: string) => Promise<GclDetail>;
  /** R16 路径预览联动（透传 FlowDetailModal → WorkspacePane 画布高亮）。 */
  onPreviewPath?: (linkSeqs: number[] | null) => void;
}

/** 门控明细查询态（组件内）：loading=取数中、unavailable=取数失败（回退按钮态判据）、
 * loaded=有数据。 */
type GclQueryState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "loaded"; detail: GclDetail };

export function FlowPanel({
  inFlowStage,
  sessionId,
  planState,
  onPlanStateChange,
  verifyState,
  onVerifyStateChange,
  activeFlowSubTab,
  onSelectFlowSubTab,
  selectedFlowSeq,
  onSelectFlowSeq,
  planTas = invokePlanTas,
  verifyTas = invokeVerifyTas,
  listFlowStreams = invokeListFlowStreams,
  getGclDetail = invokeGetGclDetail,
  onPreviewPath,
}: FlowPanelProps) {
  // ref 即时拦并发（disabled 态下一拍才生效，防双击派发第二次）。
  const planInflight = useRef(false);
  const verifyInflight = useRef(false);
  // await 落地后据当前会话判定是否切走（闭包定格的是发起时的 sessionId）。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // U8：详情弹窗 + 重规划提示 banner（切会话重置）。
  const [openModalStream, setOpenModalStream] = useState<ListFlowStreamRow | null>(null);
  const [bannerVisible, setBannerVisible] = useState(false);
  // U5：门控详情弹窗开关（切会话重置）。
  const [gclDetailOpen, setGclDetailOpen] = useState(false);

  // KTD1/KTD8 单查询：门控明细（get_gcl_detail）——头行三态 + 概览八卡数据源，面板挂载即拉，
  // 展示态由数据推导（切会话回来凭数据恢复）。三触发源（挂载·切会话 / 规划完成 / flow domain
  // DB 变更）共用；requestSeq 丢弃过期响应（会话已切或更新请求在途）。失败置 unavailable
  // （不吞、头行仍由 planState 供）。
  const [gclQuery, setGclQuery] = useState<GclQueryState>({ status: "loading" });
  const gclQueryReqRef = useRef(0);
  const refreshGclQuery = useCallback(async () => {
    const seq = ++gclQueryReqRef.current;
    try {
      const detail = await getGclDetail(sessionId);
      if (gclQueryReqRef.current === seq) setGclQuery({ status: "loaded", detail });
    } catch {
      if (gclQueryReqRef.current === seq) setGclQuery({ status: "unavailable" });
    }
  }, [getGclDetail, sessionId]);

  // 挂载 / 切会话：先回 loading（避免闪旧数据 + 抑制 CTA 闪现），再取。
  useEffect(() => {
    setGclQuery({ status: "loading" });
    void refreshGclQuery();
  }, [refreshGclQuery]);

  // 规划完成（含 no_gating 清表 / solver_failed 旧表保留）后刷新明细；切 tab 卸载重挂后再变 done
  // 也刷新（不再在 handlePlan 里内联取数——重挂后内联块随旧闭包丢失）。
  useEffect(() => {
    if (planState.status === "done") {
      void refreshGclQuery();
    }
  }, [planState, refreshGclQuery]);

  // U4：流集查询态（挂载即拉，DB 变更重拉；requestSeq 丢弃过期响应）。
  const [streams, setStreams] = useState<ListFlowStreamRow[]>([]);
  const [streamsLoading, setStreamsLoading] = useState(true);
  const streamsReqRef = useRef(0);
  const refreshStreams = useCallback(async () => {
    const seq = ++streamsReqRef.current;
    setStreamsLoading(true);
    try {
      const result = await listFlowStreams(sessionId);
      if (streamsReqRef.current === seq) {
        setStreams(result.streams);
        setStreamsLoading(false);
      }
    } catch {
      if (streamsReqRef.current === seq) {
        setStreams([]);
        setStreamsLoading(false);
      }
    }
  }, [listFlowStreams, sessionId]);

  // 挂载 / 切会话：先清旧数据回 loading，再取；同时重置 U8 弹窗和 banner。
  useEffect(() => {
    setStreams([]);
    setStreamsLoading(true);
    setOpenModalStream(null);
    setBannerVisible(false);
    setGclDetailOpen(false);
    void refreshStreams();
  }, [refreshStreams]);

  // flow domain 写库（agent 录流 / 规划落库）→ 重拉（照 timesync 消费先例，非 Tauri 环境 no-op）。
  useSessionDbListener({
    sessionId,
    onChange: () => {
      void refreshGclQuery();
      void refreshStreams();
    },
  });

  const planning = planState.status === "running";
  const verifying = verifyState.status === "running";
  // KTD1 三态（数据推导）：planned / no-gating / unplanned。取数失败回退 unplanned（按钮闸退回
  // planState 口径，同现状）。
  const queryPresentation =
    gclQuery.status === "loaded" ? gclPresentation(gclQuery.detail) : "unplanned";
  // 验证按钮闸（R5/KTD4 口径升级）：planState 放行（本次会话规划过/no_gating），或查询三态
  // 非未规划（库里有门控表 / 流集无 ST 无需门控）。
  const havePlan =
    (planState.status === "done" && planAllowsVerify(planState.result)) ||
    queryPresentation !== "unplanned";
  // 挂载取数未回前（planState 无瞬态记忆）：既不下判 fresh 也不出结果——空占位，防已规划会话
  // 挂载时 CTA 闪现被误点（loading 一律不出 CTA，等数据落定再决定 CTA/结果，item 7）。
  const idleLoading = planState.status === "idle" && gclQuery.status === "loading";
  // KTD3 渐进式：未规划（无运行/错误/结果记忆，数据推导=未规划，且已非 loading）→ 居中 CTA；
  // 否则按钮收命令栏右上。
  const fresh = planState.status === "idle" && !idleLoading && queryPresentation === "unplanned";

  const planDisabled = !inFlowStage || planning;
  const verifyDisabled = !inFlowStage || verifying || planning || !havePlan;

  async function handlePlan() {
    if (planDisabled || planInflight.current) return;
    planInflight.current = true;
    const runSessionId = sessionId;
    onPlanStateChange({ status: "running" });
    try {
      const result = await planTas(runSessionId);
      if (runSessionId !== sessionIdRef.current) return;
      // 规划落地 → planState 转 done；明细刷新由 done effect 统一驱动（切 tab 重挂后完成也刷新，
      // 且刷新失败不吞——见 refreshPlanQuery）。
      onPlanStateChange({ status: "done", result });
    } catch (error) {
      if (runSessionId !== sessionIdRef.current) return;
      onPlanStateChange({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      planInflight.current = false;
    }
  }

  async function handleVerify() {
    if (verifyDisabled || verifyInflight.current) return;
    verifyInflight.current = true;
    const runSessionId = sessionId;
    onVerifyStateChange({ status: "running" });
    try {
      const result = await verifyTas(runSessionId);
      if (runSessionId !== sessionIdRef.current) return;
      onVerifyStateChange({ status: "done", result });
    } catch (error) {
      if (runSessionId !== sessionIdRef.current) return;
      onVerifyStateChange({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      verifyInflight.current = false;
    }
  }

  return (
    <section
      className="detail-panel flow-panel"
      id="config-panel-flow"
      role="tabpanel"
      aria-label="流量规划"
    >
      <FlowSubTabs activeSubTab={activeFlowSubTab} onSelectSubTab={onSelectFlowSubTab} />

      {/* U8：重规划提示 banner（参数变更后在 flow-list 子 tab 顶部显示）。 */}
      {activeFlowSubTab === "flow-list" && bannerVisible && (
        <div className="flow-replan-banner">
          <span>流量参数已变更，建议重新规划门控表</span>
          <button type="button" onClick={() => setBannerVisible(false)} aria-label="关闭">
            ×
          </button>
        </div>
      )}

      {activeFlowSubTab === "flow-list" && (
        <div
          key={sessionId}
          id="flow-subpanel-flow-list"
          role="tabpanel"
          aria-labelledby="flow-subtab-flow-list"
          className="flow-subpanel"
        >
          <FlowStreamList
            streams={streams}
            selectedFlowSeq={selectedFlowSeq}
            onSelectFlowSeq={onSelectFlowSeq}
            onOpenDetail={(s) => setOpenModalStream(s)}
            inFlowStage={inFlowStage}
            isLoading={streamsLoading}
          />
        </div>
      )}

      {activeFlowSubTab === "gate-plan" && (
        <div
          key={sessionId}
          id="flow-subpanel-gate-plan"
          role="tabpanel"
          aria-labelledby="flow-subtab-gate-plan"
          className="flow-subpanel"
        >
          {/* 命令栏：右侧规划按钮。渐进式（KTD3）：未规划态规划按钮在 body CTA，有结果后收进右上角。 */}
          <div className="timesync-commandbar flow-commandbar">
            <div className="timesync-commandbar__actions" role="group" aria-label="门控规划操作">
              {!fresh && !idleLoading && (
                <>
                  {/* U5：门控详情弹窗入口（无规划数据禁用——数据推导口径同时序图显隐）。 */}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setGclDetailOpen(true)}
                    disabled={queryPresentation !== "planned"}
                    title={queryPresentation !== "planned" ? "请先规划出门控表" : undefined}
                  >
                    门控详情
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void handlePlan()}
                    disabled={planDisabled}
                  >
                    {planning ? "综合中…（分钟级）" : "重新规划"}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* R22：分钟级综合进行中反馈。 */}
          {planning && <p className="flow-progress mono">正在跑 Z3 门控综合，分钟级，请稍候…</p>}

          {/* 判定头行（「门控表·N条目 + 求解器徽章」/失败信息）置于概览之上（boss 定）。 */}
          {idleLoading ? null : fresh ? (
            <PanelCta
              label="规划门控表"
              hint="用 INET Z3 配置器综合 802.1Qbv 门控表（GCL），结果落库；明细在「门控详情」弹窗查看。"
              onClick={() => void handlePlan()}
              disabled={planDisabled}
              title={!inFlowStage ? "请先进入流量规划阶段" : undefined}
            />
          ) : (
            <PlanResultArea planState={planState} gclQuery={gclQuery} />
          )}

          {/* U9/R15：门控概览八卡（仅已规划态渲染；数据源=get_gcl_detail，与详情弹窗同源 KTD8）。 */}
          {queryPresentation === "planned" && gclQuery.status === "loaded" && (
            <GclOverviewSection overview={buildGclOverview(gclQuery.detail)} />
          )}

          {/*
            R4：RC 流的 redundant/paths 字段「仅 RC 才显」是**录入表单**规则；本面板是规划/软仿
            结果面板，本期不建录入表单（流经会话 agent 录入）。表单条件渲染代码留后续面板 PR，
            显隐规则已在 plan/U9 固化为规格。
          */}
        </div>
      )}

      {activeFlowSubTab === "soft-sim" && (
        <div
          key={sessionId}
          id="flow-subpanel-soft-sim"
          role="tabpanel"
          aria-labelledby="flow-subtab-soft-sim"
          className="flow-subpanel"
        >
          {/* 命令栏（对齐 timesync-commandbar）：左侧 R21 诚实边界常驻标注，右侧软仿按钮。 */}
          <div className="timesync-commandbar flow-commandbar">
            <p className="flow-honesty-note">仿真实测 · 非 T10 硬件判决</p>
            <div className="timesync-commandbar__actions" role="group" aria-label="软仿操作">
              <button
                type="button"
                className="btn primary"
                onClick={() => void handleVerify()}
                disabled={verifyDisabled}
                title={!havePlan ? "请先规划出门控表" : undefined}
              >
                {verifying ? "软仿中…（分钟级）" : "软仿验证"}
              </button>
            </div>
          </div>

          {/* R22：分钟级软仿进行中反馈（U7：含 RC 流时为三轮，逐轮分钟级）。 */}
          {verifying && (
            <p className="flow-progress mono">
              正在跑 pin 软仿实测（含 RC 流时为健康+断A+断B 三轮，逐轮分钟级），请稍候…
            </p>
          )}

          <VerifyResultArea verifyState={verifyState} />
        </div>
      )}

      {activeFlowSubTab === "hw-deploy" && (
        <div
          key={sessionId}
          id="flow-subpanel-hw-deploy"
          role="tabpanel"
          aria-labelledby="flow-subtab-hw-deploy"
          className="flow-subpanel"
        >
          <div className="empty-panel mono">硬件部署即将推出</div>
        </div>
      )}

      {/* U8：流量详情弹窗（portal 级，渲染在所有子 tab 内容之外）。 */}
      <FlowDetailModal
        stream={openModalStream}
        sessionId={sessionId}
        onPreviewPath={onPreviewPath}
        onClose={() => setOpenModalStream(null)}
        onSaved={(didChangePlanningFields) => {
          if (didChangePlanningFields) setBannerVisible(true);
          // 保存后重拉流集（反映更新后的数据）。
          void refreshStreams();
        }}
      />

      {/* U5：门控详情弹窗（全屏三页签，portal 级挂法同 FlowDetailModal）。 */}
      <GclDetailModal
        open={gclDetailOpen}
        sessionId={sessionId}
        onClose={() => setGclDetailOpen(false)}
        getGclDetail={getGclDetail}
      />
    </section>
  );
}

/**
 * 规划结果区（U2→boss 精简）：仅判定头行（planState 瞬态优先，否则凭查询数据恢复）。
 * 时序图/明细表已并入门控详情弹窗，面板不再重复。
 */
function PlanResultArea({
  planState,
  gclQuery,
}: {
  planState: PlanUiState;
  gclQuery: GclQueryState;
}) {
  const detail = gclQuery.status === "loaded" ? gclQuery.detail : undefined;
  const presentation = detail ? gclPresentation(detail) : "unplanned";

  let head: ReactNode = null;
  if (planState.status === "error") {
    head = <p className="flow-message mono flow-error">规划失败：{planState.message}</p>;
  } else if (planState.status === "done") {
    const result = planState.result;
    if (planSucceeded(result)) {
      head = (
        <div className="sim-overall converged flow-overall" role="status" aria-label="规划总判定">
          {result.overall}
          {result.solver && <SolverBadge solver={result.solver} z3={isZ3Guaranteed(result)} />}
        </div>
      );
    } else if (result.status === "no_gating") {
      // KTD3：no_gating → 蓝色信息条，不画空图。
      head = (
        <div className="flow-gcl-info" role="status" aria-label="规划总判定">
          {result.overall}
        </div>
      );
    } else {
      head = (
        <>
          <div className="sim-overall warn flow-overall" role="status" aria-label="规划总判定">
            {result.overall}
          </div>
          {result.message && <p className="flow-message mono">{result.message}</p>}
        </>
      );
    }
  } else if (detail && presentation === "planned") {
    // 无本次运行记忆（切会话回来）：凭库里数据合成头行（条目数=窗口行数，与概览「GCL 表项」
    // 同口径；求解器出处取 meta.algorithm）。
    head = (
      <div className="sim-overall converged flow-overall" role="status" aria-label="规划总判定">
        门控表 · {detail.windows.length} 条目
        {detail.meta && (
          <SolverBadge solver={detail.meta.algorithm} z3={detail.meta.algorithm === "Z3"} />
        )}
      </div>
    );
  } else if (detail && presentation === "no-gating") {
    // 无 ST 一律不 pin：存量门控表（窗口行非空）与当前流集不符时明说「验证不会消费」，不画旧图。
    head = (
      <div className="flow-gcl-info" role="status" aria-label="规划总判定">
        {detail.windows.length > 0
          ? "流集无 ST 流，无需门控；存量门控表与当前流集不符，验证不会消费。"
          : "流集无 ST 流，无需门控；可直接软仿验证。"}
      </div>
    );
  }

  // 时序图/明细已并入门控详情弹窗（boss 定：面板不再重复展示），本区只留判定头行。
  // 明细读取失败但 planState 有成功结果：显式「不可用」态（判定仍由 head 供）。
  const showUnavailableNote =
    gclQuery.status === "unavailable" &&
    planState.status === "done" &&
    planSucceeded(planState.result);

  if (!head && !showUnavailableNote) return null;
  return (
    <div className="flow-plan-result">
      {head}
      {showUnavailableNote && (
        <p className="flow-message mono">
          门控明细暂不可用（读取失败）；判定见上，可稍后重试或重新规划。
        </p>
      )}
    </div>
  );
}

/** 判定单元格（U3）：判定徽章化（sim-badge ok/bad）；报告态（judged=false）显示 note 不下判。 */
function VerdictCell({ verdict: s }: { verdict: StreamVerdict }) {
  if (s.judged === false) {
    return <span className="flow-verdict-note mono">{s.note ?? "仅报告"}</span>;
  }
  const ratioMark =
    s.class === "BE" && s.deliveryRatio != null
      ? `（送达率 ${Math.round(s.deliveryRatio * 100)}%）`
      : "";
  return (
    <span className={`sim-badge ${s.pass ? "ok" : "bad"}`}>
      {s.pass ? `达标${ratioMark}` : `未达标：${s.reason ?? ""}`}
    </span>
  );
}

function VerifyResultArea({ verifyState }: { verifyState: VerifyUiState }) {
  if (verifyState.status === "idle") return null;
  if (verifyState.status === "running") return null;
  if (verifyState.status === "error") {
    return <p className="flow-message mono flow-error">软仿失败：{verifyState.message}</p>;
  }
  const result = verifyState.result;

  // U7 多轮结果（有 RC 流）：顶层摘要（U6 overall 串联）+ 按轮分组小节。
  if (result.rounds && result.rounds.length > 0) {
    const allRoundsOk = result.rounds.every((r) => r.status === "ok");
    return (
      <div className={`flow-verify-result ${allRoundsOk ? "pass" : "fail"}`}>
        <div
          className={allRoundsOk ? "sim-overall converged" : "sim-overall warn"}
          role="status"
          aria-label="验证总判定"
        >
          {result.overall}
        </div>
        {result.message && <p className="flow-message mono">{result.message}</p>}
        {result.rounds.map((round) => (
          <VerifyRoundSection key={round.round} round={round} />
        ))}
      </div>
    );
  }

  // 无 rounds（纯 ST/ST+BE/纯 BE 单轮结果）：判据/文案不变，视觉统一（sim-overall/eng-table/
  // 徽章）+ 顶层 gPTP 诊断行（R15 收尾，只报告不判——有 rounds 时诊断行随轮小节渲染，此处不重复）。
  // R16：空/短/失败绝不渲染绿——仅有逐流行时才出表。
  const showTable = showVerifyTable(result);
  const allPass = verifyAllPass(result);
  return (
    <div className={`flow-verify-result ${allPass ? "pass" : "fail"}`}>
      <div
        className={allPass ? "sim-overall converged" : "sim-overall warn"}
        role="status"
        aria-label="验证总判定"
      >
        {result.overall}
      </div>
      {result.message && !showTable && <p className="flow-message mono">{result.message}</p>}
      {showTable && (
        <table className="eng-table flow-verdict-table">
          <thead>
            <tr>
              <th>流</th>
              <th>talker→listener</th>
              <th>收/发</th>
              <th>抖动(ns)</th>
              <th>时延(ns)</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            {result.perStream.map((s) => (
              <tr key={s.streamSeq} className={s.pass ? "pass" : "fail"}>
                <td>{s.streamSeq}</td>
                <td>
                  {s.talker}→{s.listener}
                </td>
                <td>
                  {s.received}/{s.expected}
                </td>
                <td>{s.jitterMaxNs.toFixed(0)}</td>
                <td>{s.latencyMaxNs.toFixed(0)}</td>
                <td>
                  <VerdictCell verdict={s} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.gptpDiag && (
        <p className="flow-gptp-diag sim-message mono">{gptpDiagLine(result.gptpDiag)}</p>
      )}
    </div>
  );
}

/** U7 单轮小节（U3 视觉统一）：徽章条头（轮名 + sim-badge 状态 + 标注 chips）+ 带「类别」列的
 * 逐流表 + gPTP 诊断行 + 未测容错列表。判据/DTO/文案语义零改动（KTD4）。 */
function VerifyRoundSection({ round }: { round: VerifyRound }) {
  return (
    <section className={`flow-verify-round ${round.status}`}>
      <div className="flow-round-head">
        <span className="flow-round-name">{roundLabel(round.round)}</span>
        <span className={`sim-badge ${round.status === "ok" ? "ok" : "bad"}`}>
          {roundStatusLabel(round.status)}
        </span>
        {round.annotations.map((a) => (
          <span key={a} className="flow-round-chip mono">
            {a}
          </span>
        ))}
      </div>
      {round.perStream.length > 0 && (
        <table className="eng-table flow-verdict-table">
          <thead>
            <tr>
              <th>流</th>
              <th>类别</th>
              <th>talker→listener</th>
              <th>收/发</th>
              <th>抖动(ns)</th>
              <th>时延(ns)</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            {round.perStream.map((s) => (
              <RoundVerdictRow key={s.streamSeq} verdict={s} />
            ))}
          </tbody>
        </table>
      )}
      {round.gptpDiag && (
        <p className="flow-gptp-diag sim-message mono">{gptpDiagLine(round.gptpDiag)}</p>
      )}
      {round.untestedStreams.length > 0 && (
        <ul className="flow-round-untested">
          {round.untestedStreams.map((u) => (
            <li key={u} className="mono">
              {u}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 单流行（多轮表）：RC 时延/抖动标「首达路实测」（慢副本被消除点吞掉，防误读双路都达标）；
 * BE 达标旁并列送达率；报告态（judged=false）显示 note 不显示达标/未达标。 */
function RoundVerdictRow({ verdict: s }: { verdict: StreamVerdict }) {
  const firstPathMark = s.class === "RC" ? "（首达路实测）" : "";
  return (
    <tr className={s.judged === false ? "reported" : s.pass ? "pass" : "fail"}>
      <td>{s.streamSeq}</td>
      <td>{s.class ?? "ST"}</td>
      <td>
        {s.talker}→{s.listener}
      </td>
      <td>
        {s.received}/{s.expected}
      </td>
      <td>
        {s.jitterMaxNs.toFixed(0)}
        {firstPathMark}
      </td>
      <td>
        {s.latencyMaxNs.toFixed(0)}
        {firstPathMark}
      </td>
      <td>
        <VerdictCell verdict={s} />
      </td>
    </tr>
  );
}
