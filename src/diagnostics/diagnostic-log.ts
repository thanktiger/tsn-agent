import { redactSecrets } from "../sessions/session-repository";
import { redactProviderNamesForDisplay, redactProviderNamesInValue } from "../ui/display-redaction";

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticLogCategory = "agent" | "session" | "artifact" | "system";

export interface DiagnosticLogEntry {
  id: string;
  sessionId: string;
  category: DiagnosticLogCategory;
  level: DiagnosticLogLevel;
  message: string;
  createdAt: string;
  runId?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface DiagnosticLogInput {
  sessionId: string;
  category: DiagnosticLogCategory;
  level?: DiagnosticLogLevel;
  message: string;
  runId?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

const MAX_DETAIL_STRING_LENGTH = 480;
const MAX_DETAIL_DEPTH = 4;

export function createDiagnosticLogEntry(input: DiagnosticLogInput): DiagnosticLogEntry {
  return sanitizeDiagnosticLogEntry({
    id: createDiagnosticId(),
    createdAt: Date.now().toString(),
    level: "info",
    ...input,
  });
}

export function sanitizeDiagnosticLogEntry(entry: DiagnosticLogEntry): DiagnosticLogEntry {
  return {
    ...entry,
    runId: entry.runId ? redactProviderNamesForDisplay(entry.runId) : undefined,
    message: redactAndTruncate(entry.message),
    details: entry.details ? sanitizeDetails(entry.details) : undefined,
  };
}

export function summarizeText(value: string, maxLength = 160): string {
  const redacted = redactSecrets(value).replace(/\s+/g, " ").trim();

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, maxLength)}...`;
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  return redactProviderNamesInValue(sanitizeValue(details, 0)) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DETAIL_DEPTH) {
    return "[truncated]";
  }

  if (typeof value === "string") {
    return redactAndTruncate(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 24).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 48)
        .map(([key, innerValue]) => [
          redactAndTruncate(key),
          isSensitiveKey(key) ? "[redacted]" : sanitizeValue(innerValue, depth + 1),
        ]),
    );
  }

  return undefined;
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|claude_api_key|authorization/i.test(key);
}

function redactAndTruncate(value: string): string {
  const redacted = redactProviderNamesForDisplay(redactSecrets(value));

  if (redacted.length <= MAX_DETAIL_STRING_LENGTH) {
    return redacted;
  }

  return `${redacted.slice(0, MAX_DETAIL_STRING_LENGTH)}...`;
}

function createDiagnosticId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return `diagnostic-${random}`;
}
