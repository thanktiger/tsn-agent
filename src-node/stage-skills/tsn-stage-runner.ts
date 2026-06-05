/**
 * Plan v3 Phase B-β (PR-β1)：stage runner 已 stub 化。
 *
 * - 拓扑阶段：worker prompt 禁止调用 runner，结构化结果一律来自
 *   tsn_topology MCP 工具（sidecar 写 P0 表 + mutationId stage result）。
 * - 流量规划阶段：Phase B-α 已下线（UI 灰态 + adapter 本地拦截），
 *   legacy stage-skill-result.v0 协议与 canonical project 合成路径已删除。
 *
 * 文件保留是因为 build:worker 仍以本文件为 esbuild entry 产出
 * dist/tsn-stage-runner.mjs（Tauri build script 资源依赖）。Phase B 流量
 * 规划回归时按新 DB-domain 协议重写。
 */

export function runCli(): never {
  throw new Error(
    "tsn-stage-runner 已下线：拓扑阶段请使用 tsn_topology MCP 工具；流量规划阶段预计 Phase B 回归。",
  );
}

if (process.argv[1]?.includes("tsn-stage-runner")) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
