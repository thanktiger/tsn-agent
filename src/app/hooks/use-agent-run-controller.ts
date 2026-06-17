import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type AgentRunPhase = "idle" | "connecting" | "streaming" | "waiting";

const AGENT_STREAM_STALL_MS = 3000;
// 距底部 ≤ 该像素值即视为「停在底部」，仍跟随自动滚动；超过则视为用户主动上滚，释放粘底。
const STICK_TO_BOTTOM_THRESHOLD_PX = 64;

export interface UseAgentRunControllerOptions {
  /** Reactive dependencies for the auto-scroll effect — usually currentSession.id + currentSession.messages */
  scrollDeps?: unknown[];
}

export interface AgentRunActions {
  startRun: () => void;
  markConnecting: () => void;
  markStreaming: () => void;
  markWaiting: () => void;
  recordChunkAt: (timestamp: number) => void;
  setPendingAssistantMessageId: (id: string | undefined) => void;
  finishRun: () => void;
}

export interface UseAgentRunControllerReturn {
  isAgentRunning: boolean;
  agentRunPhase: AgentRunPhase;
  agentRunStartedAt: number | undefined;
  agentRunElapsedSeconds: number;
  lastAgentChunkAt: number | undefined;
  pendingAssistantMessageId: string | undefined;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  actions: AgentRunActions;
}

/**
 * Owns the agent run state machine: phase transitions, elapsed timer, stall
 * detection, and chat auto-scroll.
 *
 * Does NOT own the orchestration of submitIntent (which lives in App.tsx and
 * coordinates session persistence, planner run, export state). Instead exposes
 * `actions` so submitIntent can drive phase transitions explicitly.
 *
 * State ownership per plan D1: pendingAssistantMessageId lives here (ChatPane
 * reads it via prop in U6), persistSession + currentSession come from
 * useSessionRepository (U1).
 */
export function useAgentRunController(
  options: UseAgentRunControllerOptions = {},
): UseAgentRunControllerReturn {
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [agentRunPhase, setAgentRunPhase] = useState<AgentRunPhase>("idle");
  const [agentRunStartedAt, setAgentRunStartedAt] = useState<number | undefined>();
  const [agentRunElapsedSeconds, setAgentRunElapsedSeconds] = useState(0);
  const [lastAgentChunkAt, setLastAgentChunkAt] = useState<number | undefined>();
  const [pendingAssistantMessageId, setPendingAssistantMessageId] = useState<string | undefined>();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // 用户是否「粘」在底部：流式输出时若用户上滚阅读，释放粘底、不再强行拉到底；
  // 用户滚回底部、提交新需求或切换会话时重新粘上。
  const stickToBottomRef = useRef(true);
  const lastScrollSessionRef = useRef<unknown>(undefined);

  useEffect(() => {
    if (!isAgentRunning || agentRunPhase !== "streaming") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAgentRunPhase((phase) => (phase === "streaming" ? "waiting" : phase));
    }, AGENT_STREAM_STALL_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [agentRunPhase, isAgentRunning, lastAgentChunkAt]);

  useEffect(() => {
    if (!isAgentRunning || agentRunStartedAt === undefined) {
      return;
    }

    const updateElapsedSeconds = () => {
      setAgentRunElapsedSeconds(Math.max(0, Math.floor((Date.now() - agentRunStartedAt) / 1000)));
    };

    updateElapsedSeconds();
    const intervalId = window.setInterval(updateElapsedSeconds, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [agentRunStartedAt, isAgentRunning]);

  const scrollDepsRef = options.scrollDeps ?? [];

  // 监听用户滚动，实时更新「是否粘底」。挂在 scrollDeps 上重挂载，既能在真机首挂载时拿到
  // 已就绪的容器，也便于测试在设置 ref 后重新挂载。即时滚动（auto）落点恰在底部 → 距离≈0 →
  // 仍判为粘底；用户上滚 → 距离变大 → 释放粘底（即使在流式输出过程中也能正确释放）。
  useEffect(() => {
    const messagesContainer = scrollContainerRef.current;
    if (!messagesContainer) {
      return;
    }

    const updateStick = () => {
      const distanceFromBottom =
        messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
      stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
    };

    messagesContainer.addEventListener("scroll", updateStick, { passive: true });
    return () => messagesContainer.removeEventListener("scroll", updateStick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...scrollDepsRef]);

  useEffect(() => {
    const messagesContainer = scrollContainerRef.current;

    if (!messagesContainer) {
      return;
    }

    // 切换会话 / 初次加载（scrollDeps[0] 约定为会话 id）：强制回到底部看最新消息。
    const sessionDep = scrollDepsRef[0];
    if (sessionDep !== lastScrollSessionRef.current) {
      lastScrollSessionRef.current = sessionDep;
      stickToBottomRef.current = true;
    }

    // 用户已上滚阅读（释放粘底）→ 尊重其位置，本轮不自动滚动。
    if (!stickToBottomRef.current) {
      return;
    }

    // 一律即时滚动（不用 smooth）：smooth 动画期间的中间 scroll 事件会把粘底误判为释放，
    // 导致流式输出时用户根本无法上滚。
    if (typeof messagesContainer.scrollTo === "function") {
      messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: "auto" });
    } else {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    // scrollDepsRef is the consumer's reactive trigger list; isAgentRunning is
    // appended so a finished run still scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...scrollDepsRef, isAgentRunning]);

  const startRun = useCallback(() => {
    setIsAgentRunning(true);
    setAgentRunPhase("connecting");
    setAgentRunStartedAt(Date.now());
    setAgentRunElapsedSeconds(0);
    setLastAgentChunkAt(undefined);
    // 提交新需求即回到底部，跟随本轮输出（即便上一轮用户曾上滚释放过粘底）。
    stickToBottomRef.current = true;
  }, []);

  const markConnecting = useCallback(() => setAgentRunPhase("connecting"), []);
  const markStreaming = useCallback(() => setAgentRunPhase("streaming"), []);
  const markWaiting = useCallback(() => setAgentRunPhase("waiting"), []);
  const recordChunkAt = useCallback((timestamp: number) => setLastAgentChunkAt(timestamp), []);

  const finishRun = useCallback(() => {
    setPendingAssistantMessageId(undefined);
    setAgentRunPhase("idle");
    setAgentRunStartedAt(undefined);
    setAgentRunElapsedSeconds(0);
    setLastAgentChunkAt(undefined);
    setIsAgentRunning(false);
  }, []);

  return {
    isAgentRunning,
    agentRunPhase,
    agentRunStartedAt,
    agentRunElapsedSeconds,
    lastAgentChunkAt,
    pendingAssistantMessageId,
    scrollContainerRef,
    actions: {
      startRun,
      markConnecting,
      markStreaming,
      markWaiting,
      recordChunkAt,
      setPendingAssistantMessageId,
      finishRun,
    },
  };
}
