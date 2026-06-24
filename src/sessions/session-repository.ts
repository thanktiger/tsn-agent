import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, TopologyVerifyResult } from "../agent/agent-types";
import { type ToolCallRecord, truncateResultForStorage } from "../agent/tool-call-record";
import { normalizePlannerRunState, type PlannerRunState } from "../planner/planner-contract";
import { normalizeWorkflowState, type WorkflowState } from "../project/project-state";

const STORAGE_KEY = "tsn-agent.sessions.v0";
const CURRENT_SESSION_KEY = "tsn-agent.current-session.v0";
const MAX_RECENT_SESSIONS = 12;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** Plan 2026-06-09-003：本条 assistant 消息的工具调用记录，渲染成卡片。老消息无此字段。 */
  toolCalls?: ToolCallRecord[];
  /** 拓扑阶段确认过关闸的结构验证结论；未通过时本条消息区分渲染（拦截卡 + 口径标签）。 */
  verification?: TopologyVerifyResult;
}

/**
 * Plan v3 Phase B-β：session 不再内嵌 canonical project / artifact bundle。
 * 拓扑权威在 SQLite P0 表（topology_nodes / topology_links），payload 只记录
 * 最近一次 sidecar 写入的 topologyMutationId，UI 通过 `query_topology` 拉数据。
 */
export interface TsnSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  claudeSessionId?: string;
  agentEvents: AgentEvent[];
  workflow: WorkflowState;
  plannerRun?: PlannerRunState;
  topologyMutationId?: number;
}

export interface SessionRepository {
  list(): Promise<TsnSession[]>;
  getCurrent(): Promise<TsnSession | undefined>;
  ensureCurrentSession(): Promise<TsnSession>;
  save(session: TsnSession): Promise<void>;
  setCurrent(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  duplicate(sessionId: string): Promise<TsnSession | undefined>;
}

export interface SessionDatabase {
  list(): Promise<StoredSession[]>;
  getCurrent(): Promise<StoredSession | undefined>;
  save(session: StoredSession): Promise<void>;
  setCurrent(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  eventCount: number;
  /** Rust sessions 表既有列；Phase B-β 后表示「已有 sidecar 拓扑写入」。 */
  hasProject: boolean;
  projectName?: string;
  /** Rust sessions 表既有列；bundle 已删除，固定写 0。 */
  bundleFileCount: number;
  payload: string;
}

export class BrowserSessionRepository implements SessionRepository {
  constructor(private readonly storage: Storage) {}

  async list(): Promise<TsnSession[]> {
    return this.readSessions();
  }

  async getCurrent(): Promise<TsnSession | undefined> {
    const sessions = this.readSessions();
    const currentId = this.storage.getItem(CURRENT_SESSION_KEY);

    return sessions.find((session) => session.id === currentId) ?? sessions[0];
  }

  async ensureCurrentSession(): Promise<TsnSession> {
    const current = await this.getCurrent();

    if (current) {
      return current;
    }

    const session = createEmptySession();
    await this.save(session);
    return session;
  }

  async save(session: TsnSession): Promise<void> {
    const sessions = this.readSessions().filter((candidate) => candidate.id !== session.id);
    this.writeSessions(
      [redactSessionForStorage(session), ...sessions].slice(0, MAX_RECENT_SESSIONS),
    );
    this.storage.setItem(CURRENT_SESSION_KEY, session.id);
  }

  async setCurrent(sessionId: string): Promise<void> {
    const exists = this.readSessions().some((session) => session.id === sessionId);

    if (exists) {
      this.storage.setItem(CURRENT_SESSION_KEY, sessionId);
    }
  }

  async remove(sessionId: string): Promise<void> {
    const sessions = this.readSessions().filter((session) => session.id !== sessionId);
    this.writeSessions(sessions);

    if (this.storage.getItem(CURRENT_SESSION_KEY) === sessionId) {
      const nextSession = sessions[0];

      if (nextSession) {
        this.storage.setItem(CURRENT_SESSION_KEY, nextSession.id);
      } else {
        this.storage.removeItem(CURRENT_SESSION_KEY);
      }
    }
  }

