import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createTopologyWorkflowStageResult } from "../src/agent/topology-workflow-stage-result";
import {
  buildAllowedToolsForStage,
  buildPrompt,
  extractOperationTraceEvents,
  extractStageChangeRequests,
  extractStreamEventText,
  extractToolCallEvents,
  extractTopologyWorkflowStageResults,
  FLOW_MCP_ALLOWED_TOOLS,
  isCliEntryPoint,
  normalizeError,
  parseAssistantText,
  REQUEST_STAGE_CHANGE_TOOL_NAME,
  redactSecrets,
  requestStageChangeTool,
  runClaude,
  TIMESYNC_MCP_ALLOWED_TOOLS,
  TOPOLOGY_MCP_ALLOWED_TOOLS,
  UNDO_TOOL_NAME,
  undoLastChangeTool,
} from "./claude-agent-worker.mjs";
import {
  FLOW_MCP_ALLOWED_TOOLS as REGISTRY_FLOW_MCP_ALLOWED_TOOLS,
  TIMESYNC_MCP_ALLOWED_TOOLS as REGISTRY_TIMESYNC_MCP_ALLOWED_TOOLS,
  TOPOLOGY_MCP_ALLOWED_TOOLS as REGISTRY_TOPOLOGY_MCP_ALLOWED_TOOLS,
} from "./mcp/topology-tools";

function topologyStageResultFixture(mutationId = 7) {
  return createTopologyWorkflowStageResult(
    { sessionId: "session-1", mutationId },
    {
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.apply_operations",
      },
    },
  );
}

