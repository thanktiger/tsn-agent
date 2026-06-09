import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { DiagnosticLogEntry } from "../../diagnostics/diagnostic-log";
import type { DiagnosticLogRepository } from "../../diagnostics/diagnostic-log-repository";
import { redactProviderNamesForDisplay, redactProviderNamesInValue } from "../display-redaction";

interface DiagnosticsLogViewProps {
  sessionId: string;
  repository: DiagnosticLogRepository;
}

export function DiagnosticsLogView({ sessionId, repository }: DiagnosticsLogViewProps) {
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);
  const [selectedLogId, setSelectedLogId] = useState<string>();
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

  const selectedLog = logs.find((log) => log.id === selectedLogId) ?? logs[0];

  useEffect(() => {
    if (logs.length === 0) {
      setSelectedLogId(undefined);
      return;
    }

    if (!logs.some((log) => log.id === selectedLogId)) {
      setSelectedLogId(logs[0].id);
    }
  }, [logs, selectedLogId]);

  return (
    <div className="diagnostics-panel">
      <div className="diagnostics-toolbar">
        <button className="btn" type="button" onClick={loadLogs} disabled={isLoading}>
          <RefreshCw size={14} aria-hidden="true" />
          刷新
        </button>
      </div>

      {error && <div className="diagnostics-error">日志加载失败：{redactProviderNamesForDisplay(error)}</div>}
      {!error && logs.length === 0 && (
        <div className="empty-panel mono">{isLoading ? "正在加载日志" : "当前会话暂无诊断日志"}</div>
      )}
      {!error && logs.length > 0 && (
        <div className="master-detail-layout diagnostics-detail-layout">
          <ol className="diagnostics-list master-list" aria-label="当前会话诊断日志">
            {logs.map((log) => (
              <li key={log.id}>
                <button
                  className={`diagnostics-item master-list-item ${log.level} ${selectedLog?.id === log.id ? "active" : ""}`}
                  type="button"
                  aria-selected={selectedLog?.id === log.id}
                  onClick={() => setSelectedLogId(log.id)}
                >
                  <div className="diagnostics-row">
                    <span className={`diag-level ${log.level}`}>{log.level.toUpperCase()}</span>
                    <span className="diag-category">{categoryLabel(log.category)}</span>
                    <time className="diag-time">{formatTime(log.createdAt)}</time>
                  </div>
                  <strong>{redactProviderNamesForDisplay(log.message)}</strong>
                  <div className="diagnostics-meta mono">
                    {log.runId && <span>run={redactProviderNamesForDisplay(log.runId)}</span>}
                    {typeof log.durationMs === "number" && <span>{log.durationMs}ms</span>}
                    {log.details && <span>details</span>}
                  </div>
                </button>
              </li>
            ))}
          </ol>
          <DiagnosticLogDetail log={selectedLog} />
        </div>
      )}
    </div>
  );
}

function DiagnosticLogDetail({ log }: { log?: DiagnosticLogEntry }) {
  if (!log) {
    return <div className="empty-panel mono">请选择一条日志查看详情</div>;
  }

  return (
    <section className={`detail-surface diagnostics-detail ${log.level}`} aria-label="日志详情">
      <div className="detail-surface-header">
        <div>
          <p className="drawer-kicker">Log Detail</p>
          <h3>{redactProviderNamesForDisplay(log.message)}</h3>
        </div>
        <span className={`diag-level ${log.level}`}>{log.level.toUpperCase()}</span>
      </div>
      <div className="detail-grid">
        <DetailField label="类别" value={categoryLabel(log.category)} />
        <DetailField label="时间" value={formatDateTime(log.createdAt)} />
        <DetailField label="Run" value={log.runId ? redactProviderNamesForDisplay(log.runId) : "无"} />
        <DetailField label="耗时" value={typeof log.durationMs === "number" ? `${log.durationMs}ms` : "无"} />
      </div>
      {log.details ? (
        <pre className="diagnostics-detail-json">
          {JSON.stringify(redactProviderNamesInValue(log.details), null, 2)}
        </pre>
      ) : (
        <div className="empty-panel mono">该日志没有附加详情</div>
      )}
    </section>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
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

function formatDateTime(value: string): string {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && value.length < 16 ? new Date(numeric) : new Date(value);

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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
