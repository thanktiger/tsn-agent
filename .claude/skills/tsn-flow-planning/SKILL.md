---
name: tsn-flow-planning
description: TSN Agent 流量规划阶段占位指引。流量规划在当前版本暂时下线，预计随 Phase B 在 DB-backed 路径上重建。
---

# TSN Flow Planning Skill（暂下线占位）

流量规划（stable stage id：`flow-template`）在当前版本暂时下线：旧的 stage runner / `stage-skill-result.v0` 协议与 canonical project 表示已删除，Phase B 会在工程数据库（SQLite P0 表 + sidecar）路径上重建本阶段。

## 当前行为边界

- 应用层（agent-adapter）在流量规划阶段本地拦截用户输入，不会把该阶段路由给模型；本 skill 仅作为占位保留。
- 如果仍被询问流量规划相关内容：用中文说明该功能暂时下线、预计 Phase B 回归，不要尝试生成流量规划结果或结构化 JSON。
- 不要声称导出文件、规划器输出或仿真执行已经完成。
