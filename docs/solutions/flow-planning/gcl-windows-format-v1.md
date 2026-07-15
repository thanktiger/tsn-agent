# 门控明细数据格式 v1（供 castup 求解器对接）

- 版本：v1（2026-07-14 定稿；2026-07-15 单表化修订——尚未对外交付，就地改 v1 不留 v2 包袱）
- 演进约定：**向后兼容新增列/新增 JSON 键**——v1 之后只加不改不删；破坏性变更升 v2 并另立文档
- 事实源：本文档描述的即 HIBridge Agent 库内实存格式（`src-tauri/src/db.rs` 的 FLOW_DOMAIN_SCHEMA_SQL 单表 `flow_gcl_plan` + `src-tauri/src/gcl_raw_store.rs` 的 raw 文件）；castup 侧照此格式做返回，返回数据由我方 adapter 写入同一张表（provider 区分）

## 总则

- **单位**：库内一切时间量为 **ns 整数**；展示层才格式化 μs。castup 返回若用其它单位，须在返回体中自行换算为 ns。
- **provider**：每行带 provider 字符串（我方 INET 求解器恒 `inet-z3`；castup 侧建议 `castup-<algorithm>` 形式）。同一工程不同 provider 的结果共存不覆盖。
- **门控周期（超周期）**：单周期制，全部窗口在 `[0, cycle_ns)` 内表达。

## 表：flow_gcl_plan（每 (工程, provider) 一行，整份门控结果）

窗口没有行级操作（写=全清全写、读=全量、筛选在前端），故窗口收进 JSON 列 `windows_json`；castup 返回填**单行**。

| 列 | 类型 | 语义 |
|---|---|---|
| session_id | TEXT | 工程 id |
| provider | TEXT | 求解器标识（进主键） |
| status | TEXT | `ok`（有效规划）/ `no_gating`（纯 BE/RC 无需门控，windows_json 为 `[]`）——失败态不落表（保留上一次有效规划） |
| cycle_ns | INTEGER | 门控周期（超周期），ns |
| algorithm | TEXT | 算法标识（如 `Z3`；castup 填自己的 algorithm 名） |
| stale | INTEGER | 规划过期标记：流集/路径/拓扑变更后置 1，重新规划成功复位 0。castup 写入时恒 0 |
| created_at | TEXT | 生成时间 |
| windows_json | TEXT | 逐窗数组 JSON（下节） |

主键 `(session_id, provider)`。

## windows_json：逐窗数组（展示事实源）

每个「窗口」= 某端口八个队列门状态保持不变的一个连续时间段。数组元素（camelCase 键）：

| 键 | 类型 | 语义 |
|---|---|---|
| node | string | 节点 mid |
| ethN | number | 端口号（ethN，展示为 G{n}） |
| entryIdx | number | 窗口序号（同端口内 0 起，按 startNs 升序） |
| startNs | number | 窗口起点（ns，相对周期 0 点） |
| durationNs | number | 窗口时长（ns）；同端口全部窗口须首尾相接且总和 = cycle_ns |
| gateStates | number | **q0-q7 位图**（0-255）：bit g = 1 表示 gate g 开。固定 8 位；节点实际队列数 < 8 时，超出 queue_count 的位按**恒开（1）**编码 |
| flowRefs | string \| null | JSON 数组**串** `[{"seq": <流序号>, "source": "solver"\|"derived"\|"class"}]`；该窗口放行的流。无关联流（空窗）为 null |

`flowRefs.source` 语义：`solver` = 求解器直接给出（castup 用这个）；`derived` = 我方确定性回算；`class` = 类级降级（无法唯一归属，仅知是 ST 类）。

示例：

```json
[
  { "node": "0", "ethN": 1, "entryIdx": 0, "startNs": 0, "durationNs": 4560,
    "gateStates": 128, "flowRefs": "[{\"seq\":0,\"source\":\"derived\"}]" },
  { "node": "0", "ethN": 1, "entryIdx": 1, "startNs": 4560, "durationNs": 995440,
    "gateStates": 127, "flowRefs": null }
]
```

## raw 存档：文件 `<app数据目录>/gcl-raw/<session_id>-<provider>.par`

求解器原始输出的关键行集出库为纯文本文件（不留库列、路径确定性派生）：

- 我方 INET 求解器存 `.sca` par 行；**castup 建议存原始响应 JSON 文本**（同一文件、覆盖式最新一份）。
- **定位**：解析可重放的保险（verify pin 重放的事实源；改展示字段不必重跑求解）。
- **不随工程导出、不参与撤销**——导入方/撤销后重新规划即恢复；文件缺失时 verify 响亮报无规划。

## 流路径（flow_streams.paths 列，输入侧关联约定）

流表的 `paths` 列统一 JSON 形状（castup 求解时应消费此列作为路径约束）：

```json
{ "version": 1, "origin": "user" | "system",
  "routes": [ { "node_path": ["4","0","2","6"], "link_seqs": [0, 8, 14] } ] }
```

- `origin=user`：用户显式指定（恒 1 条）——**必须按此路径排程**，不可自动变更；失效响亮报 PATH_STALE。
- `origin=system`：系统沉淀凭证（录入时推导落库、规划期复验，拓扑变更后失效即静默重推导并自动刷新）。ST/BE 恒 1 条；RC 流恒 2 条（routes[0]=A 平面、routes[1]=B 平面，802.1CB 不相交双路径）。
- `NULL`：未沉淀（历史存量）——求解器可按最短路（我方语义：唯一最短路，等长多路径在录入期已被拒绝或已由用户指定消歧；存量 NULL 流规划一次即回写沉淀为 system 凭证）。
- `node_path` 为节点 mid 序列（含首尾），`link_seqs` 为拓扑链路序号序列（`topology_links.link_seq`）。

## castup 返回的最小要求

1. 每端口的完整窗口序列（首尾相接、总和=周期）+ 八位门状态位图 + 逐窗放行流列表（source=solver）——填进单行的 `windows_json`
2. 规划级：status / cycle_ns / algorithm（同一行的 meta 列）
3. 全部时间量 ns 整数
4. 显式路径（origin=user）与 RC 双路径必须遵守，不可改route
