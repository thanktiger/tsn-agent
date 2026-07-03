import { useRef } from "react";

import {
  invokePlanTas,
  invokeVerifyTas,
  isZ3Guaranteed,
  type PlanResult,
  type PlanUiState,
  planSucceeded,
  showVerifyTable,
  type VerifyTasResult,
  type VerifyUiState,
  verifyAllPass,
} from "./flow-sim";

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
}: FlowPanelProps) {
  // ref 即时拦并发（disabled 态下一拍才生效，防双击派发第二次）。
  const planInflight = useRef(false);
  const verifyInflight = useRef(false);
  // await 落地后据当前会话判定是否切走（闭包定格的是发起时的 sessionId）。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const planning = planState.status === "running";
  const verifying = verifyState.status === "running";
  // 规划成功产出门控表才允许验证（pin 的是那张表）。
  const havePlan = planState.status === "done" && planSucceeded(planState.result);

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
      <div className="flow-panel-actions">
        <button type="button" onClick={() => void handlePlan()} disabled={planDisabled}>
          {planning ? "综合中…（分钟级）" : "规划门控表"}
        </button>
        <button
          type="button"
          onClick={() => void handleVerify()}
          disabled={verifyDisabled}
          title={!havePlan ? "请先规划出门控表" : undefined}
        >
          {verifying ? "软仿中…（分钟级）" : "软仿验证"}
        </button>
      </div>

      {/* R21 诚实边界：结果区容器级标注，读到任一结果前即可见。 */}
      <p className="flow-honesty-note">仿真实测 · 非 T10 硬件判决</p>

      {/* R22：分钟级综合/软仿进行中反馈。 */}
      {planning && <p className="flow-progress mono">正在跑 Z3 门控综合，分钟级，请稍候…</p>}
      {verifying && <p className="flow-progress mono">正在跑 pin 软仿实测，分钟级，请稍候…</p>}

      <PlanResultArea planState={planState} />
      <VerifyResultArea verifyState={verifyState} />

      {/*
        R4：RC 流的 redundant/paths 字段「仅 RC 才显」是**录入表单**规则；本面板是规划/软仿
        结果面板，本期不建录入表单（流经会话 agent 录入）。表单条件渲染代码留后续面板 PR，
        显隐规则已在 plan/U9 固化为规格。
      */}
    </section>
  );
}

function PlanResultArea({ planState }: { planState: PlanUiState }) {
  if (planState.status === "idle") return null;
  if (planState.status === "running") return null; // 进行中文案在上方。
  if (planState.status === "error") {
    return <p className="flow-message mono flow-error">规划失败：{planState.message}</p>;
  }
  const result = planState.result;
  const ok = planSucceeded(result);
  return (
    <div className="flow-plan-result">
      <p className="flow-overall">
        {result.overall}
        {ok && result.solver && (
          <span
            className={`flow-solver-badge ${isZ3Guaranteed(result) ? "guaranteed" : "besteffort"}`}
          >
            {isZ3Guaranteed(result)
              ? `${result.solver}·带可调度性保证`
              : `${result.solver}·兜底解无保证`}
          </span>
        )}
      </p>
      {!ok && result.message && <p className="flow-message mono">{result.message}</p>}
    </div>
  );
}

function VerifyResultArea({ verifyState }: { verifyState: VerifyUiState }) {
  if (verifyState.status === "idle") return null;
  if (verifyState.status === "running") return null;
  if (verifyState.status === "error") {
    return <p className="flow-message mono flow-error">软仿失败：{verifyState.message}</p>;
  }
  const result = verifyState.result;
  // R16：空/短/失败绝不渲染绿——仅有逐流行时才出表。
  const showTable = showVerifyTable(result);
  const allPass = verifyAllPass(result);
  return (
    <div className={`flow-verify-result ${allPass ? "pass" : "fail"}`}>
      <p className="flow-overall">{result.overall}</p>
      {result.message && !showTable && <p className="flow-message mono">{result.message}</p>}
      {showTable && (
        <table className="flow-verdict-table">
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
                <td>{s.pass ? "达标" : `未达标：${s.reason ?? ""}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