  async duplicate(sessionId: string): Promise<TsnSession | undefined> {
    const original = this.readSessions().find((session) => session.id === sessionId);

    if (!original) {
      return undefined;
    }

    const copy = copySession(original);
    await this.save(copy);
    return copy;
  }

  private readSessions(): TsnSession[] {
    const raw = this.storage.getItem(STORAGE_KEY);

    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as TsnSession[];
      return sortSessions(parsed.map(normalizeSession)).slice(0, MAX_RECENT_SESSIONS);
    } catch {
      return [];
    }
  }

  private writeSessions(sessions: TsnSession[]): void {
    this.storage.setItem(
      STORAGE_KEY,
      JSON.stringify(sortSessions(sessions).slice(0, MAX_RECENT_SESSIONS)),
    );
  }
}

export class SqliteSessionRepository implements SessionRepository {
  private readonly database: Promise<SessionDatabase>;

  constructor(database: Promise<SessionDatabase>) {
    this.database = database;
  }

  async list(): Promise<TsnSession[]> {
    const database = await this.getDatabase();
    const rows = await database.list();
    return rows.map(storedSessionToSession).filter(isSession);
  }

  async getCurrent(): Promise<TsnSession | undefined> {
    const database = await this.getDatabase();
    return storedSessionToSession(await database.getCurrent());
  }

  async ensureCurrentSession(): Promise<TsnSession> {
    const current = await this.getCurrent();

    if (current) {
      return current;
    }

    const session = createEmptySession();
    await this.save(session);
    return session;
  }

  async save(session: TsnSession): Promise<void> {
    const database = await this.getDatabase();
    const storedSession = redactSessionForStorage(session);

    await database.save(sessionToStoredSession(storedSession));
  }

  async setCurrent(sessionId: string): Promise<void> {
    const database = await this.getDatabase();
    await database.setCurrent(sessionId);
  }

  async remove(sessionId: string): Promise<void> {
    const database = await this.getDatabase();
    await database.remove(sessionId);
  }

  async duplicate(sessionId: string): Promise<TsnSession | undefined> {
    const original = (await this.list()).find((session) => session.id === sessionId);

    if (!original) {
      return undefined;
    }

    const copy = copySession(original);
    await this.save(copy);
    return copy;
  }

  private getDatabase(): Promise<SessionDatabase> {
    return this.database;
  }
}

export function createSessionRepository(): SessionRepository {
  if (isTauriRuntime()) {
    return new SqliteSessionRepository(Promise.resolve(new TauriSessionDatabase()));
  }

  if (typeof window !== "undefined" && window.localStorage) {
    return new BrowserSessionRepository(window.localStorage);
  }

  return new BrowserSessionRepository(createMemoryStorage());
}

export function createEmptySession(): TsnSession {
  const now = new Date().toISOString();
  return {
    id: createId("session"),
    title: "新的 TSN 规划",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: createId("message"),
        role: "assistant",
        createdAt: now,
        content: "告诉我你想搭建的 TSN 网络规模，我会按步骤给出拓扑、时间同步和流量规划。",
      },
    ],
    agentEvents: [],
    workflow: normalizeWorkflowState(),
    plannerRun: normalizePlannerRunState(),
  };
}

export function createId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  return `${prefix}-${random}`;
}

export function redactSessionForStorage(session: TsnSession): TsnSession {
  return {
    ...session,
    title: redactSecrets(session.title),
    messages: session.messages.map((message) => ({
      ...message,
      content: redactSecrets(message.content),
      ...(message.toolCalls
        ? { toolCalls: dropRunningToolCalls(message.toolCalls).map(redactToolCallForStorage) }
        : {}),
    })),
    agentEvents: session.agentEvents.map((event) => ({
      ...event,
      content: redactSecrets(event.content),
    })),
    workflow: normalizeWorkflowState(session.workflow),
    plannerRun: normalizePlannerRunState(session.plannerRun),
  };
}

function copySession(original: TsnSession): TsnSession {
  const now = new Date().toISOString();
  return {
    ...original,
    id: createId("session"),
    title: `${original.title} 副本`,
    createdAt: now,
    updatedAt: now,
    claudeSessionId: undefined,
  };
}

