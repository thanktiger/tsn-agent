import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionDbListener } from "../../hooks/use-session-db-listener";
import { CHART_COLORS } from "./chart-palette";
import {
  buildGateTimelineRows,
  type FlowPlanDetail,
  type FlowPlanQueryState,
  flowPlanPresentation,
  gclDutyCycle,
  gclOpenIntervals,
  gptpDiagLine,
  invokeGetFlowPlan,
  invokePlanTas,
  invokeVerifyTas,
  isZ3Guaranteed,
  nsToUs,
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
  /** 写通道（测试注入替身）。 */
  planTas?: (sessionId: string) => Promise<PlanResult>;
  verifyTas?: (sessionId: string) => Promise<VerifyTasResult>;
  /** 门控明细读通道（U2/KTD1，测试注入替身）。 */
  getFlowPlan?: (sessionId: string) => Promise<FlowPlanDetail>;
}

export function FlowPanel({
  inFlowStage,
  sessionId,
  planState,
  onPlanStateChange,
  verifyState,
  onVerifyStateChange,
  planTas = invokePlanTas,
  verifyTas = invokeVerifyTas,
  getFlowPlan = invokeGetFlowPlan,
}: FlowPanelProps) {
  // ref 即时拦并发（disabled 态下一拍才生效，防双击派发第二次）。
  const planInflight = useRef(false);
  const verifyInflight = useRef(false);
  // await 落地后据当前会话判定是否切走（闭包定格的是发起时的 sessionId）。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // U2/KTD1：门控明细查询态——面板挂载即拉，展示态由数据推导（切会话回来凭数据恢复）。
  const [planQuery, setPlanQuery] = useState<FlowPlanQueryState>({ status: "loading" });
  // 单一取数口径：三触发源（挂载·切会话 / 规划完成 / flow domain DB 变更）共用；requestSeq 丢弃
  // 过期响应（会话已切或更新请求在途）。失败置 unavailable（不吞、头行仍由 planState 供）。
  const planQueryReqRef = useRef(0);
  const refreshPlanQuery = useCallback(async () => {
    const seq = ++planQueryReqRef.current;
    try {
      const detail = await getFlowPlan(sessionId);
      if (planQueryReqRef.current === seq) setPlanQuery({ status: "loaded", detail });
    } catch {
      if (planQueryReqRef.current === seq) setPlanQuery({ status: "unavailable" });
    }
  }, [getFlowPlan, sessionId]);

  // 挂载 / 切会话：先回 loading（避免闪旧数据 + 抑制 CTA 闪现），再取。
  useEffect(() => {
    setPlanQuery({ status: "loading" });
    void refreshPlanQuery();
  }, [refreshPlanQuery]);

  // 规划完成（含 no_gating 清表 / solver_failed 旧表保留）后刷新明细；切 tab 卸载重挂后再变 done
  // 也刷新（不再在 handlePlan 里内联取数——重挂后内联块随旧闭包丢失）。
  useEffect(() => {
    if (planState.status === "done") void refreshPlanQuery();
  }, [planState, refreshPlanQuery]);

  // flow domain 写库（agent 录流 / 规划落库）→ 重拉（照 timesync 消费先例，非 Tauri 环境 no-op）。
  useSessionDbListener({ sessionId, onChange: () => void refreshPlanQuery() });

  const planning = planState.status === "running";
  const verifying = verifyState.status === "running";
  // KTD1 三态（数据推导）：planned / no-gating / unplanned。取数失败回退 unplanned（按钮闸退回
  // planState 口径，同现状）。
  const queryPresentation =
    planQuery.status === "loaded" ? flowPlanPresentation(planQuery.detail) : "unplanned";
  // 验证按钮闸（R5/KTD4 口径升级）：planState 放行（本次会话规划过/no_gating），或查询三态
  // 非未规划（库里有门控表 / 流集无 ST 无需门控）。
  const havePlan =
    (planState.status === "done" && planAllowsVerify(planState.result)) ||
    queryPresentation !== "unplanned";
  // 挂载取数未回前（planState 无瞬态记忆）：既不下判 fresh 也不出结果——空占位，防已规划会话
  // 挂载时 CTA 闪现被误点（loading 一律不出 CTA，等数据落定再决定 CTA/结果，item 7）。
  const idleLoading = planState.status === "idle" && planQuery.status === "loading";
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
      {/* 命令栏（对齐 timesync-commandbar）：左侧 R21 诚实边界常驻标注，右侧操作按钮。
          渐进式（KTD3）：未规划态规划按钮在 body CTA，有结果后收进右上角。 */}
      <div className="timesync-commandbar flow-commandbar">
        <p className="flow-honesty-note">仿真实测 · 非 T10 硬件判决</p>
        <div className="timesync-commandbar__actions" role="group" aria-label="流量规划操作">
          {!fresh && !idleLoading && (
            <button
              type="button"
              className="btn primary"
              onClick={() => void handlePlan()}
              disabled={planDisabled}
            >
              {planning ? "综合中…（分钟级）" : "重新规划"}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => void handleVerify()}
            disabled={verifyDisabled}
            title={!havePlan ? "请先规划出门控表" : undefined}
          >
            {verifying ? "软仿中…（分钟级）" : "软仿验证"}
          </button>
        </div>
      </div>

      {/* R22：分钟级综合/软仿进行中反馈（U7：含 RC 流时为三轮，逐轮分钟级）。 */}
      {planning && <p className="flow-progress mono">正在跑 Z3 门控综合，分钟级，请稍候…</p>}
      {verifying && (
        <p className="flow-progress mono">
          正在跑 pin 软仿实测（含 RC 流时为健康+断A+断B 三轮，逐轮分钟级），请稍候…
        </p>
      )}

      {idleLoading ? null : fresh ? (
        <PanelCta
          label="规划门控表"
          hint="用 INET Z3 配置器综合 802.1Qbv 门控表（GCL），结果落库并在此可视化。"
          onClick={() => void handlePlan()}
          disabled={planDisabled}
          title={!inFlowStage ? "请先进入流量规划阶段" : undefined}
        />
      ) : (
        <PlanResultArea planState={planState} planQuery={planQuery} />
      )}
      <VerifyResultArea verifyState={verifyState} />

      {/*
        R4：RC 流的 redundant/paths 字段「仅 RC 才显」是**录入表单**规则；本面板是规划/软仿
        结果面板，本期不建录入表单（流经会话 agent 录入）。表单条件渲染代码留后续面板 PR，
        显隐规则已在 plan/U9 固化为规格。
      */}
    </section>
  );
}

