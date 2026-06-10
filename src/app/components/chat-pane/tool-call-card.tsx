import { useState } from "react";
import type { ToolCallRecord } from "../../../agent/tool-call-record";
import { redactProviderNamesForDisplay, redactProviderNamesInValue } from "../../../ui/display-redaction";

/**
 * Plan 2026-06-09-003 U7：对话流内联工具调用卡片。折叠态一行（状态 + 友好名 +
 * 摘要），展开看完整入参 / 出参。展开态为组件瞬态、默认折叠（KTD6）。
 *
 * Plan 2026-06-10-001 U5：新增 running 流式态——状态符「…」+ accent 脉冲；卡片按
 * `id` 为 key，状态翻转只换 props 不卸载组件，展开态自然保持。
 */
export function ToolCallCard({ record }: { record: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  const failed = record.status === "error";
  const running = record.status === "running";
  const statusClass = failed ? "failed" : running ? "running" : "ok";

  return (
    <div className={`tool-call-card ${statusClass}`}>
      <button
        type="button"
        className="tool-call-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-call-status" aria-label={failed ? "失败" : running ? "运行中" : "成功"}>
          {failed ? "✕" : running ? "…" : "✓"}
        </span>
        <span className="tool-call-name mono">{redactProviderNamesForDisplay(record.friendlyName)}</span>
        <span className="tool-call-brief">{redactProviderNamesForDisplay(record.summary)}</span>
        <span className="tool-call-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="tool-call-detail">
          <ToolCallSection label="入参" value={record.args} />
          {running ? (
            <div className="tool-call-section">
              <div className="tool-call-section-label">出参</div>
              <pre className="tool-call-body mono">执行中…</pre>
            </div>
          ) : (
            <ToolCallSection label="出参" value={record.result} truncated={record.resultTruncated} />
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallSection({ label, value, truncated }: { label: string; value: unknown; truncated?: boolean }) {
  return (
    <div className="tool-call-section">
      <div className="tool-call-section-label">{truncated ? `${label} · 结果已截断` : label}</div>
      <pre className="tool-call-body mono">{formatValue(value)}</pre>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "（空）";
  }

  if (typeof value === "string") {
    return redactProviderNamesForDisplay(value);
  }

  try {
    return JSON.stringify(redactProviderNamesInValue(value), null, 2);
  } catch {
    return String(value);
  }
}
