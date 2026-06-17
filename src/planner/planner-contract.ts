export const PLANNER_SERVICE_DEFAULT_BASE_URL = "http://100.78.48.43:18080";

export type PlannerMode = "time-trigger";

export type PlannerTaskState =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "busy"
  | "cancel_requested"
  | "cancelled"
  | "no_running_plan"
  | "not_found"
  | "stale"
  | "unknown";

export interface PlannerServiceEnvelope<TData> {
  err_code: number;
  err_msg: string;
  data: TData;
  trace_id?: string;
  timestamp?: string;
}

export interface PlannerStartRequest {
  sendData: {
    mode: PlannerMode;
    source_config: PlannerSourceConfig;
  };
}

export interface PlannerSourceConfig {
  cfg_parameter: {
    cfg_parameter: {
      node: PlannerNodeParameter[];
    };
  };
  flow_feature: PlannerFlowFeature[];
  topo_feature: PlannerTopoFeature[];
}

export interface PlannerNodeParameter {
  node_id: string;
  system_clock: string;
  rc_threshold: string;
  hpriority_policing_threshold: string;
  lpriority_policing_threshold: string;
  qbv_or_qch: "0" | "1";
  qci_enable: "0";
  ptp_threshold?: string | null;
  port_num: string;
  node_type: "0" | "1";
  vlan_cfg?: string | null;
  vlan_id?: string | null;
}

export interface PlannerFlowFeature {
  stream_id: number;
  src_node: number | null;
  dst_node: number | number[] | null;
  path_number: number | null;
  size: number;
  period: number;
  path: PlannerPathFeature[];
}

export interface PlannerPathFeature {
  route: number[];
  flow_type?: "ST" | null;
  latency_requirement: number;
  jitter_requirement: number;
  redundant: 0 | 1;
  fl_api_flag: 0 | 1;
  delay_para: number;
  src_ip: string;
  dst_ip: string;
  src_port: number;
  dst_port: number;
  dst_mac: string;
  ip_protocol: number;
  fivetuple_mask: number;
}

export interface PlannerTopoFeature {
  link_id: number;
  src_node: number;
  src_port: number;
  dst_node: number;
  dst_port: number;
  speed: number;
  st_queues: number;
  macrotick: number;
}

export interface PlannerStartResponseData {
  state: Extract<PlannerTaskState, "running" | "succeeded" | "failed" | "busy">;
  plan_id?: string;
  started_at?: string | null;
  running_plan_id?: string;
  running_duration_ms?: number | null;
  suggestion?: string;
  detail?: unknown;
}

export interface PlannerPlanIdRequest {
  sendData: {
    plan_id: string;
  };
}

export interface PlannerQueryStatusResponseData {
  state: Exclude<PlannerTaskState, "idle" | "unknown">;
  plan_id?: string;
  started_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
  running_duration_ms?: number | null;
  internal_result?: unknown;
  error_code?: string | number | null;
  error_message?: string | null;
}

export interface PlannerResultResponseData {
  state: Extract<PlannerTaskState, "succeeded" | "running" | "failed" | "cancel_requested" | "not_found">;
  plan_id?: string;
  source_outputs?: PlannerSourceOutputs;
  output_fingerprints?: PlannerOutputFingerprints;
  error_code?: string | number | null;
  error_message?: string | null;
}

export interface PlannerStopResponseData {
  state: Extract<PlannerTaskState, "cancelled" | "no_running_plan" | "failed">;
  stopped_plan_id?: string | null;
  requested_plan_id?: string | null;
}

export interface PlannerSourceOutputs {
  solution_json?: unknown;
  tsnlight_plan_cfg_json?: unknown;
}

export interface PlannerOutputFingerprints {
  solution_json?: PlannerOutputFingerprint;
  tsnlight_plan_cfg_json?: PlannerOutputFingerprint;
  [key: string]: PlannerOutputFingerprint | undefined;
}

export interface PlannerOutputFingerprint {
  file_name: string;
  size_bytes: number;
  sha256: string;
  mtime_ns: number;
}

export interface PlannerRequestSummary {
  mode: PlannerMode;
  nodeCount: number;
  linkCount: number;
  flowCount: number;
  streamIds: number[];
}

export interface PlannerResultSummary {
  linkCount: number;
  gclEntryCount: number;
  fingerprintFiles: string[];
}

export interface PlannerResultSnapshot {
  planId: string;
  state: Extract<PlannerTaskState, "succeeded">;
  requestFingerprint?: string;
  sourceOutputs: PlannerSourceOutputs;
  outputFingerprints?: PlannerOutputFingerprints;
  traceId?: string;
  timestamp?: string;
  receivedAt: string;
  summary: PlannerResultSummary;
}

export interface PlannerRunState {
  status: PlannerTaskState;
  baseUrl: string;
  planId?: string;
  runToken?: string;
  requestFingerprint?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  runningDurationMs?: number;
  internalResult?: unknown;
  errorCode?: string | number;
  errorMessage?: string;
  traceId?: string;
  requestSummary?: PlannerRequestSummary;
  resultSummary?: PlannerResultSummary;
  resultSnapshot?: PlannerResultSnapshot;
}

export function resolvePlannerBaseUrl(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : PLANNER_SERVICE_DEFAULT_BASE_URL;
}

