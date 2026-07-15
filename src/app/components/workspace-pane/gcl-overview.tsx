import { useState } from "react";
import { type GclOverview, nsToUs } from "./flow-sim";

/** 求解器出处徽章（R8/KTD7 诚实边界）：Z3 带保证 / Eager 兜底无保证。 */
export function SolverBadge({ solver, z3 }: { solver: string; z3: boolean }) {
  // z3 复用 sim-badge ok 绿（与收敛/达标同语义，不再复制一份同色对）；兜底解走 besteffort 琥珀色。
  return (
    <span className={`flow-solver-badge ${z3 ? "sim-badge ok" : "besteffort"}`}>
      {z3 ? `${solver}·带可调度性保证` : `${solver}·兜底解无保证`}
    </span>
  );
}

/** 百分比格式化（概览卡）：null → 「—」。 */
function fmtPct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

/** 概览统计卡（U9/R15）：标签 + 主值 + 副行小字；modifier=--ok（绿）/--stale（琥珀）。 */
function OverviewCard({
  label,
  value,
  sub,
  modifier = "",
}: {
  label: string;
  value: string;
  sub: string;
  modifier?: string;
}) {
  return (
    <div className={`gcl-overview-card${modifier}`}>
      <span className="gcl-overview-card__label">{label}</span>
      <span className="gcl-overview-card__value">{value}</span>
      <span className="gcl-overview-card__sub">{sub}</span>
    </div>
  );
}

/**
 * 门控概览八卡（U9/R15）：静态标题 + 4×2 grid（窄面板 auto-fit 换行，boss 定不折叠）。
 * 时延分析卡（高亮）可点击展开每流明细表（流名/时延/裕度——负裕度红字挂「口径不同」，
 * KTD9 推导模型≠求解器约束口径）。全部数值为规划推导值，非实测（R9 诚实边界）。
 */
export function GclOverviewSection({ overview }: { overview: GclOverview }) {
  const [latencyOpen, setLatencyOpen] = useState(false);
  const lat = overview.latency;

  // ① 调度状态：stale 过期（KTD14）优先于 status 三态。
  let statusValue: string;
  let statusSub: string;
  let statusMod = "";
  if (overview.stale) {
    statusValue = "需重新规划";
    statusSub = "配置已变更";
    statusMod = " gcl-overview-card--stale";
  } else if (overview.scheduleStatus === "ok") {
    statusValue = "可调度";
    statusSub = "GCL 已生成";
    statusMod = " gcl-overview-card--ok";
  } else if (overview.scheduleStatus === "no_gating") {
    statusValue = "无需门控";
    statusSub = "流集无 ST 流";
  } else {
    statusValue = "未规划";
    statusSub = "尚无规划结果";
  }

  const latencySub = `最大端到端时延·规划推导值${
    lat.excludedCount > 0 ? `（${lat.excludedCount} 条流未计入）` : ""
  }`;

  return (
    <div className="gcl-overview">
      <p className="gcl-overview-title">门控概览</p>
      <div className="gcl-overview-grid">
        <OverviewCard label="调度状态" value={statusValue} sub={statusSub} modifier={statusMod} />
        <OverviewCard
          label="超周期"
          value={overview.cycleNs !== null ? `${nsToUs(overview.cycleNs)} μs` : "—"}
          sub="规划周期"
        />
        <OverviewCard
          label="业务流 / 门控端口"
          value={`${overview.streamCount} 条 / ${overview.gatedPortCount}`}
          sub={
            overview.gatedQueues.length > 0
              ? `涉及 ${overview.gatedQueues.map((q) => `q${q}`).join(",")} 队列`
              : "无门控队列"
          }
        />
        <OverviewCard
          label="GCL 表项"
          value={`${overview.entryCount}`}
          sub={`打开窗口 ${overview.openWindowCount} 个`}
        />
        <OverviewCard
          label="最大门控窗口占用"
          value={fmtPct(overview.maxPortOpenPct)}
          sub="按端口打开窗口/超周期推导"
        />
        <OverviewCard
          label="最大链路带宽占用"
          value={fmtPct(overview.maxLinkUtilizationPct)}
          sub={overview.maxLinkUtilizationPct === null ? "链路速率未知" : "按流带宽/链路速率推导"}
        />
        <OverviewCard
          label="关闭窗口占比"
          value={fmtPct(overview.closedPct)}
          sub="全关窗口/所有端口周期"
        />
        {/* ⑧ 时延分析（高亮卡）：可点击展开每流明细。 */}
        <button
          type="button"
          className="gcl-overview-card gcl-overview-card--highlight"
          aria-expanded={latencyOpen}
          onClick={() => setLatencyOpen((v) => !v)}
          disabled={lat.rows.length === 0}
          title={lat.rows.length > 0 ? "点击展开每流时延明细" : undefined}
        >
          <span className="gcl-overview-card__label">时延分析</span>
          <span className="gcl-overview-card__value">
            {lat.maxLatencyNs !== null ? `最大端到端 ${nsToUs(lat.maxLatencyNs)} μs` : "—"}
          </span>
          <span className="gcl-overview-card__sub">{latencySub}</span>
        </button>
      </div>
      {latencyOpen && lat.rows.length > 0 && (
        <table className="eng-table gcl-overview-latency-table">
          <thead>
            <tr>
              <th>流</th>
              <th>端到端时延(μs)</th>
              <th>裕度</th>
            </tr>
          </thead>
          <tbody>
            {lat.rows.map((r) => {
              const marginNs = r.maxLatencyNs !== null ? r.maxLatencyNs - r.latencyNs : null;
              return (
                <tr key={r.streamSeq}>
                  <td>{r.name}</td>
                  <td className="mono">{nsToUs(r.latencyNs)}</td>
                  <td className="mono">
                    {marginNs === null ? (
                      "未设上限"
                    ) : marginNs >= 0 ? (
                      `${nsToUs(marginNs)} μs`
                    ) : (
                      <span
                        className="gcl-overview-margin-neg"
                        title="推导模型与求解器约束口径不同"
                      >
                        {nsToUs(marginNs)} μs（口径不同）
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