/** 求解器出处徽章（R8/KTD7 诚实边界）：Z3 带保证 / Eager 兜底无保证。 */
function SolverBadge({ solver, z3 }: { solver: string; z3: boolean }) {
  // z3 复用 sim-badge ok 绿（与收敛/达标同语义，不再复制一份同色对）；兜底解走 besteffort 琥珀色。
  return (
    <span className={`flow-solver-badge ${z3 ? "sim-badge ok" : "besteffort"}`}>
      {z3 ? `${solver}·带可调度性保证` : `${solver}·兜底解无保证`}
    </span>
  );
}

/**
 * 规划结果区（U2）：头行（planState 瞬态优先，否则凭查询数据恢复）+ 门控时序图 + 折叠明细表。
 * KTD1：展示态由数据推导——切会话回来 entries 非空即恢复时序图，无需规划动作记忆。
 */
function PlanResultArea({
  planState,
  planQuery,
}: {
  planState: PlanUiState;
  planQuery: FlowPlanQueryState;
}) {
  const detail = planQuery.status === "loaded" ? planQuery.detail : undefined;
  const presentation = detail ? flowPlanPresentation(detail) : "unplanned";

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
    // 无本次运行记忆（切会话回来）：凭库里数据合成头行。
    head = (
      <div className="sim-overall converged flow-overall" role="status" aria-label="规划总判定">
        门控表 · {detail.entries.length} 条目
        {detail.solver && (
          <SolverBadge solver={detail.solver} z3={(detail.solver ?? "") === "Z3"} />
        )}
      </div>
    );
  } else if (detail && presentation === "no-gating") {
    // 无 ST 一律不 pin：存量门控表（entries 非空）与当前流集不符时明说「验证不会消费」，不画旧图。
    head = (
      <div className="flow-gcl-info" role="status" aria-label="规划总判定">
        {detail.entries.length > 0
          ? "流集无 ST 流，无需门控；存量门控表与当前流集不符，验证不会消费。"
          : "流集无 ST 流，无需门控；可直接软仿验证。"}
      </div>
    );
  }

  // 时序图/明细仅在 presentation==='planned'（有 ST + 库里有门控表）时画。error（命令抛错、态未定）
  // 不画旧图误导；solver_failed（新综合失败但旧 GCL 未被覆盖、有 ST 时仍会被 verify pin）保留旧图是
  // 诚实的——故仅排除 error 态，不排除 done。
  const showGcl = presentation === "planned" && planState.status !== "error";
  // 明细读取失败但 planState 有成功结果：显式「不可用」态，绝不回退画旧/空图（判定仍由 head 供）。
  const showUnavailableNote =
    planQuery.status === "unavailable" &&
    planState.status === "done" &&
    planSucceeded(planState.result);

  if (!head && !showGcl && !showUnavailableNote) return null;
  return (
    <div className="flow-plan-result">
      {head}
      {showGcl && detail && (
        <>
          <GateTimelineChart detail={detail} />
          <GclDetailTable detail={detail} />
        </>
      )}
      {showUnavailableNote && (
        <p className="flow-message mono">
          门控明细暂不可用（读取失败）；判定见上，可稍后重试或重新规划。
        </p>
      )}
    </div>
  );
}