function failedTopologyStageResult(error) {
  return {
    ...topologyStageResultFixture(),
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

async function* messages(items) {
  for (const item of items) {
    yield item;
  }
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("claude-agent-worker", () => {
  // 回归：打包路径 "TSN Agent.app" 含空格，旧 new URL().pathname 保留 %20 导致 entry
  // 自检失配、runWorker 永不执行、worker 静默 exit 0（dev 路径无空格故从未暴露）。
  it("resolves a worker path containing spaces as the CLI entry point (decodes %20)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "TSN Space "));
    const file = join(dir, "claude-agent-worker.mjs");
    await writeFile(file, "");
    const url = pathToFileURL(file).href;
    expect(url).toContain("%20");
    expect(await isCliEntryPoint(url, file)).toBe(true);
  });

  it("does not treat a non-matching argv path as the CLI entry point", async () => {
    const url = pathToFileURL(join(tmpdir(), "tsn-a", "worker.mjs")).href;
    expect(await isCliEntryPoint(url, join(tmpdir(), "tsn-b", "worker.mjs"))).toBe(false);
  });

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
        REQUEST_STAGE_CHANGE_TOOL_NAME,
        ...TOPOLOGY_MCP_ALLOWED_TOOLS,
        UNDO_TOOL_NAME,
      ]);
      expect(input.options.settingSources).toEqual(["project"]);
      expect(input.options.skills).toEqual(["tsn-topology", "tsn-time-sync", "tsn-flow-planning"]);
      expect(input.options.tools).toEqual(["Read", "Skill"]);
      expect(input.options.allowedTools).toEqual([
        "Skill",
        "Read",
        REQUEST_STAGE_CHANGE_TOOL_NAME,
        ...TOPOLOGY_MCP_ALLOWED_TOOLS,
        UNDO_TOOL_NAME,
      ]);
      expect(input.options.mcpServers.tsn_topology).toMatchObject({
        type: "stdio",
        command: process.execPath,
        alwaysLoad: true,
      });
      expect(input.options.mcpServers.tsn_topology.args[0]).toContain("tsn-topology-server.mjs");
      // tsn_workflow（切阶段，in-process SDK server）始终注册。
      expect(input.options.mcpServers.tsn_workflow).toMatchObject({
        type: "sdk",
        name: "tsn_workflow",
      });
      // AskUserQuestion 双层禁用（plan 2026-06-05-001 U5）：dontAsk 下必拒，硬禁省 turn。
      expect(input.options.disallowedTools).toEqual(["AskUserQuestion"]);
      expect(input.options.maxTurns).toBe(20);
      expect(input.options.includePartialMessages).toBe(true);
      expect(input.options.systemPrompt).toContain("工程状态只接受结构化校验结果");
      expect(input.options.systemPrompt).toContain("tsn_topology MCP 工具");
      expect(input.options.systemPrompt).toContain("拓扑、时间同步、流量规划、配置下发");
      // U3：仿真「不得声称」已移出骨架（收敛到 SKILL.md 指引 + sanitizeClaudeAssistantText 输出守卫）。
      expect(input.options.systemPrompt).not.toContain("不能声称已启动仿真");
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

  it("injects the SKILL.md body into the system prompt after the guidance sentinel", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tsn-agent-skill-inject-"));
    const skillDir = join(projectDir, ".claude", "skills", "tsn-topology");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "[SKILL-PROBE-v1] 注入指引正文", "utf8");

    let capturedSystemPrompt;
    const query = async function* (input) {
      capturedSystemPrompt = input.options.systemPrompt;
      yield { type: "result", structured_output: { assistantText: "已注入" } };
    };

    await runClaude("我需要4个交换机", { cwd: projectDir }, query);

    expect(typeof capturedSystemPrompt).toBe("string");
    // 骨架段仍在 sentinel 之前。
    const [skeleton, guidance] = capturedSystemPrompt.split("<<<SKILL_GUIDANCE>>>");
    expect(skeleton).toContain("工程状态只接受结构化校验结果");
    // KTD8 迁入骨架的协议不变量（骨架是唯一载体，回退即丢失）。
    expect(skeleton).toContain("apply_operations 改动拓扑后，其返回已自动带库内结构校验结论");
    expect(skeleton).toContain("逐字节复用上一次的同一 operations");
    // U5：切阶段工具规则在骨架里（前进=确认按钮、回退=工具）。
    expect(skeleton).toContain("request_stage_change");
    expect(skeleton).toContain("不要用该工具前进");
    expect(guidance).toContain("[SKILL-PROBE-v1] 注入指引正文");
  });

  it("falls back to the skeleton system prompt when SKILL.md cannot be read", async () => {
    let capturedSystemPrompt;
    const query = async function* (input) {
      capturedSystemPrompt = input.options.systemPrompt;
      yield { type: "result", structured_output: { assistantText: "降级" } };
    };

    // cwd 下没有 .claude/skills/tsn-topology/SKILL.md → 读盘失败，不抛异常。
    const result = await runClaude(
      "我需要4个交换机",
      { cwd: join(tmpdir(), "tsn-agent-no-skill-dir-does-not-exist") },
      query,
    );

    expect(result.assistantText).toContain("降级");
    expect(typeof capturedSystemPrompt).toBe("string");
    expect(capturedSystemPrompt).not.toContain("<<<SKILL_GUIDANCE>>>");
    expect(capturedSystemPrompt).toContain("工程状态只接受结构化校验结果");
  });

  it("prefers the injected skillRoot over the cwd fallback when reading SKILL.md", async () => {
    // R2 同源：Tauri 决策的有效根（release 下指向 app-data 播种副本）优先于 cwd。
    const projectDir = await mkdtemp(join(tmpdir(), "tsn-agent-skillroot-cwd-"));
    const cwdSkillDir = join(projectDir, ".claude", "skills", "tsn-topology");
    await mkdir(cwdSkillDir, { recursive: true });
    await writeFile(join(cwdSkillDir, "SKILL.md"), "[CWD-COPY] 不应被读取", "utf8");

    const rootDir = await mkdtemp(join(tmpdir(), "tsn-agent-skillroot-injected-"));
    const injectedSkillDir = join(rootDir, "tsn-topology");
    await mkdir(injectedSkillDir, { recursive: true });
    await writeFile(join(injectedSkillDir, "SKILL.md"), "[APPDATA-COPY] 注入根正文", "utf8");

    let capturedSystemPrompt;
    const query = async function* (input) {
      capturedSystemPrompt = input.options.systemPrompt;
      yield { type: "result", structured_output: { assistantText: "已注入" } };
    };

    await runClaude("我需要4个交换机", { cwd: projectDir, skillRoot: rootDir }, query);

    expect(capturedSystemPrompt).toContain("[APPDATA-COPY] 注入根正文");
    expect(capturedSystemPrompt).not.toContain("[CWD-COPY]");
  });

  it("fails open to the skeleton when the injected skillRoot does not exist", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tsn-agent-skillroot-missing-"));
    const cwdSkillDir = join(projectDir, ".claude", "skills", "tsn-topology");
    await mkdir(cwdSkillDir, { recursive: true });
    await writeFile(join(cwdSkillDir, "SKILL.md"), "[CWD-COPY] 指定根失效时也不回退 cwd", "utf8");

    let capturedSystemPrompt;
    const query = async function* (input) {
      capturedSystemPrompt = input.options.systemPrompt;
      yield { type: "result", structured_output: { assistantText: "降级" } };
    };

    await runClaude(
      "我需要4个交换机",
      { cwd: projectDir, skillRoot: join(tmpdir(), "tsn-agent-skillroot-does-not-exist") },
      query,
    );

    // 指定根读不到 → 仅骨架（fail-open），不静默换源回退 cwd 副本。
    expect(capturedSystemPrompt).not.toContain("<<<SKILL_GUIDANCE>>>");
    expect(capturedSystemPrompt).not.toContain("[CWD-COPY]");
    expect(capturedSystemPrompt).toContain("工程状态只接受结构化校验结果");
  });

  // R6 按场景确定性注入：骨架 → <<<SKILL_GUIDANCE>>> 索引 → <<<SCENARIO_REFERENCE>>> 场景 reference。
  async function makeScenarioSkillRoot({ scenarios = {} } = {}) {
    const rootDir = await mkdtemp(join(tmpdir(), "tsn-agent-scenario-root-"));
    const skillDir = join(rootDir, "tsn-topology");
    const referenceDir = join(skillDir, "references");
    await mkdir(referenceDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "[INDEX-PROBE] 主索引正文", "utf8");
    for (const [scenarioId, body] of Object.entries(scenarios)) {
      await writeFile(join(referenceDir, `${scenarioId}.md`), body, "utf8");
    }
    return { rootDir, referenceDir };
  }

  async function captureScenarioPrompt(skillRoot, stageRunnerInput) {
    let capturedSystemPrompt;
    const query = async function* (input) {
      capturedSystemPrompt = input.options.systemPrompt;
      yield { type: "result", structured_output: { assistantText: "ok" } };
    };
    await runClaude("我需要4个交换机", { cwd: "/tmp/project", skillRoot, stageRunnerInput }, query);
    return capturedSystemPrompt;
  }

  it("injects the matching scenario reference after the scenario sentinel", async () => {
    const { rootDir, referenceDir } = await makeScenarioSkillRoot({
      scenarios: {
        "generic-tsn": "[REF-GENERIC] 通用指引",
        "aerospace-onboard": "[REF-AEROSPACE] 宇航指引",
      },
    });

    const prompt = await captureScenarioPrompt(rootDir, {
      userIntent: "x",
      stage: "topology",
      scenarioConfigId: "aerospace-onboard",
    });

    const [head, scenarioSegment] = prompt.split("<<<SCENARIO_REFERENCE>>>");
    expect(head).toContain("[INDEX-PROBE] 主索引正文");
    expect(scenarioSegment).toContain("[REF-AEROSPACE] 宇航指引");
    expect(scenarioSegment).not.toContain("[REF-GENERIC]");
    // 绝对路径表列出全部场景文件，供 Read 跨场景查阅。
    expect(scenarioSegment).toContain(join(referenceDir, "generic-tsn.md"));
    expect(scenarioSegment).toContain(join(referenceDir, "aerospace-onboard.md"));
  });

  it("injects the generic reference for the generic scenario", async () => {
    const { rootDir } = await makeScenarioSkillRoot({
      scenarios: {
        "generic-tsn": "[REF-GENERIC] 通用指引",
        "aerospace-onboard": "[REF-AEROSPACE] 宇航指引",
      },
    });

    const prompt = await captureScenarioPrompt(rootDir, {
      userIntent: "x",
      stage: "topology",
      scenarioConfigId: "generic-tsn",
    });

    const scenarioSegment = prompt.split("<<<SCENARIO_REFERENCE>>>")[1];
    expect(scenarioSegment).toContain("[REF-GENERIC] 通用指引");
    expect(scenarioSegment).not.toContain("[REF-AEROSPACE]");
  });

  it("falls back to the generic reference for an unknown scenario", async () => {
    const { rootDir } = await makeScenarioSkillRoot({
      scenarios: { "generic-tsn": "[REF-GENERIC] 通用指引" },
    });

    const prompt = await captureScenarioPrompt(rootDir, {
      userIntent: "x",
      stage: "topology",
      scenarioConfigId: "industrial-future",
    });

    expect(prompt.split("<<<SCENARIO_REFERENCE>>>")[1]).toContain("[REF-GENERIC] 通用指引");
  });

  it("treats a missing scenarioConfigId as the generic scenario", async () => {
    const { rootDir } = await makeScenarioSkillRoot({
      scenarios: { "generic-tsn": "[REF-GENERIC] 通用指引" },
    });

    const prompt = await captureScenarioPrompt(rootDir, { userIntent: "x", stage: "topology" });

    expect(prompt.split("<<<SCENARIO_REFERENCE>>>")[1]).toContain("[REF-GENERIC] 通用指引");
  });

  it("injects only the index when no scenario reference is on disk", async () => {
    const { rootDir } = await makeScenarioSkillRoot();

    const prompt = await captureScenarioPrompt(rootDir, {
      userIntent: "x",
      stage: "topology",
      scenarioConfigId: "aerospace-onboard",
    });

    expect(prompt).toContain("[INDEX-PROBE] 主索引正文");
    expect(prompt).not.toContain("<<<SCENARIO_REFERENCE>>>");
  });

  it("treats a malformed scenario id as unknown instead of joining it into a path", async () => {
    // 畸形值（路径遍历形态）不得参与 join——按未知场景回退 generic-tsn。
    const { rootDir } = await makeScenarioSkillRoot({
      scenarios: { "generic-tsn": "[REF-GENERIC] 通用指引" },
    });

    const prompt = await captureScenarioPrompt(rootDir, {
      userIntent: "x",
      stage: "topology",
      scenarioConfigId: "../../tsn-flow-planning/SKILL",
    });

    expect(prompt.split("<<<SCENARIO_REFERENCE>>>")[1]).toContain("[REF-GENERIC] 通用指引");
  });

  it("does not synthesize a topology stage result from assistant-authored topology JSON without an MCP tool call", () => {
    // 机制层 AE3：agent 在 assistantText 里输出整份拓扑 JSON、不调任何 MCP 工具，
    // trusted-signal 提取器只认 MCP tool_result 的 mutationId → 返回空。
    const topologyJson = JSON.stringify({
      nodes: [{ mid: "1", nodeType: "switch" }],
      links: [{ linkSeq: 1, srcNode: "0", dstNode: "1" }],
    });
    const extracted = extractTopologyWorkflowStageResults(
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: `这是我手写的拓扑：${topologyJson}` }],
        },
      },
      new Map(),
      { stage: "topology" },
    );

    expect(extracted).toEqual([]);
  });

  it("Plan v3 Phase B-β: extracts the trusted mutation only from mutationId-shaped sidecar results", async () => {
    const { _extractTrustedTopologyMutationForTest } = await import("./claude-agent-worker.mjs");
    // 新 sidecar 形态
    expect(
      _extractTrustedTopologyMutationForTest({
        ok: true,
        summary: { sessionId: "s1", mutationId: 7, applied: [{}, {}], dryRun: false },
      }),
    ).toEqual({ sessionId: "s1", mutationId: 7, appliedCount: 2 });
    // 缺 mutationId → 拒绝
    expect(
      _extractTrustedTopologyMutationForTest({
        ok: true,
        summary: { sessionId: "s1" },
      }),
    ).toBeUndefined();
    // ok=false → 拒绝
    expect(
      _extractTrustedTopologyMutationForTest({
        ok: false,
        summary: { sessionId: "s1", mutationId: 1 },
      }),
    ).toBeUndefined();
    // dryRun（mutationId 缺省）→ 拒绝
    expect(
      _extractTrustedTopologyMutationForTest({
        ok: true,
        summary: { sessionId: "s1", mutationId: null, dryRun: true },
      }),
    ).toBeUndefined();
    // legacy responseMode:full 不再合成阶段结果
    expect(
      _extractTrustedTopologyMutationForTest({
        ok: true,
        metadata: { responseMode: "full", summaryOnly: false },
        full: { topology: { nodes: [], links: [] } },
      }),
    ).toBeUndefined();
  });

  it("extracts topology workflow stage results from mutationId MCP tool_result blocks", () => {
    const toolUseNamesById = new Map([
      ["toolu-apply", "mcp__tsn_topology__topology_apply_operations"],
    ]);
    const toolResult = {
      ok: true,
      summary: { sessionId: "session-1", dryRun: false, applied: [{}, {}, {}], mutationId: 5 },
    };

    const extracted = extractTopologyWorkflowStageResults(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-apply",
              content: [
                {
                  type: "text",
                  text: JSON.stringify(toolResult),
                },
              ],
            },
          ],
        },
      },
      toolUseNamesById,
      { stage: "topology" },
    );

    expect(extracted).toHaveLength(1);
    expect(extracted[0].result).toMatchObject({
      schemaVersion: "tsn-agent.workflow-stage-result.v1",
      stage: "topology",
      producer: {
        type: "mcp",
        name: "tsn_topology",
        tool: "topology.apply_operations",
      },
      status: "success",
      payload: {
        kind: "topology",
        sessionId: "session-1",
        mutationId: 5,
      },
    });
    expect(extracted[0].result.summary).toContain("mutation #5");
  });

  it("U1: request_stage_change tool returns the structured stage-change proposal", async () => {
    const result = await requestStageChangeTool.handler(
      { targetStage: "topology", reason: "用户要加两个设备" },
      {},
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({
      ok: true,
      stageChangeRequest: { targetStage: "topology", reason: "用户要加两个设备" },
    });
  });

  it("U1: request_stage_change omits reason when not provided", async () => {
    const result = await requestStageChangeTool.handler({ targetStage: "time-sync" }, {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.stageChangeRequest).toEqual({ targetStage: "time-sync" });
  });

  it("U2: stage-change tool is whitelisted in every stage; topology write tools only in the topology stage", () => {
    const topologyStage = buildAllowedToolsForStage({ stage: "topology" }, true);
    const timeSyncStage = buildAllowedToolsForStage({ stage: "time-sync" }, true);
    expect(topologyStage).toContain(REQUEST_STAGE_CHANGE_TOOL_NAME);
    expect(timeSyncStage).toContain(REQUEST_STAGE_CHANGE_TOOL_NAME);
    // 拓扑写工具只在拓扑阶段开放——非拓扑阶段直写库的结果不会被对账，会让工程与 workflow 静默分叉。
    expect(topologyStage).toContain("mcp__tsn_topology__topology_apply_operations");
    expect(timeSyncStage).not.toContain("mcp__tsn_topology__topology_apply_operations");
  });

  it("U6: undo tool is whitelisted only in the topology stage (not in other stages)", () => {
    const topologyStage = buildAllowedToolsForStage({ stage: "topology" }, true);
    const timeSyncStage = buildAllowedToolsForStage({ stage: "time-sync" }, true);
    const flowStage = buildAllowedToolsForStage({ stage: "flow-template" }, true);
    expect(topologyStage).toContain(UNDO_TOOL_NAME);
    // 本期只撤 topology——在时间同步 / 流量规划阶段撤销会错误回退拓扑。
    expect(timeSyncStage).not.toContain(UNDO_TOOL_NAME);
    expect(flowStage).not.toContain(UNDO_TOOL_NAME);
  });

  it("U6: undo tool stays available in the topology stage even when the topology stdio host is unresolved", () => {
    // 撤销 in-process（不连 tsn_topology stdio server），故只门控 stage、不门控 hasTopologyMcpConfig。
    const topologyStage = buildAllowedToolsForStage({ stage: "topology" }, false);
    expect(topologyStage).toContain(UNDO_TOOL_NAME);
    expect(topologyStage).not.toContain("mcp__tsn_topology__topology_apply_operations");
  });

  it("U6: undo tool is defined as undo_last_change with the expected mcp name", () => {
    expect(undoLastChangeTool.name).toBe("undo_last_change");
    expect(UNDO_TOOL_NAME).toBe("mcp__tsn_workflow__undo_last_change");
  });

  it("U10: worker timesync allowedTools stays aligned with the timesync registry", () => {
    expect(TIMESYNC_MCP_ALLOWED_TOOLS).toEqual(REGISTRY_TIMESYNC_MCP_ALLOWED_TOOLS);
  });

  it("U10: time-sync stage whitelists timesync tools but not topology write tools", () => {
    const timeSyncStage = buildAllowedToolsForStage({ stage: "time-sync" }, true);
    const topologyStage = buildAllowedToolsForStage({ stage: "topology" }, true);
    // time-sync 阶段：放行全部 timesync 工具。
    for (const tool of TIMESYNC_MCP_ALLOWED_TOOLS) {
      expect(timeSyncStage).toContain(tool);
    }
    // time-sync 阶段：放行只读 topology_inspect（设 GM 要把节点名解析成 mid）。
    expect(timeSyncStage).toContain("mcp__tsn_topology__topology_inspect");
    // time-sync 阶段：不放行拓扑写工具（initialize/apply 越阶段会让工程静默分叉）。
    expect(timeSyncStage).not.toContain("mcp__tsn_topology__topology_apply_operations");
    expect(timeSyncStage).not.toContain("mcp__tsn_topology__topology_initialize");
    // 反向：拓扑阶段不放行 timesync 工具。
    for (const tool of TIMESYNC_MCP_ALLOWED_TOOLS) {
      expect(topologyStage).not.toContain(tool);
    }
  });

  it("U10: timesync tools require the topology stdio host (gated by hasTopologyMcpConfig)", () => {
    // timesync 工具与 topology 同住 tsn_topology server；server 没注册（host 未解析）就不放行。
    const timeSyncStageNoHost = buildAllowedToolsForStage({ stage: "time-sync" }, false);
    for (const tool of TIMESYNC_MCP_ALLOWED_TOOLS) {
      expect(timeSyncStageNoHost).not.toContain(tool);
    }
    // 切阶段工具仍在（in-process，不依赖 stdio host）。
    expect(timeSyncStageNoHost).toContain(REQUEST_STAGE_CHANGE_TOOL_NAME);
  });

  it("U3: worker flow allowedTools stays aligned with the flow registry (drift guard)", () => {
    expect(FLOW_MCP_ALLOWED_TOOLS).toEqual(REGISTRY_FLOW_MCP_ALLOWED_TOOLS);
  });

  it("U3: flow-template stage whitelists flow tools + topology_inspect, not write/timesync tools", () => {
    const flowStage = buildAllowedToolsForStage({ stage: "flow-template" }, true);
    const topologyStage = buildAllowedToolsForStage({ stage: "topology" }, true);
    // flow 阶段：放行全部 flow 工具。
    for (const tool of FLOW_MCP_ALLOWED_TOOLS) {
      expect(flowStage).toContain(tool);
    }
    // flow 阶段：放行只读 topology_inspect（录流要把 talker/listener 名解析成 mid）。
    expect(flowStage).toContain("mcp__tsn_topology__topology_inspect");
    // flow 阶段：不放行拓扑写工具、也不放行 timesync 工具（越阶段误写）。
    expect(flowStage).not.toContain("mcp__tsn_topology__topology_apply_operations");
    expect(flowStage).not.toContain("mcp__tsn_topology__timesync_set_gm");
    // 反向：拓扑阶段不放行 flow 工具。
    for (const tool of FLOW_MCP_ALLOWED_TOOLS) {
      expect(topologyStage).not.toContain(tool);
    }
  });

  it("U3: flow tools require the topology stdio host (gated by hasTopologyMcpConfig)", () => {
    const flowStageNoHost = buildAllowedToolsForStage({ stage: "flow-template" }, false);
    for (const tool of FLOW_MCP_ALLOWED_TOOLS) {
      expect(flowStageNoHost).not.toContain(tool);
    }
  });

  it("U10: time-sync stage injects the tsn-time-sync SKILL.md as a single string after the guidance sentinel", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tsn-agent-timesync-skill-"));
    const skillDir = join(rootDir, "tsn-time-sync");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "[TIMESYNC-SKILL-PROBE] 时钟同步指引正文", "utf8");
    // 同时放一个拓扑 SKILL.md 当干扰项：time-sync 阶段不得注入它。
    const topologyDir = join(rootDir, "tsn-topology");
    await mkdir(topologyDir, { recursive: true });
    await writeFile(join(topologyDir, "SKILL.md"), "[TOPOLOGY-SKILL] 不应被注入", "utf8");

    let capturedSystemPrompt;
    const query = async function* (input) {
      capturedSystemPrompt = input.options.systemPrompt;
      yield { type: "result", structured_output: { assistantText: "ok" } };
    };

    await runClaude(
      "把 GM 设成 ES-1",
      {
        cwd: "/tmp/project",
        skillRoot: rootDir,
        stageRunnerInput: { userIntent: "把 GM 设成 ES-1", stage: "time-sync" },
      },
      query,
    );

    // 注入是单字符串（拼接，绝不 string[]——string[] 会崩 redactSecrets）。
    expect(typeof capturedSystemPrompt).toBe("string");
    const [skeleton, guidance] = capturedSystemPrompt.split("<<<SKILL_GUIDANCE>>>");
    expect(skeleton).toContain("工程状态只接受结构化校验结果");
    expect(guidance).toContain("[TIMESYNC-SKILL-PROBE] 时钟同步指引正文");
    // time-sync 阶段不注入拓扑场景 reference 分隔，也不注入拓扑 SKILL.md。
    expect(capturedSystemPrompt).not.toContain("<<<SCENARIO_REFERENCE>>>");
    expect(capturedSystemPrompt).not.toContain("[TOPOLOGY-SKILL]");
  });

  it("U3: flow-template stage injects the tsn-flow-planning SKILL.md as a single string", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tsn-agent-flow-skill-"));
    const skillDir = join(rootDir, "tsn-flow-planning");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "[FLOW-SKILL-PROBE] 流量规划指引正文", "utf8");
    const topologyDir = join(rootDir, "tsn-topology");
    await mkdir(topologyDir, { recursive: true });
    await writeFile(join(topologyDir, "SKILL.md"), "[TOPOLOGY-SKILL] 不应被注入", "utf8");

    let capturedSystemPrompt;
    const query = async function* (input) {
      capturedSystemPrompt = input.options.systemPrompt;
      yield { type: "result", structured_output: { assistantText: "ok" } };
    };

    await runClaude(
      "加一条 ES-1 到 ES-2 的 ST 流",
      {
        cwd: "/tmp/project",
        skillRoot: rootDir,
        stageRunnerInput: { userIntent: "加一条 ES-1 到 ES-2 的 ST 流", stage: "flow-template" },
      },
      query,
    );

    expect(typeof capturedSystemPrompt).toBe("string");
    const [, guidance] = capturedSystemPrompt.split("<<<SKILL_GUIDANCE>>>");
    expect(guidance).toContain("[FLOW-SKILL-PROBE] 流量规划指引正文");
    expect(capturedSystemPrompt).not.toContain("[TOPOLOGY-SKILL]");
  });

  it("U6: undo tool handler calls the sidecar undo route and passes through the structured result", async () => {
    const previousEnv = {
      url: process.env.TSN_AGENT_DB_RPC_URL,
      token: process.env.TSN_AGENT_DB_RPC_TOKEN,
      sessionId: process.env.TSN_AGENT_SESSION_ID,
    };
    process.env.TSN_AGENT_DB_RPC_URL = "http://127.0.0.1:65535";
    process.env.TSN_AGENT_DB_RPC_TOKEN = "test-token";
    process.env.TSN_AGENT_SESSION_ID = "session-undo";

    const sidecarBody = { ok: true, undone: true, summary: { mutationId: 9 } };
    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:65535/db/topology/undo");
      expect(init.method).toBe("POST");
      // 无参 undo：sessionId 由 fetchSidecar 从 env 注入，工具 handler 不传任何 body。
      expect(JSON.parse(init.body)).toEqual({ sessionId: "session-undo" });
      return new Response(JSON.stringify(sidecarBody), { status: 200 });
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const result = await undoLastChangeTool.handler({}, {});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(result.content[0].text);
      // 解包后大模型看到的是干净的 body（{ok,undone,summary}），不是 fetchSidecar 信封。
      expect(payload).toEqual(sidecarBody);
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv("TSN_AGENT_DB_RPC_URL", previousEnv.url);
      restoreEnv("TSN_AGENT_DB_RPC_TOKEN", previousEnv.token);
      restoreEnv("TSN_AGENT_SESSION_ID", previousEnv.sessionId);
    }
  });

  it("U6: undo tool maps a sidecar failure to a structured errors[] result (not the raw envelope)", async () => {
    const previousEnv = {
      url: process.env.TSN_AGENT_DB_RPC_URL,
      token: process.env.TSN_AGENT_DB_RPC_TOKEN,
      sessionId: process.env.TSN_AGENT_SESSION_ID,
    };
    process.env.TSN_AGENT_DB_RPC_URL = "http://127.0.0.1:65535";
    process.env.TSN_AGENT_DB_RPC_TOKEN = "test-token";
    process.env.TSN_AGENT_SESSION_ID = "session-undo";

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "DATABASE_ERROR", message: "boom" }), { status: 500 }),
    );
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const result = await undoLastChangeTool.handler({}, {});
      const payload = JSON.parse(result.content[0].text);
      expect(payload.ok).toBe(false);
      expect(payload.errors).toEqual([{ code: "DATABASE_ERROR", message: "boom" }]);
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv("TSN_AGENT_DB_RPC_URL", previousEnv.url);
      restoreEnv("TSN_AGENT_DB_RPC_TOKEN", previousEnv.token);
      restoreEnv("TSN_AGENT_SESSION_ID", previousEnv.sessionId);
    }
  });

  it("U2: extracts a stage-change proposal in a non-topology stage (no stage gate)", () => {
    const toolUseNamesById = new Map([["toolu-switch", REQUEST_STAGE_CHANGE_TOOL_NAME]]);
    const toolResult = {
      ok: true,
      stageChangeRequest: { targetStage: "topology", reason: "加两个设备" },
    };

    const extracted = extractStageChangeRequests(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-switch",
              content: [{ type: "text", text: JSON.stringify(toolResult) }],
            },
          ],
        },
      },
      toolUseNamesById,
    );

    expect(extracted).toHaveLength(1);
    expect(extracted[0].result).toEqual({
      kind: "stage-change-request",
      targetStage: "topology",
      reason: "加两个设备",
    });
  });

  it("U2: does not produce a proposal when the model only writes text without calling the tool", () => {
    const extracted = extractStageChangeRequests(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "我帮你切到拓扑阶段" }] },
      },
      new Map(),
    );
    expect(extracted).toEqual([]);
  });

  it("U2: ignores tool_result blocks from other tools", () => {
    const toolUseNamesById = new Map([["toolu-read", "Read"]]);
    const extracted = extractStageChangeRequests(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-read",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    stageChangeRequest: { targetStage: "topology" },
                  }),
                },
              ],
            },
          ],
        },
      },
      toolUseNamesById,
    );
    expect(extracted).toEqual([]);
  });

  it("reads a topology stage result written to the run-scoped path", async () => {
    const events = [];
    const query = async function* (input) {
      const resultPath = input.options.env.TSN_AGENT_STAGE_RESULT_PATH;
      expect(resultPath).toContain("tsn-agent-stage-");
      await writeFile(resultPath, JSON.stringify(topologyStageResultFixture(7)), "utf8");
      yield { type: "result", session_id: "session-stage", result: "拓扑已生成" };
    };

    const result = await runClaude(
      "我需要4个交换机，每个交换机连接5个端系统",
      { onEvent: (event) => events.push(event) },
      query,
    );

    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]).toMatchObject({
      stage: "topology",
      producer: { name: "tsn_topology" },
      validation: { ok: true, errors: [] },
      payload: { kind: "topology", sessionId: "session-1", mutationId: 7 },
    });
    // Plan 2026-06-09-003 KTD5：trace（含阶段结果）不再走 chunk 流。
    expect(events.map((event) => event.text ?? "").join("")).not.toContain("[阶段结果]");
  });

  it("fails closed by omitting topology MCP config when topology host cannot be resolved", async () => {
    const query = async function* (input) {
      expect(input.options.allowedTools).not.toContain("mcp__tsn_topology__topology_initialize");
      // 拓扑 server fail-closed 省略；切阶段 in-process server 与其无关，始终注册。
      expect(input.options.mcpServers.tsn_topology).toBeUndefined();
      expect(input.options.mcpServers.tsn_workflow).toMatchObject({
        type: "sdk",
        name: "tsn_workflow",
      });
      yield {
        type: "result",
        session_id: "session-no-mcp-host",
        result: "拓扑工具暂不可用，已回退本地 runner 路径",
      };
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
    let callCount = 0;
    const query = async function* (input) {
      callCount += 1;
      expect(input.prompt).toContain("stage-runner-input.json");
      expect(input.options.env.TSN_AGENT_STAGE_RUNNER_INPUT_PATH).toContain(
        "stage-runner-input.json",
      );
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
        appSessionId: "session-repair",
        runId: "agent-run-repair",
        onEvent: (event) => events.push(event),
      },
      query,
    );

    const streamed = events.map((event) => event.text ?? "").join("");
    expect(callCount).toBe(1);
    expect(streamed).not.toContain("tsn-stage-runner --stage topology");
    expect(result.assistantText).toContain("拓扑已生成");
    expect(result.stageResults).toEqual([]);
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

  it("collects SDK tool use/result into toolCalls and keeps trace text out of chunks and assistant text", async () => {
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
                command: 'ls "$TSN_AGENT_SKILL_OUTPUT_DIR"',
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

    const result = await runClaude(
      "加三条视频流",
      { onEvent: (event) => events.push(event) },
      query,
    );

    const streamed = events.map((event) => event.text ?? "").join("");
    // KTD5：trace 文本不再进 chunk 流，也不再 prepend 进 assistantText。
    expect(streamed).not.toContain("[工具]");
    expect(result.assistantText).not.toContain("[工具]");
    expect(result.assistantText).toContain("已更新流量规划");
    // R3/R5：完整入参/出参收进 done.toolCalls。
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: "toolu-1",
      name: "Bash",
      status: "success",
      args: { command: expect.stringContaining("ls") },
      result: "ok",
    });
  });

  it("marks failed tool results as error and dedupes multi-tool calls by id (R10)", async () => {
    const query = async function* () {
      yield {
        type: "assistant",
        session_id: "session-multi-tool",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-a",
              name: "Read",
              input: { file_path: "src/app/App.tsx" },
            },
            { type: "tool_use", id: "toolu-b", name: "Bash", input: { command: "false" } },
          ],
        },
      };
      yield {
        type: "user",
        session_id: "session-multi-tool",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu-a", content: "file body" },
            {
              type: "tool_result",
              tool_use_id: "toolu-b",
              content: "<tool_use_error>Exit code 1</tool_use_error>",
            },
          ],
        },
      };
      yield { type: "result", session_id: "session-multi-tool", result: "完成" };
    };

    const result = await runClaude("做两件事", undefined, query);

    expect(result.toolCalls).toHaveLength(2);
    const byId = Object.fromEntries(result.toolCalls.map((call) => [call.id, call]));
    expect(byId["toolu-a"]).toMatchObject({ name: "Read", status: "success", result: "file body" });
    expect(byId["toolu-b"].status).toBe("error");
  });

  it("extractToolCallEvents pairs use+result entries with full args/result", () => {
    const toolUseNamesById = new Map();
    const useEntries = extractToolCallEvents(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "mcp__tsn_topology__topology_initialize",
              input: { template: "line" },
            },
          ],
        },
      },
      toolUseNamesById,
    );
    const resultEntries = extractToolCallEvents(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-1",
              content: [
                { type: "text", text: JSON.stringify({ ok: true, summary: { mutationId: 3 } }) },
              ],
            },
          ],
        },
      },
      toolUseNamesById,
    );

    expect(useEntries).toEqual([
      {
        phase: "use",
        id: "toolu-1",
        name: "mcp__tsn_topology__topology_initialize",
        args: { template: "line" },
      },
    ]);
    expect(resultEntries[0]).toMatchObject({
      phase: "result",
      id: "toolu-1",
      name: "mcp__tsn_topology__topology_initialize",
      status: "success",
      result: { ok: true, summary: { mutationId: 3 } },
    });
  });

  it("emits streaming tool_call start/result events per tool, zero-arg tools included (U1/AE1)", async () => {
    const events = [];
    const query = async function* () {
      yield {
        type: "assistant",
        session_id: "s-stream-cards",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "mcp__tsn_topology__topology_describe_templates",
              input: {},
            },
          ],
        },
      };
      yield {
        type: "user",
        session_id: "s-stream-cards",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "templates" }],
        },
      };
      yield {
        type: "assistant",
        session_id: "s-stream-cards",
        message: {
          content: [{ type: "tool_use", id: "toolu-2", name: "Bash", input: { command: "ls" } }],
        },
      };
      yield {
        type: "user",
        session_id: "s-stream-cards",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu-2", content: "ok" }] },
      };
      yield { type: "result", session_id: "s-stream-cards", result: "完成" };
    };

    const result = await runClaude("两个工具", { onEvent: (event) => events.push(event) }, query);

    const toolEvents = events.filter((event) => event.event === "tool_call");
    expect(toolEvents.map((event) => [event.toolCall.phase, event.toolCall.id])).toEqual([
      ["start", "toolu-1"],
      ["result", "toolu-1"],
      ["start", "toolu-2"],
      ["result", "toolu-2"],
    ]);
    // 零参工具（input:{}）也要发 start，args 为合法空对象。
    expect(toolEvents[0].toolCall).toMatchObject({
      name: "mcp__tsn_topology__topology_describe_templates",
      args: {},
    });
    expect(toolEvents[1].toolCall).toMatchObject({ status: "success", result: "templates" });
    expect(toolEvents[2].toolCall).toMatchObject({ name: "Bash", args: { command: "ls" } });
    // done.toolCalls 仍为五字段完整列表（无 phase）。
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).not.toHaveProperty("phase");
    expect(result.toolCalls[1]).not.toHaveProperty("phase");
  });

  it("skips stream_event empty-input signals and never re-emits start per id (U1/AE2)", async () => {
    const events = [];
    const query = async function* () {
      yield {
        type: "stream_event",
        session_id: "s-stream-guard",
        event: { content_block: { type: "tool_use", id: "toolu-1", name: "Bash", input: {} } },
      };
      yield {
        type: "assistant",
        session_id: "s-stream-guard",
        message: {
          content: [{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } }],
        },
      };
      yield {
        type: "assistant",
        session_id: "s-stream-guard",
        message: {
          content: [{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } }],
        },
      };
      yield {
        type: "user",
        session_id: "s-stream-guard",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-1",
              content: "<tool_use_error>Exit code 1</tool_use_error>",
            },
          ],
        },
      };
      yield { type: "result", session_id: "s-stream-guard", result: "完成" };
    };

    await runClaude("一个工具", { onEvent: (event) => events.push(event) }, query);

    const toolEvents = events.filter((event) => event.event === "tool_call");
    expect(toolEvents).toHaveLength(2);
    // stream_event 的空参早期信号不触发 start；start 携带完整 args 且不重发。
    expect(toolEvents[0].toolCall).toMatchObject({
      phase: "start",
      id: "toolu-1",
      args: { command: "ls" },
    });
    expect(toolEvents[1].toolCall).toMatchObject({
      phase: "result",
      id: "toolu-1",
      status: "error",
    });
  });

  it("U3/U4: appends a raw eval record with native output blocks and apply/validate label", async () => {
    const evalDir = await mkdtemp(join(tmpdir(), "tsn-agent-eval-test-"));
    const query = async function* (_input) {
      yield { type: "system", session_id: "sdk-session-eval" };
      yield {
        type: "assistant",
        session_id: "sdk-session-eval",
        message: {
          content: [
            { type: "text", text: "我先应用修改" },
            {
              type: "tool_use",
              id: "toolu-eval",
              name: "mcp__tsn_topology__topology_apply_operations",
              input: { operations: [], dryRun: false },
            },
          ],
        },
      };
      yield {
        type: "user",
        session_id: "sdk-session-eval",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-eval",
              content: JSON.stringify({
                ok: true,
                summary: { mutationId: 2 },
                validation: { ran: true, valid: true, caliber: "structural_only", errors: [] },
              }),
            },
          ],
        },
      };
      yield { type: "result", session_id: "sdk-session-eval", result: "已应用" };
    };

    await runClaude(
      "把端系统改成 6 个 sk-ant-SECRET123",
      {
        evalDir,
        appSessionId: "session-eval",
        runId: "agent-run-eval",
        skillRoot: "/tmp/tsn-agent-eval-skill-root",
        stageRunnerInput: {
          userIntent: "改端系统",
          stage: "topology",
          scenarioConfigId: "generic-tsn",
        },
      },
      query,
    );

    const lines = (await readFile(join(evalDir, "eval.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);

    expect(record.schemaVersion).toBe("tsn-agent.eval-record.v1");
    expect(record.runId).toBe("agent-run-eval");
    expect(record.sessionId).toBe("session-eval");
    expect(record.claudeSessionId).toBe("sdk-session-eval");
    expect(record.stage).toBe("topology");
    expect(record.scenarioConfigId).toBe("generic-tsn");
    // input.system 为 raw（含骨架）；input.messages 历史标记有损。
    expect(record.input.system).toContain("你是 TSN Agent 的规划助手");
    expect(record.input.lossyHistory).toBe(true);
    expect(record.input.messages[0].content[0].text).toContain("把端系统改成 6 个");
    // input 侧 raw：密钥原文不脱敏。
    expect(record.input.messages[0].content[0].text).toContain("sk-ant-SECRET123");
    // output 为原生 blocks（text + tool_use + tool_result），未截断。
    const assistantBlocks = record.output.messages.find((m) => m.role === "assistant").content;
    expect(assistantBlocks.some((b) => b.type === "tool_use")).toBe(true);
    const userBlocks = record.output.messages.find((m) => m.role === "user").content;
    expect(userBlocks[0].type).toBe("tool_result");
    // label 取自 apply_operations 的 verification。
    expect(record.label).toEqual({ ok: true, caliber: "structural_only", errors: [] });
    // 指纹：未读到 SKILL.md → skillHash null；骨架 hash 非空。
    expect(record.fingerprint.skillHash).toBeNull();
    expect(record.fingerprint.skeletonVersion).toMatch(/^sha256:/);
    expect(record.fingerprint.model).toBe("claude-sonnet-4-6");
    expect(typeof record.input.toolsHash).toBe("string");
  });

  it("U3/U4: eval record label is null for runs without apply/validate", async () => {
    const evalDir = await mkdtemp(join(tmpdir(), "tsn-agent-eval-nolabel-"));
    const query = async function* (_input) {
      yield { type: "system", session_id: "sdk-session-nolabel" };
      yield {
        type: "assistant",
        session_id: "sdk-session-nolabel",
        message: { content: [{ type: "text", text: "好的" }] },
      };
      yield { type: "result", session_id: "sdk-session-nolabel", result: "好的" };
    };

    await runClaude(
      "随便聊聊",
      {
        evalDir,
        appSessionId: "session-nolabel",
        runId: "agent-run-nolabel",
        skillRoot: "/tmp/tsn-agent-eval-skill-root",
        stageRunnerInput: { userIntent: "聊", stage: "topology", scenarioConfigId: "generic-tsn" },
      },
      query,
    );

    const record = JSON.parse((await readFile(join(evalDir, "eval.jsonl"), "utf8")).trim());
    expect(record.label).toBeNull();
  });

  it("does not synthesize a topology stage result when the SDK stops at the turn limit", async () => {
    const query = async function* (input) {
      expect(input.options.maxTurns).toBe(3);
      yield { type: "system", session_id: "session-turn-limit" };
      throw new Error("Bash returned an error result: Reached maximum number of turns (3)");
    };
    const stageRunner = vi.fn();

    await expect(
      runClaude(
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
      ),
    ).rejects.toThrow("Reached maximum number of turns");
    expect(stageRunner).not.toHaveBeenCalled();
  });

  it("does not synthesize a flow planning stage result when the SDK stops at the turn limit", async () => {
    const query = async function* () {
      yield { type: "system", session_id: "session-flow-turn-limit" };
      throw new Error("Bash returned an error result: Reached maximum number of turns (3)");
    };
    const stageRunner = vi.fn();

    await expect(
      runClaude(
        "再加3条视频流吧",
        {
          stageRunnerInput: {
            userIntent: "再加3条视频流吧",
            stage: "flow-template",
            scenarioConfigId: "generic-tsn",
          },
          stageRunner,
        },
        query,
      ),
    ).rejects.toThrow("Reached maximum number of turns");
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
      runClaude(
        "继续",
        { resumeSessionId: "session-old", conversationContext: "上一轮已生成拓扑" },
        query,
      ),
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
      yield {
        type: "result",
        session_id: "session-2",
        result: '{"assistantText":"JSON 字符串回复"}',
      };
    };

    await expect(runClaude("需求", undefined, query)).resolves.toEqual({
      assistantText: "JSON 字符串回复",
      sessionId: "session-2",
      stageResults: [],
      toolCalls: [],
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

  it("builds a TSN-specific prompt with skeleton constraints but no SKILL.md-owned domain guidance", () => {
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
    expect(prompt).toContain("拓扑 -> 时间同步 -> 流量规划 -> 配置下发");
    // U3：仿真「不得声称」从 buildPrompt 移出（SKILL.md 指引 + sanitize 守卫承载）。
    expect(prompt).not.toContain("当前应用没有接入 OMNeT++/远程服务器仿真 runner");
    expect(prompt).not.toContain("/tmp/result.json");
    expect(prompt).toContain("/tmp/skill-output");
    expect(prompt).toContain("tsn_topology MCP 工具");
    expect(prompt).toContain("trusted topology result");
    expect(prompt).not.toContain("--stage topology");
    expect(prompt).not.toContain("然后继续生成控制流模板和导出文件");
    // 交互工学规则（plan 2026-06-05-001 U5）。
    expect(prompt).toContain("不要调用 AskUserQuestion");
    expect(prompt).toContain("选项编号用数字、跨轮保持指代稳定");
    // buildPrompt 仍承载部分正确性提示（initialize 仅用于从 0 生成/换模板）。
    expect(prompt).toContain("不要用 initialize 重建");
    // U3：重试「复用同一 batch」去重——只留 SYSTEM_PROMPT_SKELETON 一份权威，buildPrompt 不再重复。
    expect(prompt).not.toContain("逐字节复用");
    expect(prompt).toContain("不要把 inspect 返回的 rows");
    // U1：与 SKILL.md 重复的领域指引已移出 buildPrompt（由注入的 SKILL.md 承载）。
    // 默认互联公式（N*M+(N-1)）。
    expect(prompt).not.toContain("N*M");
    expect(prompt).not.toContain("交换机线型互联链路");
    // 显示名映射规则（SW-N/ES-N 按 mid）。
    expect(prompt).not.toContain("按 mid 精确等于");
    expect(prompt).not.toContain("不要按列表顺序或第 N 台折算");
    // "skill 仅作 MCP 使用指引"措辞。
    expect(prompt).not.toContain("只能作为 MCP 使用指引");
  });

  it("keeps large stage runner input out of the prompt when an input path is provided", () => {
    const prompt = buildPrompt(
      "再加个视频流",
      "历史上下文",
      "/tmp/result.json",
      "/tmp/skill-output",
      {
        userIntent: "再加个视频流",
        stage: "topology",
        fallbackDetails: Array.from({ length: 20 }, (_, index) => ({ id: `node-${index}` })),
      },
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
          {
            type: "tool_use",
            id: "write-1",
            name: "Write",
            input: { file_path: "/tmp/stage-result.json" },
          },
          {
            type: "tool_use",
            id: "edit-1",
            name: "Edit",
            input: { file_path: "src/agent/fake-agent.ts" },
          },
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
    const emptyTrace = extractOperationTraceEvents(
      {
        type: "stream_event",
        event: {
          content_block: {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: {},
          },
        },
      },
      toolUseNamesById,
    );
    const detailedTrace = extractOperationTraceEvents(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { file_path: "/tmp/skill-output/topology.json" },
            },
          ],
        },
      },
      toolUseNamesById,
    );

    expect(emptyTrace.map((trace) => trace.text)).toEqual([]);
    expect(detailedTrace.map((trace) => trace.text)).toEqual(["[文件] 读取 topology.json"]);
  });

  it("summarizes successful and failed tool results", () => {
    const toolUseNamesById = new Map([
      ["bash-1", "Bash"],
      ["write-1", "Write"],
    ]);
    const traces = extractOperationTraceEvents(
      {
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
              content:
                "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
            },
          ],
        },
      },
      toolUseNamesById,
    );

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
