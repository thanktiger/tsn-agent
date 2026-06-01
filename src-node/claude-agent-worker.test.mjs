import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  buildPrompt,
  TOPOLOGY_MCP_ALLOWED_TOOLS,
  extractTopologyWorkflowStageResults,
  extractOperationTraceEvents,
  extractStreamEventText,
  normalizeError,
  parseAssistantText,
  redactSecrets,
  runClaude,
} from "./claude-agent-worker.mjs";
import { TOPOLOGY_MCP_ALLOWED_TOOLS as REGISTRY_TOPOLOGY_MCP_ALLOWED_TOOLS } from "./mcp/topology-tools";
import { runTopologyStage, writeStageResult } from "./stage-skills/tsn-stage-runner";
import { initializeTopology } from "../src/topology/initialize";

function failedTopologyStageResult(error) {
  const result = runTopologyStage({ userIntent: "我需要4个交换机，每个交换机连接5个端系统" });
  return {
    ...result,
    status: "failed",
    validation: {
      ok: false,
      errors: [error],
    },
    safeEventSummary: {
      title: "拓扑结果",
      content: `拓扑校验失败：${error}`,
      status: "error",
    },
  };
}

function dualPlaneParams(endSystemsPerSwitch) {
  return {
    planes: [{ id: "A" }, { id: "B" }],
    switches: [
      { id: "sw1", name: "SW-1", plane: "A", groupId: "g1" },
      { id: "sw2", name: "SW-2", plane: "B", groupId: "g1" },
      { id: "sw3", name: "SW-3", plane: "A", groupId: "g2" },
      { id: "sw4", name: "SW-4", plane: "B", groupId: "g2" },
    ],
    switchGroups: [
      { id: "g1", planeSwitches: { A: "sw1", B: "sw2" } },
      { id: "g2", planeSwitches: { A: "sw3", B: "sw4" } },
    ],
    endSystems: Array.from({ length: 4 * endSystemsPerSwitch }, (_, index) => {
      const switchOrdinal = Math.floor(index / endSystemsPerSwitch) + 1;
      const hostOrdinal = index % endSystemsPerSwitch + 1;
      const groupOrdinal = Math.ceil(switchOrdinal / 2);
      const primarySwitch = groupOrdinal === 1 ? "sw1" : "sw3";
      const backupSwitch = groupOrdinal === 1 ? "sw2" : "sw4";
      return {
        id: `es${switchOrdinal}-${hostOrdinal}`,
        name: `ES-${switchOrdinal}-${hostOrdinal}`,
        groupId: `g${groupOrdinal}`,
        attachment: {
          primary: { switchId: primarySwitch, plane: "A" },
          backup: { switchId: backupSwitch, plane: "B" },
        },
      };
    }),
    backbone: { mode: "line", withinPlane: true },
    crossPlaneLinks: { mode: "none" },
    dataRateMbps: 1000,
  };
}

async function* messages(items) {
  for (const item of items) {
    yield item;
  }
}

