import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_STORAGE_LIMIT,
  buildToolSummary,
  enrichToolCall,
  toFriendlyToolName,
  truncateResultForStorage,
  type RawToolCall,
} from "./tool-call-record";

function rawToolCall(overrides: Partial<RawToolCall> = {}): RawToolCall {
  return {
    id: "tool-1",
    name: "Bash",
    status: "success",
    args: { command: "ls -la" },
    result: { stdout: "file-a\nfile-b" },
    ...overrides,
  };
}

describe("toFriendlyToolName", () => {
  it("去掉 mcp 前缀并把工具段首个下划线换成点", () => {
    expect(toFriendlyToolName("mcp__tsn_topology__topology_initialize")).toBe("topology.initialize");
  });

  it("只替换工具段的第一个下划线", () => {
    expect(toFriendlyToolName("mcp__tsn_topology__topology_apply_operations")).toBe(
      "topology.apply_operations",
    );
  });

  it("非 MCP 工具原样返回", () => {
    expect(toFriendlyToolName("Bash")).toBe("Bash");
    expect(toFriendlyToolName("Read")).toBe("Read");
    expect(toFriendlyToolName("Skill")).toBe("Skill");
  });

  it("空名给安全兜底", () => {
    expect(toFriendlyToolName("")).toBe("工具");
  });
});

describe("buildToolSummary", () => {
  it("Bash：从 command 抽出摘要", () => {
    expect(buildToolSummary(rawToolCall({ args: { command: "npm test" } }))).toBe("npm test");
  });

  it("Read：从 file_path 抽出摘要", () => {
    expect(
      buildToolSummary(rawToolCall({ name: "Read", args: { file_path: "src/app/App.tsx" } })),
    ).toBe("src/app/App.tsx");
  });

  it("topology：args 无显著字符串时回退到标量字段", () => {
    const summary = buildToolSummary(
      rawToolCall({
        name: "mcp__tsn_topology__topology_initialize",
        args: { switchCount: 4, endSystemCount: 5 },
        result: { ok: true },
      }),
    );
    expect(summary).toContain("switchCount=4");
  });

  it("失败状态给失败前缀摘要", () => {
    const summary = buildToolSummary(
      rawToolCall({ status: "error", args: {}, result: { error: "boom" } }),
    );
    expect(summary).toBe("失败：boom");
  });

  it("无可探测字段时给已完成兜底", () => {
    expect(buildToolSummary(rawToolCall({ args: {}, result: {} }))).toBe("已完成");
  });
});

describe("truncateResultForStorage", () => {
  it("小结果原样返回、不标记截断", () => {
    const result = { stdout: "ok" };
    expect(truncateResultForStorage(result)).toEqual({ value: result, truncated: false });
  });

  it("超上限大结果返回字符串预览并标记截断", () => {
    const big = { table: "x".repeat(TOOL_RESULT_STORAGE_LIMIT + 100) };
    const out = truncateResultForStorage(big);
    expect(out.truncated).toBe(true);
    expect(typeof out.value).toBe("string");
    expect((out.value as string).length).toBeLessThanOrEqual(TOOL_RESULT_STORAGE_LIMIT + 1);
  });

  it("undefined 结果原样、不截断", () => {
    expect(truncateResultForStorage(undefined)).toEqual({ value: undefined, truncated: false });
  });
});

describe("enrichToolCall", () => {
  it("success 记录补 friendlyName + summary 且保留完整 result", () => {
    const record = enrichToolCall(
      rawToolCall({ name: "mcp__tsn_topology__topology_initialize", args: { template: "line" } }),
    );
    expect(record.friendlyName).toBe("topology.initialize");
    expect(record.summary).toBe("line");
    expect(record.result).toEqual({ stdout: "file-a\nfile-b" });
  });

  it("error 记录保留 error 状态", () => {
    const record = enrichToolCall(rawToolCall({ status: "error" }));
    expect(record.status).toBe("error");
  });
});
