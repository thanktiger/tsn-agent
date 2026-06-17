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

  it("auto-scrolls while stuck to bottom but yields to a user scroll-up, then re-sticks on submit", () => {
    // 可控的假滚动容器：scrollHeight/clientHeight 固定，scrollTop 可读写，scrollTo 落点写回 scrollTop。
    const el = document.createElement("div");
    let scrollTopVal = 700; // 700 + 300(clientHeight) = 1000(scrollHeight) → 距底 0，粘底
    Object.defineProperty(el, "scrollHeight", { get: () => 1000 });
    Object.defineProperty(el, "clientHeight", { get: () => 300 });
    Object.defineProperty(el, "scrollTop", { get: () => scrollTopVal, set: (v: number) => { scrollTopVal = v; } });
    const scrollToSpy = vi.fn((opts: { top: number }) => { scrollTopVal = opts.top; });
    (el as unknown as { scrollTo: typeof scrollToSpy }).scrollTo = scrollToSpy;

    const { result, rerender } = renderHook(
      ({ deps }: { deps: unknown[] }) => useAgentRunController({ scrollDeps: deps }),
      { initialProps: { deps: ["s1", 0] as unknown[] } },
    );
    act(() => { result.current.scrollContainerRef.current = el; });

    // 新消息到达且用户在底部 → 自动滚到底。
    rerender({ deps: ["s1", 1] });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });

    // 用户上滚阅读 → 释放粘底。
    scrollTopVal = 0;
    act(() => { el.dispatchEvent(new Event("scroll")); });

    // 流式继续来新内容 → 尊重用户位置，不再自动滚。
    scrollToSpy.mockClear();
    rerender({ deps: ["s1", 2] });
    expect(scrollToSpy).not.toHaveBeenCalled();

    // 用户提交新需求（startRun）→ 重新粘底，下一轮内容滚到底。
    scrollToSpy.mockClear();
    act(() => { result.current.actions.startRun(); });
    rerender({ deps: ["s1", 3] });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });

  it("re-sticks to bottom when the session id changes", () => {
    const el = document.createElement("div");
    let scrollTopVal = 0; // 距底 700 → 释放粘底
    Object.defineProperty(el, "scrollHeight", { get: () => 1000 });
    Object.defineProperty(el, "clientHeight", { get: () => 300 });
    Object.defineProperty(el, "scrollTop", { get: () => scrollTopVal, set: (v: number) => { scrollTopVal = v; } });
    const scrollToSpy = vi.fn((opts: { top: number }) => { scrollTopVal = opts.top; });
    (el as unknown as { scrollTo: typeof scrollToSpy }).scrollTo = scrollToSpy;

    const { result, rerender } = renderHook(
      ({ deps }: { deps: unknown[] }) => useAgentRunController({ scrollDeps: deps }),
      { initialProps: { deps: ["s1", 0] as unknown[] } },
    );
    act(() => { result.current.scrollContainerRef.current = el; });

    // 在 s1 里用户上滚释放粘底。
    rerender({ deps: ["s1", 1] });
    act(() => { el.dispatchEvent(new Event("scroll")); });
    scrollToSpy.mockClear();

    // 切换到 s2 → 会话 id 变化，强制回到底部。
    rerender({ deps: ["s2", 0] });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
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
