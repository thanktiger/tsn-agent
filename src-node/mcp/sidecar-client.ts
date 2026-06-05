/**
 * Plan v3 U4b — Topology sidecar HTTP client used by MCP tool handlers.
 *
 * Reads sidecar URL + token from env (`TSN_AGENT_DB_RPC_URL` /
 * `TSN_AGENT_DB_RPC_TOKEN` / `TSN_AGENT_SESSION_ID`) injected by Tauri via
 * `run_claude_agent` → worker.mjs → `mcpServers.tsn_topology.env`.
 *
 * Forces IPv4 by relying on the literal `127.0.0.1` URL Tauri Rust binds to
 * (Spike C verified). Node 18+ fetch (undici) honours the literal address;
 * Windows IPv6-first only triggers when resolving `localhost`.
 *
 * Per Plan v3 KTD: NO in-process fallback. Sidecar unreachable → tool returns
 * a structured failResult so Agent SDK surfaces the error to caller.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SidecarEnv {
  url: string;
  token: string;
  sessionId: string;
}

/** Read sidecar env once at MCP server startup. Missing values → throw. */
export function readSidecarEnv(): SidecarEnv {
  const url = process.env.TSN_AGENT_DB_RPC_URL;
  const token = process.env.TSN_AGENT_DB_RPC_TOKEN;
  const sessionId = process.env.TSN_AGENT_SESSION_ID;
  const missing: string[] = [];
  if (!url) missing.push("TSN_AGENT_DB_RPC_URL");
  if (!token) missing.push("TSN_AGENT_DB_RPC_TOKEN");
  if (!sessionId) missing.push("TSN_AGENT_SESSION_ID");
  if (missing.length > 0) {
    throw new Error(`tsn_topology MCP 服务无法启动：缺少必需环境变量 ${missing.join(", ")}`);
  }
  return { url: url!, token: token!, sessionId: sessionId! };
}

export interface FetchSidecarOptions {
  /** Defaults to 15s (per Plan v3 R10 single-call timeout safety net). */
  abortMs?: number;
  /** Override env-derived sidecar coordinates (test injection). */
  env?: SidecarEnv;
}

export interface SidecarSuccess<T = unknown> {
  ok: true;
  status: number;
  body: T;
}

export interface SidecarFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  retryable: boolean;
}

export type SidecarResult<T = unknown> = SidecarSuccess<T> | SidecarFailure;

/**
 * Perform a JSON RPC call to the topology sidecar. Auto-injects:
 *   - Authorization: Bearer <token>
 *   - sessionId at top of body (sidecar enforces ops whitelist using it)
 *
 * Network errors / non-2xx return a structured `SidecarFailure` instead of
 * throwing, so MCP handlers can wrap with `failResult` consistently.
 */
export async function fetchSidecar<T = unknown>(
  route: string,
  body: Record<string, unknown> = {},
  options: FetchSidecarOptions = {},
): Promise<SidecarResult<T>> {
  const env = options.env ?? readSidecarEnv();
  const abortMs = options.abortMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${env.url}${route.startsWith("/") ? route : `/${route}`}`;
  const payload = JSON.stringify({ sessionId: env.sessionId, ...body });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), abortMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.token}`,
      },
      body: payload,
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      let parsed: { code?: string; message?: string; retryable?: boolean } = {};
      try {
        parsed = text ? (JSON.parse(text) as typeof parsed) : {};
      } catch {
        // ignore parse error; fall back to status text
      }
      return {
        ok: false,
        status: response.status,
        code: parsed.code ?? `HTTP_${response.status}`,
        message: parsed.message ?? response.statusText,
        retryable: parsed.retryable ?? response.status >= 500,
      };
    }

    let parsedBody: T;
    try {
      parsedBody = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
    } catch {
      return {
        ok: false,
        status: response.status,
        code: "INVALID_SIDECAR_RESPONSE",
        message: "sidecar response was not valid JSON",
        retryable: false,
      };
    }

    return { ok: true, status: response.status, body: parsedBody };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: 0,
      code: aborted ? "SIDECAR_TIMEOUT" : "SIDECAR_UNREACHABLE",
      message,
      retryable: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}
