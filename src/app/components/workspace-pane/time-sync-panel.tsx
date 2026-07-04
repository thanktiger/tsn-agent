import { useEffect, useRef, useState } from "react";
import { CHART_COLORS } from "./chart-palette";
import { HardDeployPanel } from "./hard-deploy-panel";
import type { HardwareUiState } from "./hardware-deploy";
import { PanelCta } from "./panel-cta";
import {
  buildSimExplainPrompt,
  FALLBACK_SIM_DEFAULTS,
  hasNonConvergedNode,
  invokeGetSimDefaults,
  invokeRunTimesyncSim,
  invokeSimExplain,
  isFullyConverged,
  type PerNodeOffset,
  type SimDefaults,
  type SimOverrideForm,
  type SimResult,
  type SimUiState,
} from "./timesync-sim";
import { type TimesyncSubTab, TimesyncSubTabs } from "./timesync-subtabs";

/**
 * 时间同步 tab 内容——两个平级子 tab：软件仿真（软仿按钮 + 门控 + 运行态 + 结果表/曲线 + 覆盖表单 + 解释）
 * 与硬件部署（本期占位空态）。子 tab 选择由 App 级 state 驱动（reveal 可强制落 soft-sim、随会话重置）。
 *
 * 运行态（simState）持于 App 级、经 props 透传：切 tab/子 tab 不取消命令、切回按 status 恢复。
 * 覆盖表单展开/填值是组件内独立 intent（跨软仿运行保留、仅会话切换重置——靠 key={sessionId} 重挂）。
 */

/** 子 tab 类型 single source 移至 ./timesync-subtabs；此处 re-export 保持 index.tsx 引用不变。 */
export type { TimesyncSubTab } from "./timesync-subtabs";

export interface TimeSyncPanelProps {
  /** 当前阶段是否 time-sync。 */
  inTimeSyncStage: boolean;
  /** 时钟树是否已确认（GM 已设）；软仿门控第二条件。 */
  treeConfirmed: boolean;
  sessionId: string;
  simState: SimUiState;
  onSimStateChange: (state: SimUiState) => void;
  /** U8：硬件部署运行态，持于 App 级、随会话重置（同 simState 分层）。 */
  hardwareState: HardwareUiState;
  onHardwareStateChange: (state: HardwareUiState) => void;
  /** 平级子 tab：软件仿真 / 硬件部署。 */
  activeSubTab: TimesyncSubTab;
  onSelectSubTab: (tab: TimesyncSubTab) => void;
  /** 软仿写通道（测试注入替身）。 */
  runTimesyncSim?: (sessionId: string, overrides: SimOverrideForm) => Promise<SimResult>;
  /** 解释通道（测试注入替身）。 */
  explainSim?: (prompt: string) => Promise<string>;
  /** U6：默认值读通道（测试注入替身）。 */
  getSimDefaults?: () => Promise<SimDefaults>;
}

