import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ToolCallRecord } from "../../agent/tool-call-record";
import { logDiagnostic, sessionSummary } from "../../diagnostics/app-diagnostics";
import {
  createDiagnosticLogRepository,
  type DiagnosticLogRepository,
} from "../../diagnostics/diagnostic-log-repository";
import {
  createEmptySession,
  createSessionRepository,
  type SessionRepository,
  type TsnSession,
} from "../../sessions/session-repository";

export interface UseSessionRepositoryOptions {
  repository?: SessionRepository;
  diagnostics?: DiagnosticLogRepository;
}

export interface PersistSessionOptions {
  logCategory?: "session" | "agent" | "artifact";
  logMessage?: string;
  logDetails?: Record<string, unknown>;
}

export interface UseSessionRepositoryReturn {
  sessions: TsnSession[];
  currentSession: TsnSession;
  setCurrentSession: Dispatch<SetStateAction<TsnSession>>;
  isHydrating: boolean;
  /** Underlying repository — exposed for low-level reads (find by id, raw save) in App.tsx submitIntent flow. */
  repository: SessionRepository;
  persistSession: (next: TsnSession, options?: PersistSessionOptions) => Promise<void>;
  /**
   * Like persistSession but only updates currentSession when its id still
   * matches the incoming session. Use for async results (agent run final,
   * planner attach) where the user may have switched sessions during the
   * operation.
   */
  persistSessionIfCurrent: (next: TsnSession, options?: PersistSessionOptions) => Promise<void>;
  sessionExists: (sessionId: string) => Promise<boolean>;
  /**
   * 本次进程内被删除过的 session id 墓碑。删除后内存里可能仍残留指向该 session 的
   * 指针（in-flight submitIntent 的 contextSession、确认按钮闭包等）；提交前用它拦掉
   * UPSERT 回写复活。墓碑只记「删过」，故能区分「新会话本就不在库」（合法）与「已删」。
   */
  isSessionDeleted: (sessionId: string) => boolean;
  updateAssistantMessage: (sessionId: string, messageId: string, content: string) => void;
  /**
   * Plan 2026-06-10-001 U4：流式工具卡片纯内存更新（不写库）——run 期间按 id
   * upsert 后整组替换该 assistant 消息的 toolCalls；done 对账由既有落库路径覆盖。
   */
  updateAssistantToolCalls: (
    sessionId: string,
    messageId: string,
    toolCalls: ToolCallRecord[],
  ) => void;
  reloadSessionsList: () => Promise<void>;
  handleNewSession: () => Promise<TsnSession>;
  handleSelectSession: (session: TsnSession) => Promise<void>;
  handleDeleteSession: () => Promise<TsnSession>;
  diagnostics: DiagnosticLogRepository;
}

const defaultRepository = createSessionRepository();
const defaultDiagnostics = createDiagnosticLogRepository();