function storedSessionToSession(session: StoredSession | undefined): TsnSession | undefined {
  if (!session) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(session.payload) as Partial<TsnSession>;
    // DB 列兜底：导入切片的 payload 是 '{}'（导出规格不带对话），核心字段从
    // sessions 列恢复，缺它们会让列表渲染 `.messages.at(-1)` 直接崩。
    // 合法 payload 含全部字段，spread 覆盖兜底 → 行为零变化。
    // 例外：id 以行 PK 为权威——子表与查询全按行 id 挂；导入换 id 重试场景
    // payload 可能内嵌旧 id，被它覆盖会导致列表重复 id（双高亮）。
    return normalizeSession({
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: [],
      ...parsed,
      id: session.id,
    } as TsnSession);
  } catch {
    return undefined;
  }
}

function normalizeSession(session: TsnSession): TsnSession {
  return {
    ...session,
    agentEvents: session.agentEvents ?? [],
    workflow: normalizeWorkflowState(session.workflow),
    plannerRun: normalizePlannerRunState(session.plannerRun),
    topologyMutationId:
      typeof session.topologyMutationId === "number" ? session.topologyMutationId : undefined,
  };
}

function isSession(session: TsnSession | undefined): session is TsnSession {
  return Boolean(session);
}

function sortSessions(sessions: TsnSession[]): TsnSession[] {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(sk-ant-[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(
      /((?:api[_-]?key|token|secret|password|claude_api_key)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /("(?:accessToken|refreshToken|authToken|apiKey|api_key|token|secret|password)"\s*:\s*")([^"]+)(")/gi,
      "$1[redacted]$3",
    )
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s,;]+)/gi, "$1[redacted]");
}

/**
 * Plan 2026-06-10-001 U4 backstop：`running` 是流式 UI 瞬态，done 对账覆盖后理论上
 * 不可能到达落库——一旦触发说明对账链路有 bug，过滤并 console.error 暴露（不静默）。
 */
function dropRunningToolCalls(toolCalls: ToolCallRecord[]): ToolCallRecord[] {
  const running = toolCalls.filter((record) => record.status === "running");
  if (running.length > 0) {
    console.error(
      `[session-repository] ${running.length} 条 running 态工具记录到达落库路径（应已被 done 对账覆盖），已过滤。ids=${running.map((record) => record.id).join(",")}`,
    );
  }
  return toolCalls.filter((record) => record.status !== "running");
}

/**
 * Plan 2026-06-09-003 KTD3/KTD7：落盘前给工具记录的 result 截断兜底，再整条红 action。
 * redactSecrets 只吃 string，且对整段序列化 JSON 跑正则会越界破坏结构 —— 故递归到
 * 字符串叶子逐个红 action（与既有 redactProviderNamesInValue 同款）。
 */
function redactToolCallForStorage(record: ToolCallRecord): ToolCallRecord {
  const { value, truncated } = truncateResultForStorage(record.result);
  return redactSecretsInValue({
    ...record,
    result: value,
    resultTruncated: truncated,
  }) as ToolCallRecord;
}

/**
 * Plan 2026-06-10-001 U3：导出给 adapter 在流式工具事件到达时先脱敏再入内存态
 * （R8：redact-on-arrival，与落库同一机制）。
 */
export function redactSecretsInValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactSecretsInValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        redactSecrets(key),
        redactSecretsInValue(inner),
      ]),
    );
  }

  return value;
}

function sessionToStoredSession(session: TsnSession): StoredSession {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    eventCount: session.agentEvents.length,
    hasProject: typeof session.topologyMutationId === "number",
    projectName: undefined,
    bundleFileCount: 0,
    payload: JSON.stringify(session),
  };
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

class TauriSessionDatabase implements SessionDatabase {
  async list(): Promise<StoredSession[]> {
    return invoke<StoredSession[]>("list_sessions");
  }

  async getCurrent(): Promise<StoredSession | undefined> {
    const session = await invoke<StoredSession | null>("get_current_session");
    return session ?? undefined;
  }

  async save(session: StoredSession): Promise<void> {
    await invoke("save_session", {
      request: {
        session,
      },
    });
  }

  async setCurrent(sessionId: string): Promise<void> {
    await invoke("set_current_session", {
      request: {
        sessionId,
      },
    });
  }

  async remove(sessionId: string): Promise<void> {
    await invoke("remove_session", {
      request: {
        sessionId,
      },
    });
  }
}
