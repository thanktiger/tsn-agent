import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { DiagnosticLogEntry } from "../../diagnostics/diagnostic-log";
import type { DiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";
import { redactProviderNamesForDisplay, redactProviderNamesInValue } from "../display-redaction";

interface DiagnosticsLogViewProps {
  sessionId: string;
  repository: DiagnosticLogRepository;
}

const FILTERS = [
  { label: "全部", value: "all" },
  { label: "Agent", value: "agent" },
  { label: "会话", value: "session" },
  { label: "文件", value: "artifact" },
  { label: "错误", value: "error" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

export function DiagnosticsLogView({ sessionId, repository }: DiagnosticsLogViewProps) {
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function loadLogs() {
    setIsLoading(true);
    setError(undefined);

    try {
      setLogs(await repository.list(sessionId));
    } catch (innerError) {
      setError(normalizeError(innerError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadLogs();
  }, [sessionId]);

  const filteredLogs = useMemo(() => {
    if (filter === "all") {
      return logs;
    }

    if (filter === "error") {
      return logs.filter((log) => log.level === "error" || log.level === "warn");
    }

    return logs.filter((log) => log.category === filter);
  }, [filter, logs]);

  return (
    <div className="diagnostics-panel">
      <div className="diagnostics-toolbar">
        <div className="diag-filter-group" role="group" aria-label="日志筛选">
          {FILTERS.map((item) => (
            <button
              className={filter === item.value ? "diag-filter active" : "diag-filter"}
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button className="btn" type="button" onClick={loadLogs} disabled={isLoading}>
          <RefreshCw size={14} aria-hidden="true" />
          刷新
        </button>
      </div>

      {error && <div className="diagnostics-error">日志加载失败：{redactProviderNamesForDisplay(error)}</div>}
      {!error && filteredLogs.length === 0 && (
        <div className="empty-panel mono">{isLoading ? "正在加载日志" : "当前会话暂无诊断日志"}</div>
      )}
      {!error && filteredLogs.length > 0 && (
        <ol className="diagnostics-list" aria-label="当前会话诊断日志">
          {filteredLogs.map((log) => (
            <li className={`diagnostics-item ${log.level}`} key={log.id}>
              <div className="diagnostics-row">
                <span className={`diag-level ${log.level}`}>{log.level.toUpperCase()}</span>
                <span className="diag-category">{categoryLabel(log.category)}</span>
                <time className="diag-time">{formatTime(log.createdAt)}</time>
              </div>
              <strong>{redactProviderNamesForDisplay(log.message)}</strong>
              <div className="diagnostics-meta mono">
                {log.runId && <span>run={redactProviderNamesForDisplay(log.runId)}</span>}
                {typeof log.durationMs === "number" && <span>{log.durationMs}ms</span>}
              </div>
              {log.details && (
                <details>
                  <summary>details</summary>
                  <pre>{JSON.stringify(redactProviderNamesInValue(log.details), null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function categoryLabel(category: DiagnosticLogEntry["category"]): string {
  switch (category) {
    case "agent":
      return "Agent";
    case "artifact":
      return "文件";
    case "session":
      return "会话";
    case "system":
      return "系统";
  }
}

function formatTime(value: string): string {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && value.length < 16 ? new Date(numeric) : new Date(value);

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "未知错误";
}
