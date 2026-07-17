import { CHART_COLORS } from "./chart-palette";
import type { ListFlowStreamRow } from "./flow-sim";
import { PanelCta } from "./panel-cta";

/**
 * 流量列表组件（U4 → 表格化重构，对齐参考规范图）：
 * 列 = 类型（class 徽章）/ 流量ID（F{seq}）/ 节点路径 / 流名称 / PCP / 周期 / 最大帧长 / 抖动 / 最大延迟 / 操作。
 * - ST=CHART_COLORS[0]（#0072B2），BE=CHART_COLORS[1]（#E69F00），RC=CHART_COLORS[2]（#009E73）。
 * - 行单击切换 selectedFlowSeq（已选再点→null）；「详情」按钮触发 onOpenDetail。
 * - isLoading=true 且无数据 → 不出 PanelCta；isLoading=false 且无数据 → 出 PanelCta。
 */

export interface FlowStreamListProps {
  streams: ListFlowStreamRow[];
  selectedFlowSeq: number | null;
  onSelectFlowSeq: (seq: number | null) => void;
  onOpenDetail: (stream: ListFlowStreamRow) => void;
  inFlowStage: boolean;
  isLoading: boolean;
}

/** 流量类别 → 徽章颜色（Okabe-Ito，与门控时序图/曲线图同源）。 */
function classBadgeColor(cls: string): string {
  switch (cls) {
    case "ST":
      return CHART_COLORS[0]; // #0072B2
    case "BE":
      return CHART_COLORS[1]; // #E69F00
    case "RC":
      return CHART_COLORS[2]; // #009E73
    default:
      return CHART_COLORS[0];
  }
}

/** 节点路径展示：路由推导失败（空数组）回退 talker → listener。 */
function nodePathText(s: ListFlowStreamRow): string {
  const path = s.nodePath.length > 0 ? s.nodePath : [s.talker, s.listener];
  return path.join(" → ");
}

export function FlowStreamList({
  streams,
  selectedFlowSeq,
  onSelectFlowSeq,
  onOpenDetail,
  inFlowStage,
  isLoading,
}: FlowStreamListProps) {
  // 有数据时直接展示表格，不论 isLoading。
  if (streams.length > 0) {
    return (
      <div className="flow-stream-list">
        <table className="eng-table flow-stream-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>流量ID</th>
              <th>节点路径</th>
              <th>流名称</th>
              <th>PCP优先级</th>
              <th>周期(μs)</th>
              <th>最大帧长(B)</th>
              <th>抖动(ns)</th>
              <th>最大延迟(μs)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {streams.map((s) => {
              const selected = s.streamSeq === selectedFlowSeq;
              const color = classBadgeColor(s.class);
              return (
                <tr
                  key={s.streamSeq}
                  className={`flow-row${selected ? " selected" : ""}`}
                  aria-selected={selected}
                  tabIndex={0}
                  onClick={() => onSelectFlowSeq(selected ? null : s.streamSeq)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectFlowSeq(selected ? null : s.streamSeq);
                    }
                  }}
                >
                  <td>
                    <span
                      className="flow-stream-badge"
                      style={{ background: color }}
                      role="img"
                      aria-label={`类别 ${s.class}`}
                    >
                      {s.class}
                    </span>
                  </td>
                  <td className="flow-stream-seq mono">F{s.streamSeq}</td>
                  <td className="flow-stream-route mono">{nodePathText(s)}</td>
                  <td>{s.name ?? "—"}</td>
                  <td className="mono">{s.pcp}</td>
                  <td className="mono">{s.periodUs}</td>
                  <td className="mono">{s.frameBytes}</td>
                  <td className="mono">{s.jitterNs ?? "—"}</td>
                  <td className="mono">{s.maxLatencyUs ?? "—"}</td>
                  <td>
                    {/* stopPropagation 避免触发行选中 */}
                    <button
                      type="button"
                      className="flow-stream-detail-btn btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenDetail(s);
                      }}
                      aria-label={`流 F${s.streamSeq} 详情`}
                    >
                      详情
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // 无数据：loading 中不出 PanelCta（防 CTA 闪现被误点）。
  if (isLoading) {
    return null;
  }

  // 无数据且不在 loading：空态 CTA。
  return (
    <PanelCta
      label="录入流量"
      hint="通过与 Agent 对话，描述流量需求，Agent 将自动录入到流量规划表中。"
      onClick={() => {}}
      disabled={!inFlowStage}
      title={!inFlowStage ? "请先进入流量规划阶段" : undefined}
    />
  );
}