export function createIdlePlannerRunState(baseUrl?: string): PlannerRunState {
  return {
    status: "idle",
    baseUrl: resolvePlannerBaseUrl(baseUrl),
  };
}

export function normalizePlannerRunState(value?: Partial<PlannerRunState> | null): PlannerRunState {
  if (!value) {
    return createIdlePlannerRunState();
  }

  const resultSnapshot = normalizeResultSnapshot(value.resultSnapshot);

  return {
    status: isPlannerTaskState(value.status) ? value.status : "unknown",
    baseUrl: resolvePlannerBaseUrl(value.baseUrl),
    planId: nonEmptyString(value.planId),
    runToken: nonEmptyString(value.runToken),
    requestFingerprint: nonEmptyString(value.requestFingerprint),
    startedAt: nonEmptyString(value.startedAt),
    updatedAt: nonEmptyString(value.updatedAt),
    finishedAt: nonEmptyString(value.finishedAt),
    runningDurationMs: finiteOptionalNumber(value.runningDurationMs),
    internalResult: value.internalResult,
    errorCode: value.errorCode,
    errorMessage: nonEmptyString(value.errorMessage),
    traceId: nonEmptyString(value.traceId),
    requestSummary: normalizeRequestSummary(value.requestSummary),
    resultSummary: normalizeResultSummary(value.resultSummary ?? resultSnapshot?.summary),
    resultSnapshot,
  };
}

export function isTerminalPlannerState(state: PlannerTaskState): boolean {
  return ["succeeded", "failed", "cancelled", "no_running_plan", "not_found", "stale"].includes(state);
}

export function summarizePlannerRequest(request: PlannerStartRequest): PlannerRequestSummary {
  const sourceConfig = request.sendData.source_config;

  return {
    mode: request.sendData.mode,
    nodeCount: sourceConfig.cfg_parameter.cfg_parameter.node.length,
    linkCount: sourceConfig.topo_feature.length,
    flowCount: sourceConfig.flow_feature.length,
    streamIds: sourceConfig.flow_feature.map((flow) => flow.stream_id),
  };
}

export function summarizePlannerResult(sourceOutputs?: PlannerSourceOutputs, fingerprints?: PlannerOutputFingerprints): PlannerResultSummary {
  const solutionJson = sourceOutputs?.solution_json;
  const solutionEntries = Array.isArray(solutionJson) ? solutionJson : [];
  const gclEntryCount = solutionEntries.reduce((count, entry) => {
    if (!entry || typeof entry !== "object" || !Array.isArray((entry as { gcl_entries?: unknown }).gcl_entries)) {
      return count;
    }

    return count + (entry as { gcl_entries: unknown[] }).gcl_entries.length;
  }, 0);

  return {
    linkCount: solutionEntries.length,
    gclEntryCount,
    fingerprintFiles: Object.values(fingerprints ?? {})
      .map((fingerprint) => fingerprint?.file_name)
      .filter((fileName): fileName is string => Boolean(fileName)),
  };
}

function normalizeRequestSummary(value?: PlannerRequestSummary): PlannerRequestSummary | undefined {
  if (!value) {
    return undefined;
  }

  return {
    mode: value.mode === "time-trigger" ? value.mode : "time-trigger",
    nodeCount: finiteNonNegativeNumber(value.nodeCount),
    linkCount: finiteNonNegativeNumber(value.linkCount),
    flowCount: finiteNonNegativeNumber(value.flowCount),
    streamIds: Array.isArray(value.streamIds)
      ? value.streamIds.filter((streamId) => Number.isFinite(streamId))
      : [],
  };
}

function normalizeResultSummary(value?: PlannerResultSummary): PlannerResultSummary | undefined {
  if (!value) {
    return undefined;
  }

  return {
    linkCount: finiteNonNegativeNumber(value.linkCount),
    gclEntryCount: finiteNonNegativeNumber(value.gclEntryCount),
    fingerprintFiles: Array.isArray(value.fingerprintFiles)
      ? value.fingerprintFiles.filter((fileName): fileName is string => typeof fileName === "string")
      : [],
  };
}

function normalizeResultSnapshot(value?: PlannerResultSnapshot): PlannerResultSnapshot | undefined {
  if (!value?.planId || value.state !== "succeeded") {
    return undefined;
  }

  return {
    planId: value.planId,
    state: "succeeded",
    requestFingerprint: nonEmptyString(value.requestFingerprint),
    sourceOutputs: value.sourceOutputs ?? {},
    outputFingerprints: value.outputFingerprints,
    traceId: nonEmptyString(value.traceId),
    timestamp: nonEmptyString(value.timestamp),
    receivedAt: nonEmptyString(value.receivedAt) ?? new Date().toISOString(),
    summary: normalizeResultSummary(value.summary) ?? summarizePlannerResult(value.sourceOutputs, value.outputFingerprints),
  };
}

function isPlannerTaskState(value: unknown): value is PlannerTaskState {
  return typeof value === "string"
    && [
      "idle",
      "running",
      "succeeded",
      "failed",
      "busy",
      "cancel_requested",
      "cancelled",
      "no_running_plan",
      "not_found",
      "stale",
      "unknown",
    ].includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
