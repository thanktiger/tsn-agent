import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type AgentRunPhase = "idle" | "connecting" | "streaming" | "waiting";

const AGENT_STREAM_STALL_MS = 3000;

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
  useEffect(() => {
    const messagesContainer = scrollContainerRef.current;

    if (!messagesContainer) {
      return;
    }

    if (typeof messagesContainer.scrollTo === "function") {
      messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: isAgentRunning ? "smooth" : "auto",
      });
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
