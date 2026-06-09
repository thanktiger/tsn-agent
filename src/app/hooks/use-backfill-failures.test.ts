import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeBackfillError, useBackfillFailures } from "./use-backfill-failures";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("useBackfillFailures", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("fetches failures on mount", async () => {
    invokeMock.mockResolvedValue([
      { sessionId: "s1", state: "failed_parse", errorCode: "PAYLOAD_NOT_JSON", attemptedAt: "@unix-1" },
    ]);

    const { result } = renderHook(() => useBackfillFailures());

    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith("list_backfill_failures");
    expect(result.current.failures[0].sessionId).toBe("s1");
  });

  it("refresh imperatively reloads after a retry", async () => {
    invokeMock.mockResolvedValueOnce([
      { sessionId: "s1", state: "failed_parse", errorCode: null, attemptedAt: "@unix-1" },
    ]);

    const { result } = renderHook(() => useBackfillFailures());
    await waitFor(() => expect(result.current.failures).toHaveLength(1));

    // retry 成功后失败行消失 → refresh 拉到空列表。
    invokeMock.mockResolvedValueOnce([]);
    await result.current.refresh();
    await waitFor(() => expect(result.current.failures).toHaveLength(0));
  });

  it("does not invoke outside the Tauri runtime", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    renderHook(() => useBackfillFailures());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("describeBackfillError", () => {
  it("maps known codes to readable text and passes unknown codes through", () => {
    expect(describeBackfillError("PAYLOAD_NOT_JSON")).toBe("原始数据不是合法 JSON");
    // canonical 迁移下线后 walker 只产生 PAYLOAD_NOT_JSON；其余码（含 WALKER_ERROR）走兜底透传。
    expect(describeBackfillError("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(describeBackfillError(null)).toBe("原因未知");
  });
});
