import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRunController } from "./use-agent-run-controller";

describe("useAgentRunController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in idle state with all flags false", () => {
    const { result } = renderHook(() => useAgentRunController());

    expect(result.current.isAgentRunning).toBe(false);
    expect(result.current.agentRunPhase).toBe("idle");
    expect(result.current.agentRunStartedAt).toBeUndefined();
    expect(result.current.agentRunElapsedSeconds).toBe(0);
    expect(result.current.lastAgentChunkAt).toBeUndefined();
    expect(result.current.pendingAssistantMessageId).toBeUndefined();
  });

  it("startRun transitions to running + connecting and sets startedAt", () => {
    const { result } = renderHook(() => useAgentRunController());

    act(() => {
      result.current.actions.startRun();
    });

    expect(result.current.isAgentRunning).toBe(true);
    expect(result.current.agentRunPhase).toBe("connecting");
    expect(result.current.agentRunStartedAt).toBeDefined();
    expect(result.current.agentRunElapsedSeconds).toBe(0);
  });

  it("markStreaming switches phase from connecting to streaming", () => {
    const { result } = renderHook(() => useAgentRunController());

    act(() => {
      result.current.actions.startRun();
      result.current.actions.markStreaming();
    });

    expect(result.current.agentRunPhase).toBe("streaming");
  });

  it("auto-transitions streaming → waiting after stall timeout (3s without chunk)", () => {
    const { result } = renderHook(() => useAgentRunController());

    act(() => {
      result.current.actions.startRun();
      result.current.actions.markStreaming();
    });

    expect(result.current.agentRunPhase).toBe("streaming");

    act(() => {
      vi.advanceTimersByTime(3001);
    });

    expect(result.current.agentRunPhase).toBe("waiting");
  });

  it("recordChunkAt resets the stall timer (does not flip to waiting if new chunk arrives)", () => {
    const { result } = renderHook(() => useAgentRunController());

    act(() => {
      result.current.actions.startRun();
      result.current.actions.markStreaming();
    });

    act(() => {
      vi.advanceTimersByTime(2000);
      result.current.actions.recordChunkAt(Date.now());
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.agentRunPhase).toBe("streaming");
  });

  it("elapsed timer ticks every second while running", async () => {
    const { result } = renderHook(() => useAgentRunController());

    act(() => {
      result.current.actions.startRun();
    });

    expect(result.current.agentRunElapsedSeconds).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(1100);
    });

    expect(result.current.agentRunElapsedSeconds).toBeGreaterThanOrEqual(1);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.agentRunElapsedSeconds).toBeGreaterThanOrEqual(3);
  });

  it("finishRun resets all state and stops the elapsed timer", () => {
    const { result } = renderHook(() => useAgentRunController());

    act(() => {
      result.current.actions.startRun();
      result.current.actions.markStreaming();
    });

    act(() => {
      result.current.actions.finishRun();
    });

    expect(result.current.isAgentRunning).toBe(false);
    expect(result.current.agentRunPhase).toBe("idle");
    expect(result.current.agentRunStartedAt).toBeUndefined();
    expect(result.current.agentRunElapsedSeconds).toBe(0);
    expect(result.current.lastAgentChunkAt).toBeUndefined();
    expect(result.current.pendingAssistantMessageId).toBeUndefined();
  });

  it("setPendingAssistantMessageId updates and clears the pending id", () => {
    const { result } = renderHook(() => useAgentRunController());

    act(() => {
      result.current.actions.setPendingAssistantMessageId("msg-123");
    });
    expect(result.current.pendingAssistantMessageId).toBe("msg-123");

    act(() => {
      result.current.actions.setPendingAssistantMessageId(undefined);
    });
    expect(result.current.pendingAssistantMessageId).toBeUndefined();
  });

  it("scrollContainerRef is a ref object for messages container", () => {
    const { result } = renderHook(() => useAgentRunController());
    expect(result.current.scrollContainerRef).toBeDefined();
    expect("current" in result.current.scrollContainerRef).toBe(true);
  });

  it("does not run timers when isAgentRunning is false", () => {
    const { result } = renderHook(() => useAgentRunController());

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(result.current.agentRunPhase).toBe("idle");
    expect(result.current.agentRunElapsedSeconds).toBe(0);
  });
});