export function useSessionRepository(
  options: UseSessionRepositoryOptions = {},
): UseSessionRepositoryReturn {
  const repository = options.repository ?? defaultRepository;
  const diagnostics = options.diagnostics ?? defaultDiagnostics;
  const initialSession = useMemo(() => createEmptySession(), []);
  const [sessions, setSessions] = useState<TsnSession[]>([initialSession]);
  const [currentSession, setCurrentSession] = useState<TsnSession>(initialSession);
  const [isHydrating, setIsHydrating] = useState(true);
  const initialSessionRef = useRef(initialSession);
  const deletedSessionIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function loadSessionState() {
      try {
        const session = await repository.ensureCurrentSession();
        const recentSessions = await repository.list();

        if (!cancelled) {
          setCurrentSession(session);
          setSessions(recentSessions.length > 0 ? recentSessions : [session]);
        }
      } catch {
        if (!cancelled) {
          setCurrentSession(initialSessionRef.current);
          setSessions([initialSessionRef.current]);
        }
      } finally {
        if (!cancelled) {
          setIsHydrating(false);
        }
      }
    }

    void loadSessionState();

    return () => {
      cancelled = true;
    };
  }, [repository]);

  const reloadSessionsList = useCallback(async () => {
    setSessions(await repository.list());
  }, [repository]);

  const persistSession = useCallback(
    async (next: TsnSession, persistOptions: PersistSessionOptions = {}) => {
      await repository.save(next);
      logDiagnostic(diagnostics, {
        sessionId: next.id,
        category: persistOptions.logCategory ?? "session",
        message: persistOptions.logMessage ?? "会话已保存",
        details: persistOptions.logDetails ?? sessionSummary(next),
      });
      setCurrentSession(next);
      setSessions(await repository.list());
    },
    [repository, diagnostics],
  );

  const persistSessionIfCurrent = useCallback(
    async (next: TsnSession, persistOptions: PersistSessionOptions = {}) => {
      await repository.save(next);
      logDiagnostic(diagnostics, {
        sessionId: next.id,
        category: persistOptions.logCategory ?? "session",
        message: persistOptions.logMessage ?? "会话已保存",
        details: persistOptions.logDetails ?? sessionSummary(next),
      });
      setCurrentSession((session) => (session.id === next.id ? next : session));
      setSessions(await repository.list());
    },
    [repository, diagnostics],
  );

  const sessionExists = useCallback(
    async (sessionId: string) => {
      return (await repository.list()).some((session) => session.id === sessionId);
    },
    [repository],
  );

  const isSessionDeleted = useCallback((sessionId: string) => {
    return deletedSessionIds.current.has(sessionId);
  }, []);

  const updateAssistantMessage = useCallback(
    (sessionId: string, messageId: string, content: string) => {
      setCurrentSession((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        return {
          ...session,
          messages: session.messages.map((message) =>
            message.id === messageId ? { ...message, content } : message,
          ),
        };
      });
    },
    [],
  );

  const updateAssistantToolCalls = useCallback(
    (sessionId: string, messageId: string, toolCalls: ToolCallRecord[]) => {
      setCurrentSession((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        return {
          ...session,
          messages: session.messages.map((message) =>
            message.id === messageId ? { ...message, toolCalls } : message,
          ),
        };
      });
    },
    [],
  );

  const handleNewSession = useCallback(async (): Promise<TsnSession> => {
    const session = createEmptySession();
    await persistSession(session, {
      logMessage: "新建会话",
      logDetails: sessionSummary(session),
    });
    return session;
  }, [persistSession]);

  const handleSelectSession = useCallback(
    async (session: TsnSession) => {
      await repository.setCurrent(session.id);
      logDiagnostic(diagnostics, {
        sessionId: session.id,
        category: "session",
        message: "切换到会话",
        details: sessionSummary(session),
      });
      setCurrentSession(session);
    },
    [repository, diagnostics],
  );

  const handleDeleteSession = useCallback(async (): Promise<TsnSession> => {
    const deletedSessionId = currentSession.id;
    deletedSessionIds.current.add(deletedSessionId);
    await repository.remove(deletedSessionId);
    await diagnostics.clearSession(deletedSessionId);
    const nextSession = await repository.ensureCurrentSession();
    logDiagnostic(diagnostics, {
      sessionId: nextSession.id,
      category: "session",
      message: "删除会话并切换",
      details: {
        deletedSessionId,
        nextSessionId: nextSession.id,
      },
    });
    setCurrentSession(nextSession);
    setSessions(await repository.list());
    return nextSession;
  }, [currentSession.id, repository, diagnostics]);

  return {
    sessions,
    currentSession,
    setCurrentSession,
    isHydrating,
    repository,
    persistSession,
    persistSessionIfCurrent,
    sessionExists,
    isSessionDeleted,
    updateAssistantMessage,
    updateAssistantToolCalls,
    reloadSessionsList,
    handleNewSession,
    handleSelectSession,
    handleDeleteSession,
    diagnostics,
  };
}