/**
 * 门控时序图（U2/KTD2，零依赖 SVG 泳道，参照 time-sync OffsetChart 手法）：每行一个
 * (节点,端口)，x 轴 = 1ms 门周期（刻度 0/250/500/750/1000µs），ST 开窗画色块
 * （CHART_COLORS[0]）、关窗为底色轨道；行按首个开窗起点升序（Z3 流水线阶梯错位一眼可见）。
 * hover `<title>` 显示精确开窗值；极窄窗设 1.5px 渲染下限保证可见。
 */
function GateTimelineChart({ detail }: { detail: FlowPlanDetail }) {
  const rows = buildGateTimelineRows(detail.entries, detail.cycleNs);
  if (rows.length === 0) return null;

  const W = 680;
  const ml = 110;
  const mr = 12;
  const mt = 8;
  const mb = 26;
  const rowH = 26;
  const trackH = 14;
  const pw = W - ml - mr;
  const plotH = rows.length * rowH;
  const H = mt + plotH + mb;
  const xAt = (ns: number) => ml + (ns / detail.cycleNs) * pw;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * detail.cycleNs);

  return (
    <figure className="sim-chart flow-gcl-chart">
      <figcaption>门控时序图（1ms 门周期 · 行按首个开窗起点排序）</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="sim-chart-svg"
        role="img"
        aria-label="门控时序图"
        preserveAspectRatio="xMidYMid meet"
      >
        <title>门控时序图</title>
        {/* 周期刻度网格：0/250/500/750/1000µs */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={xAt(t)} y1={mt} x2={xAt(t)} y2={mt + plotH} className="flow-gcl-grid" />
            <text
              x={xAt(t)}
              y={mt + plotH + 16}
              className="sim-chart-tick"
              textAnchor={t === 0 ? "start" : "end"}
            >
              {t === detail.cycleNs ? "1000 µs" : `${Math.round(t / 1000)}`}
            </text>
          </g>
        ))}
        {/* 每行：标签「短名·ethN」 + 底色轨道（关窗） + ST 开窗色块 */}
        {rows.map((row, i) => {
          const y = mt + i * rowH + (rowH - trackH) / 2;
          return (
            <g key={`${row.node}-${row.ethN}`}>
              <text
                x={ml - 8}
                y={y + trackH / 2 + 4}
                className="sim-chart-tick flow-gcl-row-label"
                textAnchor="end"
              >
                {row.nodeName}·eth{row.ethN}
              </text>
              <rect x={ml} y={y} width={pw} height={trackH} rx={3} className="flow-gcl-track" />
              {row.windows.map(([s, e]) => (
                <rect
                  key={`${s}-${e}`}
                  x={xAt(s)}
                  y={y}
                  width={Math.max(((e - s) / detail.cycleNs) * pw, 1.5)}
                  height={trackH}
                  rx={2}
                  fill={CHART_COLORS[0]}
                  className="flow-gcl-window"
                >
                  <title>{`开 ${nsToUs(s)}µs → ${nsToUs(e)}µs（${e - s}ns）`}</title>
                </rect>
              ))}
            </g>
          );
        })}
      </svg>
      <ul className="sim-chart-legend">
        <li>
          <span
            className="sim-chart-swatch"
            style={{ background: CHART_COLORS[0] }}
            aria-hidden="true"
          />
          ST 开窗
        </li>
        <li>
          <span className="sim-chart-swatch flow-gcl-swatch-track" aria-hidden="true" />
          关窗（底色轨道）
        </li>
      </ul>
    </figure>
  );
}

/** 门控明细折叠表（U2）：折叠头样式同 sim-override-toggle，列全 mono 数字。 */
function GclDetailTable({ detail }: { detail: FlowPlanDetail }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flow-gcl-detail">
      <button
        type="button"
        className="sim-override-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "▾" : "▸"} 门控明细 · {detail.entries.length} 条目
      </button>
      {expanded && (
        <table className="eng-table flow-gcl-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>端口</th>
              <th>门</th>
              <th>offset(µs)</th>
              <th>开窗(µs)</th>
              <th>占空比</th>
              <th>初态</th>
            </tr>
          </thead>
          <tbody>
            {detail.entries.map((g) => {
              const windows = gclOpenIntervals(g, detail.cycleNs);
              return (
                <tr key={`${g.node}-${g.ethN}-${g.gateIndex}`}>
                  <td title={g.node}>{g.nodeName}</td>
                  <td className="mono">eth{g.ethN}</td>
                  <td className="mono">{g.gateIndex}</td>
                  <td className="mono">{nsToUs(g.offsetNs)}</td>
                  <td className="mono">
                    {windows.length > 0
                      ? windows.map(([s, e]) => `${nsToUs(s)}–${nsToUs(e)}`).join("、")
                      : "—"}
                  </td>
                  <td className="mono">{(gclDutyCycle(g, detail.cycleNs) * 100).toFixed(1)}%</td>
                  <td>{g.initiallyOpen ? "开" : "关"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
