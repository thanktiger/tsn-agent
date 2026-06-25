import { describe, expect, it } from "vitest";
import { buildFingerprint, computeToolsHash, sha256Hex } from "./fingerprint";

describe("fingerprint", () => {
  it("sha256Hex is stable and prefixed", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });

  it("computeToolsHash is order-independent", () => {
    expect(computeToolsHash(["a", "b", "c"])).toBe(computeToolsHash(["c", "a", "b"]));
    expect(computeToolsHash(["a", "b"])).not.toBe(computeToolsHash(["a", "b", "c"]));
  });

  it("buildFingerprint hashes content and passes through ids", () => {
    const fp = buildFingerprint({
      skillContent: "skill body",
      skeleton: "skeleton body",
      scenarioId: "aerospace-onboard",
      model: "claude-sonnet-4-6",
    });
    expect(fp.skillHash).toBe(sha256Hex("skill body"));
    expect(fp.skeletonVersion).toBe(sha256Hex("skeleton body"));
    expect(fp.scenarioId).toBe("aerospace-onboard");
    expect(fp.model).toBe("claude-sonnet-4-6");
  });

  it("different SKILL.md content yields different skillHash", () => {
    const a = buildFingerprint({ skillContent: "v1" });
    const b = buildFingerprint({ skillContent: "v2" });
    expect(a.skillHash).not.toBe(b.skillHash);
  });

  it("missing inputs become null, not a hash of empty", () => {
    const fp = buildFingerprint({});
    expect(fp.skillHash).toBeNull();
    expect(fp.skeletonVersion).toBeNull();
    expect(fp.scenarioId).toBeNull();
    expect(fp.model).toBeNull();
  });
});
