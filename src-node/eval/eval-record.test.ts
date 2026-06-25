import { describe, expect, it } from "vitest";
import {
  type BuildEvalRecordInput,
  buildEvalRecord,
  EVAL_RECORD_SCHEMA_VERSION,
  serializeEvalRecordLine,
} from "./eval-record";

function baseInput(overrides: Partial<BuildEvalRecordInput> = {}): BuildEvalRecordInput {
  return {
    runId: "run-1",
    appSessionId: "session-1",
    claudeSessionId: "claude-1",
    stage: "topology",
    scenarioConfigId: "aerospace-onboard",
    model: "claude-sonnet-4-6",
    createdAt: "2026-06-25T00:00:00.000Z",
    durationMs: 1234,
    fingerprint: {
      skillHash: "sha256:skill",
      skeletonVersion: "sha256:skeleton",
      scenarioId: "aerospace-onboard",
      model: "claude-sonnet-4-6",
    },
    system: "完整 system prompt",
    toolsHash: "sha256:tools",
    inputMessages: [{ role: "user", content: [{ type: "text", text: "双平面双跳冗余" }] }],
    outputMessages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先初始化" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "topology_initialize",
            input: { templateId: "x" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' }],
      },
    ],
    finalText: "已生成 8 节点",
    label: { ok: true, caliber: "structural_only", errors: [] },
    ...overrides,
  };
}

describe("eval-record", () => {
  it("builds a complete record and round-trips through JSONL serialization", () => {
    const record = buildEvalRecord(baseInput());
    const line = serializeEvalRecordLine(record);

    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1); // 单行：仅末尾一个换行

    const parsed = JSON.parse(line);
    expect(parsed).toEqual(record);
    expect(parsed.schemaVersion).toBe(EVAL_RECORD_SCHEMA_VERSION);
    expect(parsed.input.lossyHistory).toBe(true);
    expect(parsed.output.messages[0].content[1].type).toBe("tool_use");
    expect(parsed.output.messages[1].content[0].type).toBe("tool_result");
  });

  it("sets label to null for non-topology runs", () => {
    const record = buildEvalRecord(baseInput({ stage: "time-sync", label: null }));
    expect(record.label).toBeNull();
  });

  it("preserves secrets verbatim (raw contract — no redaction in eval path)", () => {
    const secret = "sk-ant-abc123SECRET";
    const record = buildEvalRecord(
      baseInput({
        system: `key=${secret}`,
        outputMessages: [{ role: "assistant", content: [{ type: "text", text: secret }] }],
      }),
    );
    const line = serializeEvalRecordLine(record);
    expect(line).toContain(secret); // 不脱敏
  });

  it("defaults optional fields to null without throwing", () => {
    const record = buildEvalRecord({
      createdAt: "2026-06-25T00:00:00.000Z",
      fingerprint: { skillHash: null, skeletonVersion: null, scenarioId: null, model: null },
      system: "",
      inputMessages: [],
      outputMessages: [],
    });
    expect(record.runId).toBeNull();
    expect(record.sessionId).toBeNull();
    expect(record.durationMs).toBeNull();
    expect(record.label).toBeNull();
    expect(record.output.finalText).toBe("");
  });
});
