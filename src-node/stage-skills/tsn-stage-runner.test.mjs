import { describe, expect, it } from "vitest";
import { runCli } from "./tsn-stage-runner";

describe("tsn-stage-runner stub", () => {
  it("fails closed with an offline message", () => {
    expect(() => runCli()).toThrowError(/tsn-stage-runner 已下线/);
    expect(() => runCli()).toThrowError(/tsn_topology MCP 工具/);
  });
});
