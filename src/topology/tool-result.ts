export type TopologyErrorSeverity = "error" | "warning";

export interface TopologyError {
  code: string;
  message: string;
  path: string;
  severity: TopologyErrorSeverity;
  details: Record<string, unknown>;
  retryable: boolean;
  requiresUserClarification: boolean;
}

export interface TopologyWarning {
  code: string;
  message: string;
  path: string;
}

export type TopologyResponseMode = "summary" | "full";

export interface TopologyResultMetadata {
  responseMode: TopologyResponseMode;
  summaryOnly: boolean;
}

export interface TopologySuccess<TSummary, TFull = never> {
  ok: true;
  summary: TSummary;
  full?: TFull;
  warnings: TopologyWarning[];
  metadata: TopologyResultMetadata;
}

export interface TopologyFailure {
  ok: false;
  errors: TopologyError[];
  warnings: TopologyWarning[];
  metadata: TopologyResultMetadata;
}

export type TopologyToolResult<TSummary, TFull = never> =
  | TopologySuccess<TSummary, TFull>
  | TopologyFailure;

export function topologyError(input: {
  code: string;
  message: string;
  path?: string;
  severity?: TopologyErrorSeverity;
  details?: Record<string, unknown>;
  retryable?: boolean;
  requiresUserClarification?: boolean;
}): TopologyError {
  return {
    code: input.code,
    message: input.message,
    path: input.path ?? "$",
    severity: input.severity ?? "error",
    details: input.details ?? {},
    retryable: input.retryable ?? false,
    requiresUserClarification: input.requiresUserClarification ?? false,
  };
}

export function topologyWarning(input: {
  code: string;
  message: string;
  path?: string;
}): TopologyWarning {
  return {
    code: input.code,
    message: input.message,
    path: input.path ?? "$",
  };
}

export function okResult<TSummary, TFull = never>(input: {
  summary: TSummary;
  full?: TFull;
  warnings?: TopologyWarning[];
  responseMode?: TopologyResponseMode;
}): TopologyToolResult<TSummary, TFull> {
  const responseMode = input.responseMode ?? "summary";

  return {
    ok: true,
    summary: input.summary,
    full: responseMode === "full" ? input.full : undefined,
    warnings: input.warnings ?? [],
    metadata: {
      responseMode,
      summaryOnly: responseMode !== "full",
    },
  };
}

export function failResult<TSummary = never, TFull = never>(input: {
  errors: TopologyError[];
  warnings?: TopologyWarning[];
  responseMode?: TopologyResponseMode;
}): TopologyToolResult<TSummary, TFull> {
  const responseMode = input.responseMode ?? "summary";

  return {
    ok: false,
    errors: input.errors,
    warnings: input.warnings ?? [],
    metadata: {
      responseMode,
      summaryOnly: responseMode !== "full",
    },
  };
}

export function forbiddenFullResponseError(path = "$.responseMode"): TopologyError {
  return topologyError({
    code: "FORBIDDEN_RESPONSE_MODE",
    message: "Agent-facing topology MCP tools only allow full topology payloads for explicitly authorized initialize/apply_operations calls; artifacts, port tables and full changeSets stay local.",
    path,
    retryable: false,
  });
}

export function asSummaryMode(responseMode?: TopologyResponseMode): TopologyResponseMode {
  return responseMode === "full" ? "full" : "summary";
}
