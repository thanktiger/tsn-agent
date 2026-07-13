import { CHART_COLORS } from "./chart-palette";
import type { ListFlowStreamRow } from "./flow-sim";
import { PanelCta } from "./panel-cta";

/**
 * 流量列表组件（U4）：class 徽章 + 行选中/切换 + 详情入口。
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

export function FlowStreamList({
  streams,
  selectedFlowSeq,
  onSelectFlowSeq,
  onOpenDetail,
  inFlowStage,
  isLoading,
}: FlowStreamListProps) {
  // 有数据时直接展示列表，不论 isLoading。
  if (streams.length > 0) {
    return (
      <div className="flow-stream-list" role="listbox" aria-label="流量列表">
        {streams.map((s) => {
          const selected = s.streamSeq === selectedFlowSeq;
          const color = classBadgeColor(s.class);
          return (
            <div
              key={s.streamSeq}
              className={`flow-stream-row${selected ? " selected" : ""}`}
              role="option"
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
              {/* 类别徽章：role="img" 让 aria-label 合法 */}
              <span
                className="flow-stream-badge"
                style={{ background: color }}
                role="img"
                aria-label={`类别 ${s.class}`}
              >
                {s.class}
              </span>

              {/* 主要信息 */}
              <span className="flow-stream-info">
                <span className="flow-stream-seq mono">F{s.streamSeq}</span>
                <span className="flow-stream-route">
                  {s.talker} → {s.listener}
                </span>
                <span className="flow-stream-meta mono">
                  {s.periodUs}µs · {s.frameBytes}B
                </span>
              </span>

              {/* 详情按钮：stopPropagation 避免触发行选中 */}
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
            </div>
          );
        })}
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
