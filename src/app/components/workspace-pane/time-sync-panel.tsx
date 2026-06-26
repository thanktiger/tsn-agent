import { useRef, useState } from "react";
import {
  buildSimExplainPrompt,
  hasNonConvergedNode,
  invokeRunTimesyncSim,
  invokeSimExplain,
  isFullyConverged,
  type PerNodeOffset,
  type SimOverrideForm,
  type SimResult,
  type SimUiState,
} from "./timesync-sim";

/**
 * U11/U12/U13：时钟同步 tab 内容——软/硬仿按钮 + 门控 + 运行态 + 结果表 + 覆盖表单 + 解释。
 *
 * 运行态（simState）持于 App 级、经 props 透传：切 tab 不取消命令、切回按 status 恢复。
 * 覆盖表单展开/填值是组件内独立 intent（doc-review 决定：跨软仿运行保留、仅会话切换重置）。
 */

export interface TimeSyncPanelProps {
  /** 当前阶段是否 time-sync。 */
  inTimeSyncStage: boolean;
  /** 时钟树是否已确认（GM 已设）；软仿门控第二条件。 */
  treeConfirmed: boolean;
  sessionId: string;
  simState: SimUiState;
  onSimStateChange: (state: SimUiState) => void;
  /** 软仿写通道（测试注入替身）。 */
  runTimesyncSim?: (sessionId: string, overrides: SimOverrideForm) => Promise<SimResult>;
  /** 解释通道（测试注入替身）。 */
  explainSim?: (prompt: string) => Promise<string>;
}

const HARD_SIM_PLACEHOLDER = "待接入真实硬件";

export function TimeSyncPanel({
  inTimeSyncStage,
  treeConfirmed,
  sessionId,
  simState,
  onSimStateChange,
  runTimesyncSim = invokeRunTimesyncSim,
  explainSim = invokeSimExplain,
}: TimeSyncPanelProps) {
  // U12：覆盖表单状态（默认收起，跨软仿运行保留）。
  const [formExpanded, setFormExpanded] = useState(false);
  const [form, setForm] = useState<SimOverrideForm>({});
  const [hardSimNotice, setHardSimNotice] = useState(false);
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
    // 运行前定格当前会话：await 期间用户切走时，迟到结果不得落进新会话的状态。
    const runSessionId = sessionId;
    setHardSimNotice(false);
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
      aria-label="时钟同步"
    >
      <div className="panel-heading">
        <div>
          <h2>时钟同步软仿</h2>
          <p>把当前拓扑 + 时钟树组装成 INET gPTP 软仿，远端跑完取回各节点相对 GM 的收敛偏差。</p>
        </div>
      </div>

      <div className="sim-actions" role="group" aria-label="仿真操作">
        <button
          type="button"
          className="btn primary"
          disabled={softSimDisabled}
          title={softSimTooltip}
          onClick={() => void handleSoftSim()}
        >
          {running ? "软仿运行中…" : "软仿"}
        </button>
        <button type="button" className="btn" onClick={() => setHardSimNotice(true)}>
          硬仿
        </button>
      </div>
      {hardSimNotice && (
        <p className="sim-hint mono" role="status">
          {HARD_SIM_PLACEHOLDER}
        </p>
      )}

      <SimOverrideRegion
        expanded={formExpanded}
        form={form}
        onToggle={() => setFormExpanded((value) => !value)}
        onChange={setForm}
      />

      <SimResultArea
        simState={simState}
        explainState={explainState}
        explainFailed={explainFailed}
        onExplain={handleExplain}
      />
    </section>
  );
}

/** U12：软仿覆盖表单（3 参数，默认收起）。 */
function SimOverrideRegion({
  expanded,
  form,
  onToggle,
  onChange,
}: {
  expanded: boolean;
  form: SimOverrideForm;
  onToggle: () => void;
  onChange: (form: SimOverrideForm) => void;
}) {
  return (
    <div className="sim-override">
      <button
        type="button"
        className="sim-override-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? "▾" : "▸"} 覆盖参数（不填走默认）
      </button>
      {expanded && (
        <div className="sim-override-fields" role="group" aria-label="软仿覆盖参数">
          <label className="sim-field">
            <span>振荡器类型</span>
            <select
              value={form.oscillator ?? ""}
              onChange={(event) =>
                onChange({
                  ...form,
                  oscillator:
                    event.target.value === ""
                      ? undefined
                      : (event.target.value as "Constant" | "Random"),
                })
              }
            >
              <option value="">默认</option>
              <option value="Constant">Constant</option>
              <option value="Random">Random</option>
            </select>
          </label>
          <label className="sim-field">
            <span>漂移幅度（ppm）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.driftPpm ?? ""}
              onChange={(event) =>
                onChange({
                  ...form,
                  driftPpm: event.target.value === "" ? undefined : Number(event.target.value),
                })
              }
            />
          </label>
          <label className="sim-field">
            <span>仿真时长（s）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.simTimeS ?? ""}
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

// 区分度优先的定性调色板（Okabe–Ito 色盲友好系，去掉过浅的黄）。
const CHART_COLORS = [
  "#0072B2",
  "#E69F00",
  "#009E73",
  "#D55E00",
  "#CC79A7",
  "#56B4E9",
  "#8C564B",
  "#5D3FD3",
];

/** 收敛阈值（ns），镜像后端 CONVERGENCE_THRESHOLD_NS=1000（1µs）。 */
const CONVERGENCE_THRESHOLD_NS = 1000;

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
  // y 轴裁剪：取 |offset| 的 95 分位（×1.3 余量）与阈值的较大者作对称上界，
  // 让启动瞬态的大锯齿溢出截断，稳态抖动才看得清。
  absVals.sort((a, b) => a - b);
  const p95 = absVals[Math.floor(absVals.length * 0.95)] ?? 0;
  const yBound = Math.max(CONVERGENCE_THRESHOLD_NS * 1.3, p95 * 1.3, 1);
  const clipped = rawAbsMax > yBound;

  const tSpan = tMax > 0 ? tMax : 1;
  const xAt = (t: number) => ml + (t / tSpan) * pw;
  const yAt = (v: number) => mt + (1 - (v + yBound) / (2 * yBound)) * ph;
  const baseline = yAt(0);
  const bandTop = yAt(CONVERGENCE_THRESHOLD_NS);
  const bandBottom = yAt(-CONVERGENCE_THRESHOLD_NS);

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
        {/* ±1µs 收敛阈值带 */}
        <rect
          x={ml}
          y={bandTop}
          width={pw}
          height={bandBottom - bandTop}
          className="sim-chart-threshold-band"
        />
        {/* 坐标框 + 0 基线 */}
        <line x1={ml} y1={mt} x2={ml} y2={mt + ph} className="sim-chart-axis" />
        <line x1={ml} y1={mt + ph} x2={ml + pw} y2={mt + ph} className="sim-chart-axis" />
        <line x1={ml} y1={baseline} x2={ml + pw} y2={baseline} className="sim-chart-baseline" />
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
        <text x={ml + pw} y={bandTop - 3} className="sim-chart-tick" textAnchor="end">
          ±1µs 阈值
        </text>
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