describe("claude-agent-worker", () => {
  it("keeps worker MCP allowedTools aligned with the topology registry", () => {
    expect(TOPOLOGY_MCP_ALLOWED_TOOLS).toEqual(REGISTRY_TOPOLOGY_MCP_ALLOWED_TOOLS);
  });

  it("maps structured output and session id from SDK messages", async () => {
    const mcpHostDir = await mkdtemp(join(tmpdir(), "tsn-topology-mcp-host-"));
    const topologyMcpServerPath = join(mcpHostDir, "tsn-topology-server.mjs");
    await writeFile(topologyMcpServerPath, "", "utf8");

    const query = async function* (input) {
      expect(input.options.allowedTools).toEqual([
        "Skill",
        "Read",
        ...TOPOLOGY_MCP_ALLOWED_TOOLS,
      ]);
      expect(input.options.settingSources).toEqual(["user", "project"]);
      expect(input.options.skills).toEqual(["tsn-topology", "tsn-flow-planning"]);
      expect(input.options.tools).toEqual({ type: "preset", preset: "claude_code" });
      expect(input.options.allowedTools).toEqual([
        "Skill",
        "Read",
        ...TOPOLOGY_MCP_ALLOWED_TOOLS,
      ]);
      expect(input.options.mcpServers.tsn_topology).toMatchObject({
        type: "stdio",
        command: process.execPath,
        alwaysLoad: true,
      });
      expect(input.options.mcpServers.tsn_topology.args[0]).toContain("tsn-topology-server.mjs");
      expect(input.options.disallowedTools).toEqual([]);
      expect(input.options.maxTurns).toBe(20);
      expect(input.options.includePartialMessages).toBe(true);
      expect(input.options.systemPrompt).toContain("工程状态只接受结构化校验结果");
      expect(input.options.systemPrompt).toContain("tsn_topology MCP 工具");
      expect(input.options.systemPrompt).toContain("拓扑、时间同步、流量规划、模拟仿真");
      expect(input.options.systemPrompt).toContain("不能声称已启动仿真");
      expect(input.prompt).toContain("TSN_AGENT_SKILL_OUTPUT_DIR");
      expect(input.prompt).toContain("tsn_topology MCP 工具");
      expect(input.prompt).not.toContain("--stage topology");
      expect(input.prompt).toContain("不要写 TSN_AGENT_STAGE_RESULT_PATH");
      expect(input.prompt).not.toContain("必须写入 TSN_AGENT_STAGE_RESULT_PATH");
      expect(input.options.env.TSN_AGENT_SKILL_OUTPUT_DIR).toContain("skill-output");
      yield* messages([
        { type: "system", session_id: "session-1" },
        { type: "result", structured_output: { assistantText: " 已生成拓扑说明 " } },
      ]);
    };

    const result = await runClaude(
      "我需要4个交换机",
      {
        cwd: "/tmp/project",
        topologyMcpServerPath,
        stageRunnerInput: {
          userIntent: "我需要4个交换机",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
      },
      query,
    );

    expect(result.sessionId).toBe("session-1");
    expect(result.assistantText).toContain("已生成拓扑说明");
    expect(result.stageResults).toEqual([]);
  });

  it("extracts topology workflow stage results from full MCP tool_result blocks", () => {
    const toolUseNamesById = new Map([
      ["toolu-init", "mcp__tsn_topology__topology_initialize"],
    ]);
    const toolResult = initializeTopology({
      templateId: "dual-plane-redundant",
      params: dualPlaneParams(2),
      responseMode: "full",
    });
    expect(toolResult.ok).toBe(true);

    const extracted = extractTopologyWorkflowStageResults({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-init",
            content: [
              {
                type: "text",
                text: JSON.stringify(toolResult),
              },
            ],
          },
        ],
      },
    }, toolUseNamesById, { stage: "topology" });

    expect(extracted).toHaveLength(1);
    expect(extracted[0].result).toMatchObject({
      schemaVersion: "tsn-agent.workflow-stage-result.v1",
      stage: "topology",
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.initialize",
      },
      status: "success",
    });
    expect(extracted[0].result.payload.project.topology.nodes.filter((node) => node.type === "switch")).toHaveLength(4);
    expect(extracted[0].result.payload.project.topology.nodes.filter((node) => node.type === "endSystem")).toHaveLength(8);
  });

  it("reads and validates a topology stage result written to the run-scoped path", async () => {
    const events = [];
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

    const result = await runClaude("我需要4个交换机，每个交换机连接5个端系统", { onEvent: (event) => events.push(event) }, query);

    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]).toMatchObject({
      stage: "topology",
      skillName: "tsn-topology",
      validation: { ok: true, errors: [] },
    });
    expect(result.stageResults[0].payload.project.topology.nodes).toHaveLength(24);
    expect(events.map((event) => event.text ?? "").join("")).toContain(
      "[Skill] tsn-topology 结果已返回：4 个交换机，20 个端系统，23 条链路",
    );
  });

  it("fails closed by omitting MCP server config when topology host cannot be resolved", async () => {
    const query = async function* (input) {
      expect(input.options.allowedTools).not.toContain("mcp__tsn_topology__topology_initialize");
      expect(input.options.mcpServers).toBeUndefined();
      yield { type: "result", session_id: "session-no-mcp-host", result: "拓扑工具暂不可用，已回退本地 runner 路径" };
    };

    const result = await runClaude(
      "我需要4个交换机",
      {
        cwd: "/tmp/project-without-mcp-host",
      },
      query,
    );

    expect(result.assistantText).toContain("回退本地 runner 路径");
  });

  it("does not run a topology runner repair turn when no trusted topology result is returned", async () => {
    const events = [];
    const auditDir = await mkdtemp(join(tmpdir(), "tsn-agent-repair-audit-test-"));
    let callCount = 0;
    const query = async function* (input) {
      callCount += 1;
      expect(input.prompt).toContain("stage-runner-input.json");
      expect(input.options.env.TSN_AGENT_STAGE_RUNNER_INPUT_PATH).toContain("stage-runner-input.json");
      yield { type: "system", session_id: "session-no-topology-result" };
      yield { type: "result", session_id: "session-no-topology-result", result: "拓扑已生成" };
    };

    const result = await runClaude(
      "我需要4个交换机，每个交换机连接5个端系统",
      {
        stageRunnerInput: {
          userIntent: "我需要4个交换机，每个交换机连接5个端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
        auditDir,
        appSessionId: "session-repair",
        runId: "agent-run-repair",
        onEvent: (event) => events.push(event),
      },
      query,
    );

    const streamed = events.map((event) => event.text ?? "").join("");
    const audit = JSON.parse(await readFile(result.auditPath, "utf8"));
    expect(callCount).toBe(1);
    expect(streamed).not.toContain("tsn-stage-runner --stage topology");
    expect(result.assistantText).toContain("拓扑已生成");
    expect(result.stageResults).toEqual([]);
    expect(audit.stageRunnerInputPath).toContain("stage-runner-input.json");
    expect(audit.promptRuns).toEqual([
      expect.objectContaining({
        id: "initial",
        kind: "initial",
        resultText: "拓扑已生成",
      }),
    ]);
  });

  it("does not repair invalid topology stage result files through the topology runner", async () => {
    let callCount = 0;
    const validationError = "通用分布式拓扑缺少交换机互联链路";
    const query = async function* (input) {
      callCount += 1;
      await writeFile(
        input.options.env.TSN_AGENT_STAGE_RESULT_PATH,
        JSON.stringify(failedTopologyStageResult(validationError)),
        "utf8",
      );
      yield { type: "system", session_id: "session-invalid-runner" };
      yield { type: "result", session_id: "session-invalid-runner", result: "拓扑已生成" };
    };

    const result = await runClaude(
      "我需要4个交换机，每个交换机连接5个端系统",
      {
        stageRunnerInput: {
          userIntent: "我需要4个交换机，每个交换机连接5个端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
      },
      query,
    );

    expect(callCount).toBe(1);
    expect(result.assistantText).toContain("拓扑已生成");
    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0].status).toBe("failed");
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

  it("writes a per-session audit log with prompt, result, and tool traces", async () => {
    const auditDir = await mkdtemp(join(tmpdir(), "tsn-agent-audit-test-"));
    const query = async function* (input) {
      yield { type: "system", session_id: "sdk-session-audit" };
      yield {
        type: "assistant",
        session_id: "sdk-session-audit",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-audit",
              name: "mcp__tsn_topology__topology_describe_templates",
              input: {
                responseMode: "summary",
              },
            },
          ],
        },
      };
      yield {
        type: "user",
        session_id: "sdk-session-audit",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-audit",
              content: JSON.stringify({
                ok: true,
                summary: {
                  templates: [],
                },
                warnings: [],
                metadata: {
                  responseMode: "summary",
                  summaryOnly: true,
                },
              }),
            },
          ],
        },
      };
      yield { type: "result", session_id: "sdk-session-audit", result: "拓扑已生成" };
    };

    const result = await runClaude(
      "我需要4个交换机",
      {
        auditDir,
        appSessionId: "session/audit:1",
        runId: "agent-run-audit",
        stageRunnerInput: {
          userIntent: "我需要4个交换机",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
      },
      query,
    );
    const auditRaw = await readFile(result.auditPath, "utf8");
    const audit = JSON.parse(auditRaw);
    const latestRaw = await readFile(join(auditDir, "session_audit_1", "latest.json"), "utf8");

    expect(result.auditPath).toContain("session_audit_1");
    expect(audit.schemaVersion).toBe("tsn-agent.agent-run-audit.v1");
    expect(audit.appSessionId).toBe("session/audit:1");
    expect(audit.runId).toBe("agent-run-audit");
    expect(audit.summary).toMatchObject({
      status: "success",
      stage: "topology",
      userPromptPreview: "我需要4个交换机",
      stageRunnerInputPath: expect.stringContaining("stage-runner-input.json"),
      promptRunCount: 1,
      recovered: false,
    });
    expect(audit.summary.prompt).toMatchObject({
      usesStageRunnerInputPath: true,
      hasInlineStageRunnerInputJson: false,
    });
    expect(audit.summary.context.includesLocalCandidate).toBe(false);
    expect(audit.prompt).toContain("用户原始需求：");
    expect(audit.prompt).toContain("我需要4个交换机");
    expect(audit.promptRuns).toEqual([
      expect.objectContaining({
        id: "initial",
        kind: "initial",
        promptSummary: expect.objectContaining({
          usesStageRunnerInputPath: true,
          hasInlineStageRunnerInputJson: false,
        }),
        prompt: expect.stringContaining("我需要4个交换机"),
        resultText: expect.stringContaining("拓扑已生成"),
      }),
    ]);
    expect(audit.sdkOptions.allowedTools).toEqual([
      "Skill",
      "Read",
      ...TOPOLOGY_MCP_ALLOWED_TOOLS,
    ]);
    expect(audit.sdkOptions.skills).toEqual(["tsn-topology", "tsn-flow-planning"]);
    expect(audit.toolCalls.map((call) => call.text).join("\n")).toContain("[工具] mcp__tsn_topology__topology_describe_templates");
    expect(audit.toolCalls.map((call) => call.text).join("\n")).toContain("[工具结果] mcp__tsn_topology__topology_describe_templates 已返回");
    expect(audit.result.assistantText).toContain("拓扑已生成");
    expect(audit.sdkSessionId).toBe("sdk-session-audit");
    expect(JSON.parse(latestRaw).runId).toBe("agent-run-audit");
    expect(JSON.parse(latestRaw).summary.stageRunnerInputPath).toContain("stage-runner-input.json");
  });

  it("does not synthesize a topology stage result when the SDK stops at the turn limit", async () => {
    const query = async function* (input) {
      expect(input.options.maxTurns).toBe(3);
      yield { type: "system", session_id: "session-turn-limit" };
      throw new Error("Bash returned an error result: Reached maximum number of turns (3)");
    };
    const stageRunner = vi.fn(async ({ input, resultPath }) => {
      await writeStageResult(runTopologyStage(input), resultPath);
    });

    await expect(runClaude(
      "我需要4个交换机，每个交换机连接5个端系统",
      {
        maxTurns: 3,
        stageRunnerInput: {
          userIntent: "我需要4个交换机，每个交换机连接5个端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
        stageRunner,
      },
      query,
    )).rejects.toThrow("Reached maximum number of turns");
    expect(stageRunner).not.toHaveBeenCalled();
  });

  it("does not synthesize a flow planning stage result when the SDK stops at the turn limit", async () => {
    const query = async function* () {
      yield { type: "system", session_id: "session-flow-turn-limit" };
      throw new Error("Bash returned an error result: Reached maximum number of turns (3)");
    };

    const project = runTopologyStage({
      userIntent: "我需要3个交换机，每个交换机连接3个端系统，使用环形互联",
    }).payload.project;
    const stageRunner = vi.fn(async ({ input, resultPath }) => {
      const { runFlowPlanningStage } = await import("./stage-skills/tsn-stage-runner");
      await writeStageResult(runFlowPlanningStage(input), resultPath);
    });

    await expect(runClaude(
      "再加3条视频流吧",
      {
        stageRunnerInput: {
          userIntent: "再加3条视频流吧",
          stage: "flow-template",
          scenarioConfigId: "generic-tsn",
          project,
        },
        stageRunner,
      },
      query,
    )).rejects.toThrow("Reached maximum number of turns");
    expect(stageRunner).not.toHaveBeenCalled();
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
      "/tmp/skill-output",
      { userIntent: "我需要4个交换机", stage: "topology", scenarioConfigId: "generic-tsn" },
    );

    expect(prompt).toContain("我需要4个交换机");
    expect(prompt).toContain("历史上下文");
    expect(prompt).toContain("阶段结构化输入");
    expect(prompt).toContain('"scenarioConfigId": "generic-tsn"');
    expect(prompt).toContain("只描述当前阶段已经完成或正在等待确认的内容");
    expect(prompt).toContain("拓扑 -> 时间同步 -> 流量规划 -> 模拟仿真");
    expect(prompt).toContain("当前应用没有接入 OMNeT++/远程服务器仿真 runner");
    expect(prompt).not.toContain("/tmp/result.json");
    expect(prompt).toContain("/tmp/skill-output");
    expect(prompt).toContain("tsn_topology MCP 工具");
    expect(prompt).toContain("trusted topology result");
    expect(prompt).not.toContain("--stage topology");
    expect(prompt).not.toContain("然后继续生成控制流模板和导出文件");
  });

  it("keeps large stage runner input out of the prompt when an input path is provided", () => {
    const prompt = buildPrompt(
      "再加个视频流",
      "历史上下文",
      "/tmp/result.json",
      "/tmp/skill-output",
      {
        userIntent: "再加个视频流",
        stage: "flow-template",
        project: {
          topology: {
            nodes: Array.from({ length: 20 }, (_, index) => ({ id: `node-${index}` })),
          },
        },
      },
      "/tmp/runner.mjs",
      "/tmp/stage-runner-input.json",
    );

    expect(prompt).toContain("/tmp/stage-runner-input.json");
    expect(prompt).not.toContain("node-19");
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

  it("keeps later detailed tool-use events when an earlier stream event had empty input", () => {
    const toolUseNamesById = new Map();
    const emptyTrace = extractOperationTraceEvents({
      type: "stream_event",
      event: {
        content_block: {
          type: "tool_use",
          id: "read-1",
          name: "Read",
          input: {},
        },
      },
    }, toolUseNamesById);
    const detailedTrace = extractOperationTraceEvents({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/tmp/skill-output/topology.json" } },
        ],
      },
    }, toolUseNamesById);

    expect(emptyTrace.map((trace) => trace.text)).toEqual([]);
    expect(detailedTrace.map((trace) => trace.text)).toEqual(["[文件] 读取 topology.json"]);
  });

  it("summarizes successful and failed tool results", () => {
    const toolUseNamesById = new Map([["bash-1", "Bash"], ["write-1", "Write"]]);
    const traces = extractOperationTraceEvents({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            content: "Intermediate JSON written.",
          },
          {
            type: "tool_result",
            tool_use_id: "write-1",
            content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
          },
        ],
      },
    }, toolUseNamesById);

    expect(traces.map((trace) => trace.text)).toEqual([
      "[工具结果] Bash 已返回：Intermediate JSON written.",
      "[工具结果] Write 已返回（失败）：File has not been read yet. Read it first before writing to it.",
    ]);
  });

  it("does not expose empty tool input objects in operation traces", () => {
    const traces = extractOperationTraceEvents({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "skill-1", name: "Skill", input: {} },
          { type: "tool_use", id: "bash-1", name: "Bash", input: {} },
        ],
      },
    });

    expect(traces.map((trace) => trace.text)).toEqual([]);
    expect(traces.map((trace) => trace.text).join("\n")).not.toContain("{}");
  });
});
