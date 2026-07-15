# 门控明细数据格式 v1（供 castup 求解器对接）

- 版本：v1（2026-07-14 定稿）
- 演进约定：**向后兼容新增列**——v1 之后只加列不改列不删列；破坏性变更升 v2 并另立文档
- 事实源：本文档描述的即 HIBridge Agent 库内实存格式（`src-tauri/src/db.rs` 的 FLOW_DOMAIN_SCHEMA_SQL）；castup 侧照此格式做返回，返回数据由我方 adapter 写入同样三张表（provider 区分）

## 总则

- **单位**：库内一切时间量为 **ns 整数（i64）**；展示层才格式化 μs。castup 返回若用其它单位，须在返回体中自行换算为 ns。
- **provider**：每行带 provider 字符串（我方 INET 求解器恒 `inet-z3`；castup 侧建议 `castup-<algorithm>` 形式）。同一工程不同 provider 的结果共存不覆盖。
- **门控周期（超周期）**：单周期制，全部窗口在 `[0, cycle_ns)` 内表达。

## 表 1：gcl_windows（逐窗明细，展示事实源）

每个「窗口」= 某端口八个队列门状态保持不变的一个连续时间段。

| 列 | 类型 | 语义 |
|---|---|---|
| session_id | TEXT | 工程 id |
| provider | TEXT | 求解器标识（进主键） |
| node | TEXT | 节点 mid |
| eth_n | INTEGER | 端口号（ethN，展示为 G{n}） |
| entry_idx | INTEGER | 窗口序号（同端口内 0 起，按 start_ns 升序） |
| start_ns | INTEGER | 窗口起点（ns，相对周期 0 点） |
| duration_ns | INTEGER | 窗口时长（ns）；同端口全部窗口须首尾相接且总和 = cycle_ns |
| gate_states | INTEGER | **q0-q7 位图**（0-255）：bit g = 1 表示 gate g 开。固定 8 位；节点实际队列数 < 8 时，超出 queue_count 的位按**恒开（1）**编码 |
| flow_refs | TEXT | JSON 数组 `[{"seq": <流序号>, "source": "solver"\|"derived"\|"class"}]`；该窗口放行的流。无关联流（空窗）为 NULL |

`flow_refs.source` 语义：`solver` = 求解器直接给出（castup 用这个）；`derived` = 我方确定性回算；`class` = 类级降级（无法唯一归属，仅知是 ST 类）。

主键 `(session_id, provider, node, eth_n, entry_idx)`。

## 表 2：gcl_plan_meta（规划级元数据，每 (工程, provider) 一行）

| 列 | 类型 | 语义 |
|---|---|---|
| status | TEXT | `ok`（有效规划）/ `no_gating`（纯 BE/RC 无需门控，windows 为空）——失败态不落表（保留上一次有效规划） |
| cycle_ns | INTEGER | 门控周期（超周期），ns |
| algorithm | TEXT | 算法标识（如 `Z3`；castup 填自己的 algorithm 名） |
| stale | INTEGER | 规划过期标记：流集/路径/拓扑变更后置 1，重新规划成功复位 0。castup 写入时恒 0 |
| created_at | TEXT | 生成时间 |

## 表 3：gcl_raw_archive（求解原文行存档）

| 列 | 类型 | 语义 |
|---|---|---|
| par_lines | TEXT | 求解器原始输出的关键行集（我方为 .sca par 行；castup 建议存原始响应 JSON 文本），覆盖式最新一份 |

**定位**：解析可重放的保险（改展示字段不必重跑求解）。**不随工程导出、不参与撤销**——导入方/撤销后重新规划即恢复。

## 流路径（flow_streams.paths 列，输入侧关联约定）

流表的 `paths` 列统一 JSON 形状（castup 求解时应消费此列作为路径约束）：

```json
{ "version": 1, "origin": "user" | "system",
  "routes": [ { "node_path": ["4","0","2","6"], "link_seqs": [0, 8, 14] } ] }
```

- `origin=user`：用户显式指定（恒 1 条）——**必须按此路径排程**，不可另选路。
- `origin=system`：系统推导凭证。RC 流恒 2 条（routes[0]=A 平面、routes[1]=B 平面，802.1CB 不相交双路径）。
- `NULL`：未指定——求解器可按最短路（我方语义：唯一最短路，等长多路径录入期已被拒绝或已被用户指定消歧）。
- `node_path` 为节点 mid 序列（含首尾），`link_seqs` 为拓扑链路序号序列（`topology_links.link_seq`）。

## castup 返回的最小要求

1. 每端口的完整窗口序列（首尾相接、总和=周期）+ 八位门状态位图 + 逐窗放行流列表（source=solver）
2. 规划级：status / cycle_ns / algorithm
3. 全部时间量 ns 整数
4. 显式路径（origin=user）与 RC 双路径必须遵守，不可改route
