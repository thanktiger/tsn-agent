# TSN 门控规划结果数据格式 v1（castup 求解器对接规范）

- 交付方：HIBridge Agent 项目组
- 版本：v1（2026-07-15）
- 演进约定：**向后兼容新增**——v1 之后只加不改不删（新增列、新增 JSON 键）；破坏性变更升 v2 并另立文档
- 适用范围：castup 调度规划求解器与 HIBridge Agent 的门控结果对接。castup 按本格式返回规划结果，由 HIBridge Agent 侧 adapter 写入本地存储（以 provider 字段区分来源，与内置求解器结果共存）

## 1. 总则

- **单位**：一切时间量为 **ns 整数**；展示层才格式化为 μs。castup 返回若内部使用其它单位，须在返回体中自行换算为 ns。
- **provider**：每份结果带 provider 字符串标识产出方。HIBridge Agent 内置求解器恒为 `inet-z3`；castup 侧建议 `castup-<algorithm>` 形式。同一工程不同 provider 的结果共存、互不覆盖。
- **门控周期（超周期）**：单周期制，全部窗口在 `[0, cycle_ns)` 内表达。

## 2. 规划结果主体（每（工程, provider）一份）

一份完整规划结果 = 若干 meta 字段 + 一个逐窗数组。castup 返回填**单份**：

| 字段 | 类型 | 语义 |
|---|---|---|
| session_id | string | 工程 id |
| provider | string | 求解器标识（与 session_id 共同构成唯一键） |
| status | string | `ok`（有效规划）/ `no_gating`（流集为纯 BE/RC 无需门控，windows_json 为 `[]`）。失败态不产出结果（接收方保留上一次有效规划） |
| cycle_ns | integer | 门控周期（超周期），ns |
| algorithm | string | 算法标识（castup 填自己的 algorithm 名，如 `castup-smt`） |
| created_at | string | 生成时间 |
| windows_json | JSON 数组 | 逐窗数组（第 3 节） |

## 3. windows_json：逐窗数组

每个「窗口」= 某端口八个队列门状态保持不变的一个连续时间段。数组元素（camelCase 键）：

| 键 | 类型 | 语义 |
|---|---|---|
| node | string | 节点 mid（HIBridge Agent 拓扑中的节点标识） |
| ethN | number | 端口号（ethN，界面展示为 G{n}） |
| entryIdx | number | 窗口序号（同端口内 0 起，按 startNs 升序） |
| startNs | number | 窗口起点（ns，相对周期 0 点） |
| durationNs | number | 窗口时长（ns）；**同端口全部窗口须首尾相接且总和 = cycle_ns** |
| gateStates | number | **q0–q7 位图**（0–255）：bit g = 1 表示 gate g 开。固定 8 位；节点实际队列数 < 8 时，超出实际队列数的位按**恒开（1）**编码 |
| flowRefs | string \| null | JSON 数组**串** `[{"seq": <流序号>, "source": "solver"}]`，该窗口放行的流；无关联流（空窗）为 null |

`flowRefs.source` 取值语义：`solver` = 求解器直接给出（**castup 用这个**）；`derived` / `class` 为 HIBridge Agent 内置链路的回算/降级标记，castup 无需使用。

示例：

```json
[
  { "node": "0", "ethN": 1, "entryIdx": 0, "startNs": 0, "durationNs": 4560,
    "gateStates": 128, "flowRefs": "[{\"seq\":0,\"source\":\"solver\"}]" },
  { "node": "0", "ethN": 1, "entryIdx": 1, "startNs": 4560, "durationNs": 995440,
    "gateStates": 127, "flowRefs": null }
]
```

## 4. 原始输出存档（raw）

求解器原始输出会作为纯文本文件存档一份（覆盖式，仅保留最新）：**castup 建议直接存原始响应 JSON 文本**。用途是解析可重放的保险——展示字段变更时不必重跑求解。该存档不随工程导出。

## 5. 流路径约束（输入侧，castup 求解时必须消费）

流表的 `paths` 字段是路径凭证，JSON 形状为**裸数组**：

```json
[ { "node_path": ["4", "0", "2", "6"], "link_seqs": [0, 8, 14] } ]
```

- **语义**：有效凭证即**必须按此路径排程**——用户指定的绕路在拓扑不变时稳定沿用，求解器不可改 route。
- **条数**：ST / BE 流恒 1 条；RC 流恒 2 条（`[0]` = A 平面、`[1]` = B 平面，802.1CB FRER 不相交双路径）。
- **`null` / 缺失**：该流未沉淀凭证（历史存量），求解器可按唯一最短路处理（等长多路径在录入期已被拒绝或已由用户消歧）。
- `node_path` 为节点 mid 序列（含首尾端系统）；`link_seqs` 为拓扑链路序号序列。

## 6. castup 返回的最小要求（checklist）

1. 每端口完整窗口序列（首尾相接、总和 = cycle_ns）+ 八位门状态位图 + 逐窗放行流列表（source=`solver`）——填进 `windows_json`
2. 规划级 meta：status / cycle_ns / algorithm
3. 全部时间量为 ns 整数
4. 有效路径凭证与 RC 双路径必须遵守，不可改 route
