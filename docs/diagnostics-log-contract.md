# 诊断日志契约

TSN Agent 的诊断日志用于排查本机会话中的 Claude 交互、会话状态写入和导出文件生成问题。它是应用工作台数据，不是项目交付产物。

## 写入范围

- `agent`：智能助手请求开始、resume 状态、流式输出摘要、完成和失败。
- `session`：会话创建、切换、复制、删除、pending save、final save 和保存失败。
- `artifact`：artifact bundle 生成或刷新，包含文件路径、用途和内容长度。
- `planner` / `session`：规划任务提交、轮询、停止、读取结果和失败摘要。当前实现复用 `session` 类别记录 plannerRun 摘要。
- `system`：预留给后续应用级诊断事件。

## 不写入内容

- Claude Code 凭证、本机密钥、API token。
- 环境变量原文、Claude 配置文件内容。
- 完整 prompt、完整 conversation context、raw stdout/stderr。
- 可从 canonical state 再生成的大体积缓存内容。
- 完整规划请求/响应大 JSON、`solution_json` 原文、`tsnlight_plan_cfg_json` 原文。

## 数据形态

每条日志至少包含：

- `sessionId`
- `category`
- `level`
- `message`
- `createdAt`

可选字段：

- `runId`
- `durationMs`
- `details`

`details` 只保存脱敏后的摘要，例如字符数、消息数、是否 resume、artifact 文件列表、错误摘要、plan id、state、duration、err_code、trace id、请求规模、结果 GCL 条数和 fingerprint 文件名。

## 保留与删除

- 日志按 session 归属。
- 前端 fallback 默认按 session 保留最近若干百条。
- 删除会话时同步删除该会话日志。
- 后续如果需要导出诊断包，必须由用户显式触发。

## 调试建议

- Claude 上下文问题：查看最近一次 `agent` 日志，确认 `runId`、是否 resume、context 摘要、first chunk 和最终模式。
- 左右界面不一致：查看 `session` 的 pending/final save 顺序，以及 `artifact` 的文件列表。
- 文件刷新问题：查看 `artifact` 日志中的路径、用途、内容长度和错误摘要。
- 规划任务问题：查看最近的规划任务日志，确认 Base URL、plan id、state、duration、err_code、错误摘要和是否生成 `planner/flow_plan_result_1.json` / `planner-gcl.json`。
