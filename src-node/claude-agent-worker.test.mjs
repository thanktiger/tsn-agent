import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  extractOperationTraceEvents,
  extractStreamEventText,
  normalizeError,
  parseAssistantText,
  redactSecrets,
  runClaude,
} from "./claude-agent-worker.mjs";
import { runTopologyStage, writeStageResult } from "./stage-skills/tsn-stage-runner";

async function* messages(items) {
  for (const item of items) {
    yield item;
  }
}

describe("claude-agent-worker", () => {
  it("maps structured output and session id from SDK messages", async () => {
    const query = async function* (input) {
      expect(input.options.settingSources).toEqual(["user", "project"]);
      expect(input.options.skills).toEqual(["tsn-topology", "tsn-flow-planning"]);
      expect(input.options.tools).toEqual({ type: "preset", preset: "claude_code" });
      expect(input.options.allowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
      expect(input.options.disallowedTools).toEqual([]);
      expect(input.options.includePartialMessages).toBe(true);
      expect(input.options.systemPrompt).toContain("工程状态只接受结构化校验结果");
      expect(input.options.systemPrompt).toContain("拓扑、时间同步、流量规划、模拟仿真");
      expect(input.options.systemPrompt).toContain("不能声称已启动仿真");
      expect(input.prompt).toContain("TSN_AGENT_STAGE_RESULT_PATH");
      expect(input.prompt).toContain("建议传给 stage runner 的结构化输入");
      expect(input.prompt).toContain('"scenarioConfigId": "generic-tsn"');
      yield* messages([
        { type: "system", session_id: "session-1" },
        { type: "result", structured_output: { assistantText: " 已生成拓扑说明 " } },
      ]);
    };

    const result = await runClaude(
      "我需要4个交换机",
      {
        cwd: "/tmp/project",
        stageRunnerInput: {
          userIntent: "我需要4个交换机",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
        stageRunner: async ({ input, resultPath }) => {
          await writeStageResult(runTopologyStage(input), resultPath);
        },
      },
      query,
    );

    expect(result.sessionId).toBe("session-1");
    expect(result.assistantText).toContain("[Skill] 调用 tsn-topology");
    expect(result.assistantText).toContain("[工具] Bash: node tsn-stage-runner --stage topology --result-path stage-result.json");
    expect(result.assistantText).toContain("[文件] 写入阶段结果 stage-result.json");
    expect(result.assistantText).toContain("[文件] 读取阶段结果 stage-result.json");
    expect(result.assistantText).toContain("[Skill] tsn-topology 结果已返回");
    expect(result.assistantText).toContain("已生成拓扑说明");
    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0].payload.project.topology.nodes).toHaveLength(24);
  });

  it("reads and validates a topology stage result written to the run-scoped path", async () => {
    const query = async function* (input) {
      const resultPath = input.options.env.TSN_AGENT_STAGE_RESULT_PATH;
      expect(resultPath).toContain("tsn-agent-stage-");
      await writeFile(
        resultPath,
        JSON.stringify(runTopologyStage({ userIntent: "我需要4个交换机，每个交换机连接5个端系统" })),
        "utf8",
      );
      yield { type: "result", session_id: "session-stage", result: "拓扑已生成" };
    };

    const result = await runClaude("我需要4个交换机，每个交换机连接5个端系统", undefined, query);

    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]).toMatchObject({
      stage: "topology",
      skillName: "tsn-topology",
      validation: { ok: true, errors: [] },
    });
    expect(result.stageResults[0].payload.project.topology.nodes).toHaveLength(24);
  });

  it("runs the topology stage locally when the model does not write a structured result", async () => {
    const events = [];
    const query = async function* (input) {
      expect(input.prompt).toContain('"stage": "topology"');
      yield { type: "result", session_id: "session-local-runner", result: "拓扑已生成" };
    };

    const result = await runClaude(
      "拓扑采用双冗余系统交换结构，交换机数量：2 台系统交换机，每台连接 24 个端系统接口节点。",
      {
        stageRunnerInput: {
          userIntent: "拓扑采用双冗余系统交换结构，交换机数量：2 台系统交换机，每台连接 24 个端系统接口节点。",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
        stageRunner: async ({ input, resultPath }) => {
          await writeStageResult(runTopologyStage(input), resultPath);
        },
        onEvent: (event) => events.push(event),
      },
      query,
    );

    const streamed = events.map((event) => event.text ?? "").join("");
    expect(streamed).toContain("[Skill] 调用 tsn-topology");
    expect(streamed).toContain("[工具] Bash: node tsn-stage-runner --stage topology");
    expect(streamed).toContain("[文件] 写入阶段结果 stage-result.json");
    expect(result.assistantText).toContain("[Skill] 调用 tsn-topology");
    expect(result.assistantText).toContain("[文件] 读取阶段结果 stage-result.json");
    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]).toMatchObject({
      stage: "topology",
      skillName: "tsn-topology",
      status: "success",
    });
    expect(result.stageResults[0].payload.project.topology.nodes).toHaveLength(50);
  });

  it("surfaces SDK tool use and tool result events in the final assistant text", async () => {
    const events = [];
    const query = async function* () {
      yield { type: "system", session_id: "session-tool-trace" };
      yield {
        type: "assistant",
        session_id: "session-tool-trace",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "Bash",
              input: {
                command:
                  'node "$TSN_AGENT_STAGE_RUNNER_PATH" --stage flow-template --input \'{"userIntent":"加三条视频流"}\' --result-path "$TSN_AGENT_STAGE_RESULT_PATH"',
              },
            },
          ],
        },
      };
      yield {
        type: "user",
        session_id: "session-tool-trace",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-1",
              content: "ok",
            },
          ],
        },
      };
      yield { type: "result", session_id: "session-tool-trace", result: "已更新流量规划" };
    };

    const result = await runClaude("加三条视频流", { onEvent: (event) => events.push(event) }, query);

    const streamed = events.map((event) => event.text ?? "").join("");
    expect(streamed).toContain("[工具] Bash: node tsn-stage-runner --stage flow-template");
    expect(streamed).toContain("[工具结果] Bash 已返回");
    expect(result.assistantText).toContain("[工具] Bash: node tsn-stage-runner --stage flow-template");
    expect(result.assistantText).toContain("[工具结果] Bash 已返回");
    expect(result.assistantText).toContain("已更新流量规划");
  });

  it("recovers a topology stage result when the SDK stops at the turn limit", async () => {
    const query = async function* (input) {
      expect(input.options.maxTurns).toBe(3);
      yield { type: "system", session_id: "session-turn-limit" };
      throw new Error("Bash returned an error result: Reached maximum number of turns (3)");
    };

    const result = await runClaude(
      "我需要4个交换机，每个交换机连接5个端系统",
      {
        stageRunnerInput: {
          userIntent: "我需要4个交换机，每个交换机连接5个端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
        stageRunner: async ({ input, resultPath }) => {
          await writeStageResult(runTopologyStage(input), resultPath);
        },
      },
      query,
    );

    expect(result).toMatchObject({
      assistantText: expect.stringContaining("已根据本轮需求生成拓扑草案"),
      sessionId: "session-turn-limit",
    });
    expect(result.assistantText).not.toContain("Bash returned an error");
    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]).toMatchObject({
      stage: "topology",
      skillName: "tsn-topology",
      status: "success",
    });
    expect(result.stageResults[0].payload.project.topology.nodes).toHaveLength(24);
  });

  it("recovers a flow planning stage result when the SDK stops at the turn limit", async () => {
    const query = async function* () {
      yield { type: "system", session_id: "session-flow-turn-limit" };
      throw new Error("Bash returned an error result: Reached maximum number of turns (3)");
    };

    const project = runTopologyStage({
      userIntent: "我需要3个交换机，每个交换机连接3个端系统，使用环形互联",
    }).payload.project;

    const result = await runClaude(
      "再加3条视频流吧",
      {
        stageRunnerInput: {
          userIntent: "再加3条视频流吧",
          stage: "flow-template",
          scenarioConfigId: "generic-tsn",
          project,
        },
        stageRunner: async ({ input, resultPath }) => {
          const { runFlowPlanningStage } = await import("./stage-skills/tsn-stage-runner");
          await writeStageResult(runFlowPlanningStage(input), resultPath);
        },
      },
      query,
    );

    expect(result).toMatchObject({
      assistantText: expect.stringContaining("已根据本轮需求更新流量规划"),
      sessionId: "session-flow-turn-limit",
    });
    expect(result.assistantText).toContain("确认流量规划后生成仿真输入");
    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]).toMatchObject({
      stage: "flow-template",
      skillName: "tsn-flow-planning",
      status: "success",
    });
    expect(result.stageResults[0].payload.project.flows.map((flow) => flow.name)).toEqual([
      "控制流-1",
      "视频流-1",
      "视频流-2",
      "视频流-3",
    ]);
  });

  it("ignores malformed stage result files", async () => {
    const query = async function* (input) {
      await writeFile(input.options.env.TSN_AGENT_STAGE_RESULT_PATH, "{bad json", "utf8");
      yield { type: "result", result: "只返回文本" };
    };

    const result = await runClaude("需求", undefined, query);

    expect(result.assistantText).toBe("只返回文本");
    expect(result.stageResults).toEqual([]);
  });

  it("passes resume session and conversation context to Claude", async () => {
    const query = async function* (input) {
      expect(input.options.resume).toBe("session-old");
      expect(input.prompt).toContain("上一轮已生成拓扑");
      yield { type: "result", session_id: "session-old", result: "继续配置时钟同步" };
    };

    await expect(
      runClaude("继续", { resumeSessionId: "session-old", conversationContext: "上一轮已生成拓扑" }, query),
    ).resolves.toMatchObject({
      assistantText: "继续配置时钟同步",
      sessionId: "session-old",
      stageResults: [],
    });
  });

  it("emits streaming chunks from partial messages", async () => {
    const events = [];
    const query = async function* () {
      yield { type: "system", session_id: "session-stream" };
      yield {
        type: "stream_event",
        session_id: "session-stream",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "第一段" } },
      };
      yield {
        type: "stream_event",
        session_id: "session-stream",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "第二段" } },
      };
      yield { type: "result", session_id: "session-stream", result: "" };
    };

    const result = await runClaude("需求", { onEvent: (event) => events.push(event) }, query);

    expect(result.assistantText).toBe("第一段第二段");
    expect(result.stageResults).toEqual([]);
    expect(events).toEqual([
      { event: "session", sessionId: "session-stream" },
      { event: "chunk", text: "第一段" },
      { event: "chunk", text: "第二段" },
    ]);
  });

  it("falls back to JSON string result text", async () => {
    const query = async function* () {
      yield { type: "result", session_id: "session-2", result: '{"assistantText":"JSON 字符串回复"}' };
    };

    await expect(runClaude("需求", undefined, query)).resolves.toEqual({
      assistantText: "JSON 字符串回复",
      sessionId: "session-2",
      stageResults: [],
    });
  });

  it("falls back to plain result text", async () => {
    const query = async function* () {
      yield { type: "result", result: "普通回复" };
    };

    await expect(runClaude("需求", undefined, query)).resolves.toMatchObject({
      assistantText: "普通回复",
    });
  });

  it("rejects empty assistant output", async () => {
    const query = async function* () {
      yield { type: "result", structured_output: { assistantText: "   " } };
    };

    await expect(runClaude("需求", undefined, query)).rejects.toThrow("no assistantText");
  });

  it("builds a TSN-specific prompt", () => {
    const prompt = buildPrompt(
      "我需要4个交换机",
      "历史上下文",
      "/tmp/result.json",
      { userIntent: "我需要4个交换机", scenarioConfigId: "generic-tsn" },
    );

    expect(prompt).toContain("我需要4个交换机");
    expect(prompt).toContain("历史上下文");
    expect(prompt).toContain("建议传给 stage runner 的结构化输入");
    expect(prompt).toContain('"scenarioConfigId": "generic-tsn"');
    expect(prompt).toContain("只描述当前阶段已经完成或正在等待确认的内容");
    expect(prompt).toContain("拓扑 -> 时间同步 -> 流量规划 -> 模拟仿真");
    expect(prompt).toContain("当前应用没有接入 OMNeT++/远程服务器仿真 runner");
    expect(prompt).toContain("/tmp/result.json");
    expect(prompt).not.toContain("然后继续生成控制流模板和导出文件");
  });

  it("redacts common secret shapes", () => {
    const redacted = redactSecrets(
      'api_key=sk-ant-secret token: abc123 "refreshToken":"oauth-secret" Authorization: Bearer bearer-secret',
    );

    expect(redacted).not.toContain("sk-ant-secret");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("oauth-secret");
    expect(redacted).not.toContain("bearer-secret");
    expect(redacted).toContain("[redacted]");
  });

  it("normalizes thrown errors with redaction", () => {
    expect(normalizeError(new Error("CLAUDE_API_KEY=secret"))).not.toContain("secret");
  });

  it("parses assistantText from JSON result strings", () => {
    expect(parseAssistantText('{"assistantText":"ok"}')).toBe("ok");
    expect(parseAssistantText("plain")).toBe("plain");
  });

  it("extracts text deltas from stream events", () => {
    expect(
      extractStreamEventText({
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "delta" } },
      }),
    ).toEqual(["delta"]);
    expect(extractStreamEventText({ event: { type: "message_stop" } })).toEqual([]);
  });

  it("extracts file operation traces from SDK tool blocks", () => {
    const traces = extractOperationTraceEvents({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/app/App.tsx" } },
          { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/tmp/stage-result.json" } },
          { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "src/agent/fake-agent.ts" } },
        ],
      },
    });

    expect(traces.map((trace) => trace.text)).toEqual([
      "[文件] 读取 src/app/App.tsx",
      "[文件] 写入 stage-result.json",
      "[文件] 修改 src/agent/fake-agent.ts",
    ]);
  });
});