export function TimeSyncPanel({
  inTimeSyncStage,
  treeConfirmed,
  sessionId,
  simState,
  onSimStateChange,
  hardwareState,
  onHardwareStateChange,
  activeSubTab,
  onSelectSubTab,
  runTimesyncSim = invokeRunTimesyncSim,
  explainSim = invokeSimExplain,
  getSimDefaults = invokeGetSimDefaults,
}: TimeSyncPanelProps) {
  // U12：覆盖表单状态（默认收起，跨软仿运行保留）。form 只存「用户覆盖」（在哪个键=已覆盖）；
  // 显示/预填用 form.x ?? defaults.x，提交也只发 form（不填走后端默认，保持原语义）。
  const [formExpanded, setFormExpanded] = useState(true);
  const [form, setForm] = useState<SimOverrideForm>({});
  // U6：软仿覆盖参数默认值（后端单一事实源）。undefined=加载中；取数失败回退兜底常量。
  const [defaults, setDefaults] = useState<SimDefaults | undefined>();
  useEffect(() => {
    let alive = true;
    getSimDefaults()
      .then((d) => {
        if (alive) setDefaults(d);
      })
      .catch(() => {
        if (alive) setDefaults(FALLBACK_SIM_DEFAULTS);
      });
    return () => {
      alive = false;
    };
  }, [getSimDefaults]);
  // U13：解释态。
  const [explainState, setExplainState] = useState<
    { status: "idle" } | { status: "running" } | { status: "done"; text: string }
  >({ status: "idle" });
  const [explainFailed, setExplainFailed] = useState(false);
  // 同步互斥：disabled/loading 态下一拍才生效，两次快速点击都能越过门控；ref 即时拦并发。
  const softSimInflight = useRef(false);
  const explainInflight = useRef(false);
  // 异步落地校验读最新会话：handler 闭包定格的是发起时那次 render 的 sessionId，
  // 切走后 prop 变了但旧闭包看不到；ref 始终指向当前 prop，await 落地后据此判定是否切走。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const running = simState.status === "running";
  // 首次空态（从未运行、无结果）：开始按钮放 body CTA；运行过/有结果后收进命令栏右上角。
  const softFresh = simState.status === "idle";
  // 门控两条文案（doc-review）：未到阶段 / 树未确认。
  const softSimDisabled = !inTimeSyncStage || !treeConfirmed || running;
  const softSimTooltip = !inTimeSyncStage
    ? "请先进入时钟同步阶段"
    : !treeConfirmed
      ? "请先确认时钟树"
      : undefined;

  async function handleSoftSim() {
    if (softSimDisabled || softSimInflight.current) {
      return;
    }
    softSimInflight.current = true;
    setFormExpanded(false); // 开跑即收起覆盖参数（boss）
    // 运行前定格当前会话：await 期间用户切走时，迟到结果不得落进新会话的状态。
    const runSessionId = sessionId;
    setExplainState({ status: "idle" });
    setExplainFailed(false);
    onSimStateChange({ status: "running" });
    try {
      const result = await runTimesyncSim(runSessionId, form);
      if (runSessionId !== sessionIdRef.current) {
        return;
      }
      onSimStateChange({ status: "done", result });
    } catch (error) {
      if (runSessionId !== sessionIdRef.current) {
        return;
      }
      onSimStateChange({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      softSimInflight.current = false;
    }
  }

  async function handleExplain(result: SimResult) {
    if (explainInflight.current) {
      return;
    }
    explainInflight.current = true;
    const runSessionId = sessionId;
    setExplainState({ status: "running" });
    setExplainFailed(false);
    try {
      const text = await explainSim(buildSimExplainPrompt(result));
      if (runSessionId !== sessionIdRef.current) {
        return;
      }
      setExplainState({ status: "done", text });
    } catch {
      if (runSessionId !== sessionIdRef.current) {
        return;
      }
      setExplainState({ status: "idle" });
      setExplainFailed(true);
    } finally {
      explainInflight.current = false;
    }
  }

  return (
    <section
      className="detail-panel time-sync-panel"
      id="config-panel-time-sync"
      role="tabpanel"
      aria-label="时间同步"
    >
      {activeSubTab === "soft-sim" && (
        <div
          className="sim-subpanel"
          role="tabpanel"
          id="timesync-subpanel-soft-sim"
          aria-labelledby="timesync-subtab-soft-sim"
        >
          {/* 命令栏：子 tab 分段开关（左）+ 仿真操作（右）。渐进式：首次空态按钮在 body CTA，
              运行过/有结果后才收进命令栏右上角（boss 定）。 */}
          <div className="timesync-commandbar">
            <TimesyncSubTabs activeSubTab={activeSubTab} onSelectSubTab={onSelectSubTab} />
            {!softFresh && (
              <div className="timesync-commandbar__actions" role="group" aria-label="仿真操作">
                <button
                  type="button"
                  className="btn primary"
                  disabled={softSimDisabled}
                  title={softSimTooltip}
                  // 重新仿真：回初始态（CTA 居中 + 覆盖参数展开可重选），不直接重跑（仿硬件部署「重新部署」）。
                  onClick={() => {
                    onSimStateChange({ status: "idle" });
                    setFormExpanded(true);
                  }}
                >
                  {running ? "仿真运行中…" : "开始仿真"}
                </button>
              </div>
            )}
          </div>

          <SimOverrideRegion
            expanded={formExpanded}
            form={form}
            defaults={defaults}
            onToggle={() => setFormExpanded((value) => !value)}
            onChange={setForm}
          />

          {softFresh ? (
            <PanelCta
              label="开始仿真"
              hint="运行 INET gPTP 软仿，取回各节点相对 GM 的收敛偏差。"
              onClick={() => void handleSoftSim()}
              disabled={softSimDisabled}
              title={softSimTooltip}
            />
          ) : (
            <SimResultArea
              simState={simState}
              explainState={explainState}
              explainFailed={explainFailed}
              onExplain={handleExplain}
            />
          )}
        </div>
      )}

      {activeSubTab === "hard-deploy" && (
        <div
          className="sim-subpanel sim-subpanel--fill"
          role="tabpanel"
          id="timesync-subpanel-hard-deploy"
          aria-labelledby="timesync-subtab-hard-deploy"
        >
          <HardDeployPanel
            sessionId={sessionId}
            inTimeSyncStage={inTimeSyncStage}
            treeConfirmed={treeConfirmed}
            hardwareState={hardwareState}
            onHardwareStateChange={onHardwareStateChange}
            activeSubTab={activeSubTab}
            onSelectSubTab={onSelectSubTab}
          />
        </div>
      )}
    </section>
  );
}

/**
 * U12/U6：软仿覆盖表单（3 参数，默认收起）。折叠 header 显示生效默认摘要（值来自后端单一事实源），
 * 展开后字段预填实值；form 只存「用户覆盖」的键——「已覆盖」按键是否存在判定（非值比较），
 * 提交也只发 form（不填走后端默认，保持原语义）。defaults 未到（加载中）暂用兜底常量显示。
 */
function SimOverrideRegion({
  expanded,
  form,
  defaults,
  onToggle,
  onChange,
}: {
  expanded: boolean;
  form: SimOverrideForm;
  defaults: SimDefaults | undefined;
  onToggle: () => void;
  onChange: (form: SimOverrideForm) => void;
}) {
  const eff = defaults ?? FALLBACK_SIM_DEFAULTS;
  const currentOsc = form.oscillator ?? eff.oscillator;
  const isConstant = currentOsc === "Constant";
  const oscOverridden = form.oscillator !== undefined;
  const driftOverridden = form.driftPpm !== undefined;
  const drcOverridden = form.driftRateChangePpm !== undefined;
  const ciOverridden = form.changeIntervalMs !== undefined;
  const simOverridden = form.simTimeS !== undefined;
  const tag = (overridden: boolean) => (overridden ? "（已覆盖）" : "");
  // 摘要 + anyOverridden 只看当前振荡器类型对应的参数（另一类型的残留覆盖后端会忽略，不计入）。
  const paramSummary = isConstant
    ? ` · 漂移 ${form.driftPpm ?? eff.driftPpm}ppm${tag(driftOverridden)}`
    : ` · 步长 ${form.driftRateChangePpm ?? eff.driftRateChangePpm}ppm${tag(drcOverridden)}` +
      ` · 间隔 ${form.changeIntervalMs ?? eff.changeIntervalMs}ms${tag(ciOverridden)}`;
  const paramOverridden = isConstant ? driftOverridden : drcOverridden || ciOverridden;
  const anyOverridden = oscOverridden || paramOverridden || simOverridden;
  const summary =
    `振荡器 ${currentOsc}${tag(oscOverridden)}` +
    paramSummary +
    ` · 时长 ${form.simTimeS ?? eff.simTimeS}s${tag(simOverridden)}` +
    `${anyOverridden ? "" : " · 默认"}`;

  return (
    <div className="sim-override">
      <button
        type="button"
        className="sim-override-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? "▾" : "▸"} 覆盖参数 · <span className="sim-override-summary">{summary}</span>
      </button>
      {expanded && (
        <div className="sim-override-fields" role="group" aria-label="软仿覆盖参数">
          <label className="sim-field">
            <span>振荡器类型</span>
            <select
              value={currentOsc}
              onChange={(event) =>
                onChange({ ...form, oscillator: event.target.value as "Constant" | "Random" })
              }
            >
              <option value="Constant">Constant</option>
              <option value="Random">Random</option>
            </select>
          </label>
          {isConstant ? (
            <label className="sim-field">
              <span>漂移幅度（ppm）</span>
              <input
                type="number"
                inputMode="decimal"
                value={form.driftPpm ?? eff.driftPpm}
                onChange={(event) =>
                  onChange({
                    ...form,
                    driftPpm: event.target.value === "" ? undefined : Number(event.target.value),
                  })
                }
              />
            </label>
          ) : (
            <>
              <label className="sim-field">
                <span>漂移率步长（ppm）</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={form.driftRateChangePpm ?? eff.driftRateChangePpm}
                  onChange={(event) =>
                    onChange({
                      ...form,
                      driftRateChangePpm:
                        event.target.value === "" ? undefined : Number(event.target.value),
                    })
                  }
                />
              </label>
              <label className="sim-field">
                <span>变化间隔（ms）</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={form.changeIntervalMs ?? eff.changeIntervalMs}
                  onChange={(event) =>
                    onChange({
                      ...form,
                      changeIntervalMs:
                        event.target.value === "" ? undefined : Number(event.target.value),
                    })
                  }
                />
              </label>
            </>
          )}
          <label className="sim-field">
            <span>仿真时长（s）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.simTimeS ?? eff.simTimeS}
              onChange={(event) =>
                onChange({
                  ...form,
                  simTimeS: event.target.value === "" ? undefined : Number(event.target.value),
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

/** U11/U13：结果区三态（初始引导 / 运行中 / 有结果），结果区下方挂解释折叠区。 */
function SimResultArea({
  simState,
  explainState,
  explainFailed,
  onExplain,
}: {
  simState: SimUiState;
  explainState: { status: "idle" } | { status: "running" } | { status: "done"; text: string };
  explainFailed: boolean;
  onExplain: (result: SimResult) => void;
}) {
  if (simState.status === "idle") {
    return <div className="empty-panel mono">点软仿运行后在此查看</div>;
  }
  if (simState.status === "running") {
    return <div className="empty-panel mono">仿真进行中…</div>;
  }
  if (simState.status === "error") {
    return (
      <p className="transfer-notice error" role="alert">
        软仿失败：{simState.message}
      </p>
    );
  }

  const result = simState.result;
  const converged = isFullyConverged(result);
  // 空结果/失败状态绝不渲染成全绿（R10）：只有 converged 才展示绿色总判定。
  const showResultTable = result.status === "converged" && result.perNode.length > 0;
  const showExplain = hasNonConvergedNode(result);

  return (
    <div className="sim-result">
      <div
        className={converged ? "sim-overall converged" : "sim-overall warn"}
        role="status"
        aria-label="软仿总判定"
      >
        {result.overall}
      </div>
      {result.message && !showResultTable && <p className="sim-message mono">{result.message}</p>}
      {showResultTable && (
        <table className="eng-table sim-table">
          <thead>
            <tr>
              <th>从节点</th>
              <th>稳态 max|offset|</th>
              <th>mean|offset|</th>
              <th>收敛</th>
              <th>参考线</th>
            </tr>
          </thead>
          <tbody>
            {result.perNode.map((node) => (
              <tr key={node.mid}>
                <td title={node.mid}>{shortNodeName(node.mid)}</td>
                <td>{node.maxOffsetNs.toFixed(1)} ns</td>
                <td>{node.meanOffsetNs.toFixed(1)} ns</td>
                <td>
                  <span className={node.converged ? "sim-badge ok" : "sim-badge bad"}>
                    {node.converged ? "收敛" : "未收敛"}
                  </span>
                </td>
                <td className="mono">{node.withinThreshold ? "内" : "外"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showResultTable && <OffsetChart perNode={result.perNode} />}

      {showExplain && (
        <div className="sim-explain">
          <button
            type="button"
            className="btn"
            disabled={explainState.status === "running"}
            onClick={() => onExplain(result)}
          >
            {explainState.status === "running"
              ? "生成中…"
              : explainState.status === "done"
                ? "重新解释"
                : "解释"}
          </button>
          {explainFailed && (
            <p className="transfer-notice error" role="alert">
              解释生成失败，可重试
            </p>
          )}
          {explainState.status === "done" && (
            <div className="sim-explain-body" role="region" aria-label="软仿解释">
              {explainState.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 阈值标签格式化：整 µs 显示 µs，否则 ns（如 1000→±1µs、500→±500ns）。 */
function formatThreshold(ns: number): string {
  return ns % 1000 === 0 ? `${ns / 1000}µs` : `${ns}ns`;
}

/** 取模块短名：`TsnAgentTimesyncNetwork.sw1.clock` → `sw1`（去网络前缀与 .clock 后缀）。 */
function shortNodeName(mid: string): string {
  const parts = mid.split(".");
  if (parts.length >= 2 && parts[parts.length - 1] === "clock") {
    return parts[parts.length - 2];
  }
  return parts[parts.length - 1] ?? mid;
}

/**
 * 从节点偏差随仿真时间的抖动曲线（零依赖 SVG）：x=仿真时间 ms，y=相对 GM 偏差 ns（带符号）。
 * 每从节点一条折线 + 0 基线 + ±1µs 收敛阈值带；y 轴按稳态分位裁剪（瞬态尖峰溢出截断），
 * 否则启动瞬态会把稳态压成贴底窄带。数据来自后端 perNode[].samples（已降采样封顶）。
 */
function OffsetChart({ perNode }: { perNode: PerNodeOffset[] }) {
  const nodes = perNode.filter((n) => n.samples.length > 0);
  if (nodes.length === 0) {
    return null;
  }

  const W = 680;
  const H = 260;
  const ml = 56;
  const mr = 12;
  const mt = 16;
  const mb = 30;
  const pw = W - ml - mr;
  const ph = H - mt - mb;

  let tMax = 0;
  let rawAbsMax = 0;
  const absVals: number[] = [];
  for (const n of nodes) {
    for (const s of n.samples) {
      if (s.tMs > tMax) tMax = s.tMs;
      const a = Math.abs(s.offsetNs);
      absVals.push(a);
      if (a > rawAbsMax) rawAbsMax = a;
    }
  }
  // U7：阈值取自各节点 thresholdNs。统一时画带、用实际值标注；不一致则不画统一带（表格逐节点判定）。
  const thresholdValues = nodes.map((n) => n.thresholdNs);
  const uniformThreshold = thresholdValues.every((t) => t === thresholdValues[0])
    ? thresholdValues[0]
    : null;
  // y 轴定界：有统一阈值时固定以阈值为基准（×1.35）——±阈值两条横线落在约 74% 高度、上方留
  // 余量显示溢出尖峰被截断，无论数据大小都能一眼看出相对阈值的位置（不再随数据贴合缩放）。
  // 多阈值时回退数据自适应（|offset| 95 分位 ×1.3 裁掉启动瞬态），逐节点判定见表格。
  absVals.sort((a, b) => a - b);
  const p95 = absVals[Math.floor(absVals.length * 0.95)] ?? 0;
  const dataBound = Math.max(p95 * 1.3, 1);
  const yBound = uniformThreshold !== null ? uniformThreshold * 1.35 : dataBound;
  const clipped = rawAbsMax > yBound;
  const thresholdInView = uniformThreshold !== null && uniformThreshold <= yBound;

  const tSpan = tMax > 0 ? tMax : 1;
  const xAt = (t: number) => ml + (t / tSpan) * pw;
  const yAt = (v: number) => mt + (1 - (v + yBound) / (2 * yBound)) * ph;
  const baseline = yAt(0);
  const bandTop = yAt(uniformThreshold ?? 0);
  const bandBottom = yAt(-(uniformThreshold ?? 0));

  return (
    <figure className="sim-chart">
      <figcaption>
        从节点偏差随仿真时间（相对 GM）
        {clipped && <span className="sim-chart-note">（启动瞬态尖峰超出范围已截断）</span>}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="sim-chart-svg"
        role="img"
        aria-label="从节点偏差随仿真时间抖动曲线"
        preserveAspectRatio="xMidYMid meet"
      >
        <title>从节点偏差随仿真时间抖动曲线</title>
        <clipPath id="sim-chart-plot">
          <rect x={ml} y={mt} width={pw} height={ph} />
        </clipPath>
        {/* 收敛阈值带（淡填充）：统一阈值时落在视图内 */}
        {thresholdInView && (
          <rect
            x={ml}
            y={bandTop}
            width={pw}
            height={bandBottom - bandTop}
            className="sim-chart-threshold-band"
          />
        )}
        {/* 坐标框 + 0 基线 */}
        <line x1={ml} y1={mt} x2={ml} y2={mt + ph} className="sim-chart-axis" />
        <line x1={ml} y1={mt + ph} x2={ml + pw} y2={mt + ph} className="sim-chart-axis" />
        <line x1={ml} y1={baseline} x2={ml + pw} y2={baseline} className="sim-chart-baseline" />
        {/* ±阈值两条横线标记（统一阈值时） */}
        {uniformThreshold !== null && thresholdInView && (
          <>
            <line
              x1={ml}
              y1={bandTop}
              x2={ml + pw}
              y2={bandTop}
              className="sim-chart-threshold-line"
            />
            <line
              x1={ml}
              y1={bandBottom}
              x2={ml + pw}
              y2={bandBottom}
              className="sim-chart-threshold-line"
            />
          </>
        )}
        {/* y 轴上下界 + 0 + x 轴末点标注 + 阈值标注 */}
        <text x={ml - 6} y={mt + 4} className="sim-chart-tick" textAnchor="end">
          {yBound.toFixed(0)} ns
        </text>
        <text x={ml - 6} y={baseline + 4} className="sim-chart-tick" textAnchor="end">
          0
        </text>
        <text x={ml - 6} y={mt + ph} className="sim-chart-tick" textAnchor="end">
          -{yBound.toFixed(0)} ns
        </text>
        {uniformThreshold !== null && thresholdInView && (
          <text x={ml + pw} y={bandTop - 3} className="sim-chart-tick" textAnchor="end">
            {`+${formatThreshold(uniformThreshold)} 阈值`}
          </text>
        )}
        {uniformThreshold !== null && thresholdInView && (
          <text x={ml + pw} y={bandBottom + 11} className="sim-chart-tick" textAnchor="end">
            {`-${formatThreshold(uniformThreshold)} 阈值`}
          </text>
        )}
        {uniformThreshold === null && (
          <text x={ml + pw} y={mt + 11} className="sim-chart-tick" textAnchor="end">
            各节点阈值不一（见表格参考线）
          </text>
        )}
        <text x={ml + pw} y={mt + ph + 18} className="sim-chart-tick" textAnchor="end">
          {(tMax / 1000).toFixed(tMax >= 1000 ? 0 : 2)} s
        </text>
        <text x={ml} y={mt + ph + 18} className="sim-chart-tick" textAnchor="start">
          0
        </text>
        {/* 各从节点折线（裁剪到绘图区，溢出尖峰被截断） */}
        <g clipPath="url(#sim-chart-plot)">
          {nodes.map((n, i) => (
            <polyline
              key={n.mid}
              className="sim-chart-line"
              fill="none"
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              points={n.samples.map((s) => `${xAt(s.tMs)},${yAt(s.offsetNs)}`).join(" ")}
            />
          ))}
        </g>
      </svg>
      <ul className="sim-chart-legend">
        {nodes.map((n, i) => (
          <li key={n.mid} title={n.mid}>
            <span
              className="sim-chart-swatch"
              style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
              aria-hidden="true"
            />
            {shortNodeName(n.mid)}
          </li>
        ))}
      </ul>
    </figure>
  );
}
