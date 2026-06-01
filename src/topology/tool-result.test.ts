import { describe, expect, it } from "vitest";
import { failResult, forbiddenFullResponseError, okResult, topologyError } from "./tool-result";

describe("topology tool result envelope", () => {
  it("omits full payload in summary mode", () => {
    const result = okResult({
      summary: { nodeCount: 1 },
      full: { secretPortTable: [] },
      responseMode: "summary",
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual({
      responseMode: "summary",
      summaryOnly: true,
    });
    expect(result).not.toHaveProperty("full.secretPortTable");
  });

  it("returns full payload only in full mode", () => {
    const result = okResult({
      summary: { nodeCount: 1 },
      full: { topology: { nodes: [] } },
      responseMode: "full",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.full).toEqual({ topology: { nodes: [] } });
    }
  });

  it("keeps structured error fields stable", () => {
    const result = failResult({
      errors: [
        topologyError({
          code: "INVALID",
          message: "invalid input",
          path: "$.x",
          requiresUserClarification: true,
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toEqual({
        code: "INVALID",
        message: "invalid input",
        path: "$.x",
        severity: "error",
        details: {},
        retryable: false,
        requiresUserClarification: true,
      });
    }
  });

  it("provides a dedicated full-mode forbidden error", () => {
    expect(forbiddenFullResponseError()).toMatchObject({
      code: "FORBIDDEN_RESPONSE_MODE",
      path: "$.responseMode",
      retryable: false,
    });
  });
});
