# TSN 拓扑生成 — 业务规则参考

> **用途**：供 `tools/topology-builder.js`、`tools/validate-topology.js`、`tools/validate-mac-forwarding-table.js` 与 `SKILL.md` 参照。
> **范围**：覆盖 `topology.json`、`topo_feature.json`、`data-server.json` 与 `mac-forwarding-table.json` 四份 JSON。
> **来源**：代码（FormModal / index.jsx / converter）+ 真实样例（`project1225/`）。

---

## 1. 节点类型

### 1.1 枚举与显示名映射

| `node_type` | 中文名 | 缩写前缀 | `_classPath` (in `sync_type`) |
|---|---|---|---|
| `switch` | 交换机 | `SW` | `Q.Graphs.exchanger2` |
| `networkcard` | 端系统 | `ES` | `Q.Graphs.node` |
| `server` | 控制器 | `PC` | `Q.Graphs.server` |

> 首期**排除** `T10` 类型（无金标准 fixture）。
> 在 TSN Agent 产品语义中，用户说的“网卡”“端系统”“端”都映射为 `networkcard`。不要把“网卡8/网卡9”理解成交换机端口或网卡接口，它们是新增的端系统节点。

**来源**：
- 节点类型与中文映射：`src/components/Topology/nodeFormModal.js:25-30`
- `_classPath` 对应：`project1225/topology.json` 与 `project1225/data-server.json` 横向比对得出
- 缩写前缀：`project1225/node.json` 节点 0/1/2/10 → ES0/SW0/ES1/PC0

### 1.2 默认值（topology.json 不直接用，但 builder 应保留以备后续派生）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `queue_num` | 8 | 队列数 (范围 1-8) |
| `buffer_num` | 3 | 队列长度 (范围 1-2048) |
| `port_count` | `switch:32, networkcard:1, server:6` | 端口数量 (范围 1-256) |

**来源**：`src/components/Topology/nodeFormModal.js:144-170`

### 1.3 字段集（按节点类型差异）

仅在 `data-server.json` 的 `Q.Node` 里有差异；**`topology.json` 里所有节点类型字段集相同**（`imac` / `sync_name` / `x` / `y` / `sync_type` / `node_type`）。

builder 生成 `data-server.json` 时按 §6.5 的节点类型字段子集输出。

---

## 2. ID 体系（多套并存）

| ID | 类型 | 出现位置 | 含义 |
|---|---|---|---|
| **`node_id`** (= `sync_name` 的数值) | int | builder 内部、`topo_feature.src_node/dst_node`、`topology.sync_name` 字符串化 | 节点的逻辑主键，从 `node_id_base`（默认 0）起递增 |
| **`imac`** | int | `topology.nodes[].imac`、`topology.links[].imac`、`topology.links[].addr` | 节点的物理标识，从 `imac_base`（默认 100）起递增。**首期不与 `node_id` 派生关联** |
| **`display_name`** | str | builder 内部 + 报告 | `<前缀><同类型序号>`，如 `ES0` / `SW0` / `PC0`（参见 1.1 表）。**全文件唯一** |

> **关键约束**：
> - `imac` 全文件唯一
> - `sync_name` 全文件唯一
> - `display_name` 全文件唯一
> - 同一节点的不同端口（在边里出现的 `leftLabel` / `rightLabel`）不重复

**来源**：
- ID 三套并存的事实：`project1225/topology.json`（imac=171/177/183/213, sync_name="0"/"1"/"2"/"10"）vs `project1225/topo_feature.json`（src_node=0/1/2 数值）
- imac 在 Qunee 库里是节点内部 ID：`src/components/Topology/index.jsx:1162`（`item.src_imac = id`）
- display_name 唯一性：`src/components/Topology/nodeFormModal.js:194-211`

---

## 3. MAC / IP 派生公式

**基于 `node_id`（即 `sync_name` 的数值）**，不是 `imac`。

```
high_byte = (node_id >> 8) & 0xff
low_byte  = node_id & 0xff

mac_address = "00:00:23:00:" + hex2(high_byte) + ":" + hex2(low_byte)   // 全大写
ip          = "192.168."     + high_byte       + "."  + low_byte
```

其中 `hex2(x)` 是 2 位 16 进制零填充（如 `0 → "00"`、`10 → "0a"`、`255 → "ff"`）。

| node_id | MAC | IP |
|---|---|---|
| 0 | `00:00:23:00:00:00` | `192.168.0.0` |
| 1 | `00:00:23:00:00:01` | `192.168.0.1` |
| 2 | `00:00:23:00:00:02` | `192.168.0.2` |
| 256 | `00:00:23:00:01:00` | `192.168.1.0` |

**注**：这些字段在 `topology.json` 中**不直接出现**（只在 `data-server.json` 的 `Q.Node` 里），但 builder 内部生成节点对象时应同时算出，供未来扩展或调试。

**来源**：`src/components/Topology/nodeFormModal.js:152-159`

---

## 4. 链路速率

| `speed` | 标签 | 备注 |
|---|---|---|
| 10 | 10M | |
| 100 | 100M | |
| 1000 | 1000M (千兆) | 最常用 |
| 10000 | 10000M (万兆) | |

`speed` 是整数 Mbps，**不允许任意值**。

**来源**：`src/components/Topology/edgeFormModal.js:48-53`

---

## 4.1 通用分布式拓扑默认互联

当用户说“N 个交换机，每个交换机连接 M 个端系统/网卡/端”或“X 个端系统分配到 N 台交换机”时，除非用户明确说交换机相互独立、不互联或不连接，否则交换机必须默认线型互联：

```text
SW1 -- SW2 -- SW3 -- ... -- SWN
```

链路生成规则：

1. 先生成每台交换机下挂的端系统接入链路。
2. 再生成相邻交换机互联链路，共 `N-1` 条。
3. 交换机互联端口必须避开已被端系统占用的端口。

默认链路数：

```text
total_links = switch_count * endpoints_per_switch + (switch_count - 1)
```

示例：“4 个交换机，每个交换机连接 5 个端系统”应生成：

- 4 个 `switch`
- 20 个 `networkcard`
- 20 条端系统接入链路
- 3 条交换机线型互联链路
- 合计 23 条物理链路

只有用户明确要求“4 台交换机相互独立”“交换机之间不互联”“每台交换机单独成星型”等语义时，才允许省略交换机互联链路。

---

## 5. `topology.json` 字段契约

**根对象**：

```json
{
  "node": {
    "nodes": [ /* Node 数组，见 5.1 */ ],
    "links": [ /* Link 数组，见 5.2 */ ]
  },
  "refs": {}
}
```

`refs` 始终是空对象 `{}`（首期，可能用于未来扩展）。

### 5.1 Node 对象

```json
{
  "imac": <int>,
  "sync_name": "<str, node_id 字符串化>",
  "x": <int>,
  "y": <int>,
  "sync_type": { "_classPath": "Q.Graphs.<node|exchanger2|server>" },
  "node_type": "<switch|networkcard|server>"
}
```

**Canonical key 顺序**：`imac → sync_name → x → y → sync_type → node_type`

### 5.2 Link 对象

```json
{
  "name": "<src_sync_name>:<src_port>-<dst_sync_name>:<dst_port>",
  "styles": {
    "leftLabel": "<src_port, 字符串>",
    "rightLabel": "<dst_port, 字符串>",
    "speed": <int, 见第 4 节>
  },
  "imac": <src_imac>,
  "addr": <dst_imac>
}
```

**Canonical key 顺序**：`name → styles → imac → addr`；`styles` 内部 `leftLabel → rightLabel → speed`

> ⚠️ Link 里的 `imac` / `addr` 是 **端点节点的 imac 值**，不是 link 自身 ID。
> 命名 "addr" 是历史遗留；语义是 "destination imac"。

**来源**：`project1225/topology.json` + `src/components/Topology/index.jsx:1174-1180`

---

## 6. `topo_feature.json` 字段契约

**根对象**：一个**有向边数组**（不是带 `links` key 的对象）。

```json
[
  {
    "link_id": <int>,
    "src_node": <int, = src 节点的 node_id>,
    "src_port": <int>,
    "dst_node": <int, = dst 节点的 node_id>,
    "dst_port": <int>,
    "speed": <int, 见第 4 节>,
    "st_queues": 3
  }
]
```

**Canonical key 顺序**：`link_id → src_node → src_port → dst_node → dst_port → speed → st_queues`

### 6.1 双向规则

每条物理链路 → 2 条有向边（forward + reverse），`link_id` 顺序递增从 0 起：

| 物理链路索引 N | forward `link_id` | reverse `link_id` |
|---|---|---|
| 0 | 0 | 1 |
| 1 | 2 | 3 |
| 2 | 4 | 5 |
| ... | 2N | 2N+1 |

forward 用物理链路定义的 src→dst；reverse 是反向（src 与 dst 互换、src_port 与 dst_port 互换）。

### 6.2 `st_queues`

固定为 **3**（首期）。来自 converter 默认逻辑：`queueNumMap[src_imac] || 3`。

### 6.3 server 节点的特殊处理

母项目 converter `convertDataToTopoFeature` (`src/main/ipc-handlers/util.ts:189-190`) **跳过** `src_type` 或 `dst_type` 是 `server` 的边：

```js
const ok = ['switch', 'networkcard', 'T10'];
if (!ok.includes(srcType) || !ok.includes(dstType)) continue;
```

**首期 builder 必须遵守此规则**：连接到 `server` 节点的链路在 `topology.json` 里出现，但在 `topo_feature.json` 里**不出现**（因为规划器不为 server 节点排程）。

**来源**：`src/main/ipc-handlers/util.ts:140-232`

---

## 6.5 `data-server.json` 字段契约（Qunee 拓扑图工具用，demo 展示）

**根对象**：

```json
{
  "version": "2.0",
  "refs": {},
  "datas": [ /* Q.Node 在前 + Q.Edge 在后, 见下 */ ],
  "scale": 1
}
```

Canonical key 顺序：`version → refs → datas → scale`。`datas` 数组：所有 `Q.Node`（按 `json.name` 数值升序）先于所有 `Q.Edge`（按 link 输入顺序）。

### 6.5.1 Q.Node（按 node_type 字段子集不同）

**switch / networkcard**（完整字段）：

```json
{
  "_className": "Q.Node",
  "json": {
    "name": "<node_id 字符串>",
    "location": { "_className": "Q.Point", "json": { "x": int, "y": int, "rotate": 0 } },
    "image": { "_classPath": "Q.Graphs.<node|exchanger2>" }
  },
  "id": <src_imac>,
  "src_imac": <int>,
  "display_name": "<str>",
  "node_type": "<switch|networkcard>",
  "buffer_num": 8,
  "queue_num": 3,
  "mac_address": "<str, 派生公式 §3>",
  "ip": "<str, 派生公式 §3>",
  "port_count": <switch:4 | networkcard:1>
}
```

**server**（字段子集，仅 6 个键 — 与 `project1225/data-server.json` 实测一致）：

```json
{
  "_className": "Q.Node",
  "json": { /* 同上 */ },
  "id": <src_imac>,
  "src_imac": <int>,
  "display_name": "<str>",
  "node_type": "server"
}
```

server 节点**不输出** `buffer_num / queue_num / mac_address / ip / port_count`。母项目 nodeFormModal `isServerNode` 路径同样隐藏这些字段（仅 3 个表单字段）。

### 6.5.2 Q.Edge

```json
{
  "_className": "Q.Edge",
  "json": {
    "name": "<src_name>:<src_port>-<dst_name>:<dst_port>",
    "from": { "_ref": <src_imac> },
    "to":   { "_ref": <dst_imac> },
    "styles": { "leftLabel": "<src_port>", "rightLabel": "<dst_port>", "speed": <int> }
  },
  "id": <int, 紧接 Q.Node imac 段递增>,
  "bindingUIs": [ /* 2 个 LabelUI 模板 — 渲染左/右端口标签, 见 §6.5.3 */ ]
}
```

Q.Edge `id` 分配：`imac_base + nodes.length + edge_index`（与 Q.Node imac 段连续）。

### 6.5.3 bindingUIs 模板（每条 Q.Edge 固定结构）

```json
[
  {
    "ui": {
      "_className": "Q.LabelUI",
      "json": {
        "$position":       { "horizontalPosition": "l", "verticalPosition": "b" },
        "$anchorPosition": { "horizontalPosition": "l", "verticalPosition": "b" },
        "$offsetX": 10,
        "$font": "normal 12px Verdana,helvetica,arial,sans-serif",
        "data": "<src_port>"
      }
    },
    "bindingProperties": {
      "bindingProperty": "data",
      "property": "leftLabel",
      "propertyType": 1,
      "target": {}
    }
  },
  {
    "ui": { /* 同上, 但 $position/$anchorPosition 用 "r", $offsetX = -10, data = <dst_port>, property = "rightLabel" */ }
  }
]
```

LabelUI 是 Qunee 渲染端口数字标签的位置/字体元数据。`$offsetX = +10` 配 `position l`、`-10` 配 `position r`。`data` 字段是要显示的端口号字符串。

### 6.5.4 默认值策略备注

字段默认值（`buffer_num=8 / queue_num=3 / port_count=4 (switch) / port_count=1 (networkcard)`）跟随 `project1225/data-server.json` 实测，**不是** `nodeFormModal.js` 的表单默认（后者是 `queue_num=8 / buffer_num=3 / port_count=32 (switch)`，给 GUI"新建节点"时的初值用）。

理由：data-server.json 是 Qunee 已加载并保存过的状态，跟金标准对齐能保证 Qunee 可重渲染；如果跟随表单默认，是"用户新建但还未微调"的初值。

---

## 6.6 `mac-forwarding-table.json` 字段契约（标准 MAC 转发表）

`mac-forwarding-table.json` 是 MAC 转发表的 canonical source。迁移后的拓扑路径不再生成转发表 HTML。

**根对象**：

```json
{
  "version": "1.0",
  "entries": [ /* 见下 */ ]
}
```

Canonical key 顺序：`version → entries`。`entries` 按 `switch_node` 升序，再按 `destination_node` 升序排列。

### 6.6.1 Entry 对象

```json
{
  "switch_node": <int, 交换机 node_id>,
  "switch_imac": <int, 交换机 imac>,
  "switch_name": "<str, display_name>",
  "destination_node": <int, 目的节点 node_id>,
  "destination_imac": <int, 目的节点 imac>,
  "destination_mac": "<str, 见第 3 节 MAC 派生公式>",
  "destination_name": "<str, display_name>",
  "egress_port": <int, 交换机出端口>
}
```

Canonical key 顺序：`switch_node → switch_imac → switch_name → destination_node → destination_imac → destination_mac → destination_name → egress_port`。

### 6.6.2 静态转发表派生规则

- 只为 `node_type = "switch"` 的节点生成转发表项。
- 对每个交换机，遍历所有可达的其他节点；不可达目的节点不生成 entry。
- 每个 entry 表示标准 MAC 转发表记录：`destination_mac -> egress_port`，附带 node/imac/display_name 字段供 validator 核对。
- `destination_mac` 基于目的节点 `node_id` 用 §3 公式派生，不基于 `imac`。
- `egress_port` 是从该交换机出发到目的节点的确定性最短路径 first hop 所使用的交换机端口；直接相连目的节点使用直连链路上的交换机端口。
- 转发表 entry 数量按可达目的 MAC 计算，不按交换机已连接端口数计算；多个目的 MAC 可以共用同一个 `egress_port`。
- 等长路径 tie-break 按 builder 的 canonical 顺序：节点 ID 升序、端口升序。
- 无交换机拓扑输出空 `entries` 数组。

## 7. 坐标布局规则

所有坐标整数，整数像素。

### 7.1 LLM 建议坐标

LLM 可以在 `nodes[]` 中为任意节点给出 `x` 和 `y`：

- `x`/`y` 必须成对出现，且必须是有限数字。
- builder 会把坐标四舍五入为整数。
- 已给出合法 `x`/`y` 的节点使用 LLM 建议坐标。

### 7.2 默认通用拓扑布局

未给出 `x`/`y` 的节点使用 TSN Agent 通用拓扑布局。该布局用于保证 skill 输出与 App 原生通用拓扑一致，不再根据 `star`、`bus`、`ring`、`tree` 等 layout 名称切换坐标算法。

交换机按 `node_id` 升序横向排列：

```
第 i 个交换机 (i 从 0 开始):
  x = 80 + 300 * i
  y = 220
```

端系统 / server 按其主连接交换机分组。若一个非交换机节点连接多台交换机，主连接交换机取 `node_id` 最小的那台交换机。每组内按 `node_id` 升序排列：

```
第 hostIndex 个端系统 (hostIndex 从 1 开始):
  y = hostIndex 为偶数 ? 390 : 70
  x = switchX + (hostIndex - ceil(groupSize / 2)) * 62
```

没有连接到任何交换机的非交换机节点放在备用行：

```
x = 80 + 160 * index
y = 520
```

如果拓扑中没有交换机，则所有节点横向排列：

```
x = 80 + 160 * index
y = 220
```

### 7.3 连接形态表达

星型、总线、环形、树形等拓扑形态必须通过 `links` 表达，不再通过 `layout` 字段表达。builder 会忽略旧输入中的 `layout` 字段，不会根据它改变坐标。

---

## 8. 中间表示（LLM → builder 的契约）

LLM 解析 NL 后输出，builder 输入：

```json
{
  "nodes": [
    {
      "node_id": <int, 必填>,
      "node_type": "<switch|networkcard|server, 必填>",
      "display_name": "<str, 可选; 缺省时按 1.1 前缀 + 同类型序号自动>",
      "x": <number, 可选; 与 y 成对出现>,
      "y": <number, 可选; 与 x 成对出现>
    }
  ],
  "links": [
    {
      "src": <int, src 节点 node_id, 必填>,
      "src_port": <int, 必填>,
      "dst": <int, dst 节点 node_id, 必填>,
      "dst_port": <int, 必填>,
      "speed": <int, 必填, 见第 4 节>
    }
  ],
  "imac_base": <int, 可选, 默认 100>,
  "node_id_base": <int, 可选, 默认 0; 建议 LLM 直接给 nodes[].node_id 而不靠 base 推>
}
```

- **`node_id` 必须由 LLM 显式给出**（不让 builder 自动分配，避免歧义）。
- **`display_name` 自动规则**：按类型分别从 0 起递增。例如 2 个 networkcard + 1 个 switch → `ES0`, `ES1`, `SW0`。
- **`x`/`y` 可选**：如果 LLM 能给出更合理的视觉位置，可以填写；否则省略，由 builder 使用 TSN Agent 通用拓扑布局。
- **双归属 networkcard 端口规则**：同一个 `networkcard` 接两台交换机时，两条物理链路必须使用不同的 `src_port`，通常第一条用 `0`、第二条用 `1`。例如网卡 8 同时接交换机 3 和交换机 4，应写成 `{"src": 8, "src_port": 0, "dst": 3, ...}` 与 `{"src": 8, "src_port": 1, "dst": 4, ...}`，不能两条都用 `src_port: 0`。

---

## 9. 校验清单

### 9.1 validator 必须覆盖（topology.json + topo_feature.json）

| 检查项 | kind | 错误示例 |
|---|---|---|
| JSON 语法合法 | io | 缺括号、非法 JSON |
| 每个节点 `node_type ∈ {switch, networkcard, server}` | schema | `node_type = "router"` |
| `_classPath` 与 `node_type` 匹配 | consistency | switch 节点用 `Q.Graphs.node` |
| `imac` 全文件唯一 | consistency | 两个节点都 `imac=100` |
| `sync_name` 全文件唯一 | consistency | 两个节点都 `sync_name="0"` |
| 每条 link 的 `imac` (src) 引用存在的节点 | reference | link 引用 `imac=999`，没这个节点 |
| 每条 link 的 `addr` (dst) 引用存在的节点 | reference | 同上 |
| `link.name` 拼接与端口/sync_name 一致 | consistency | name='wrong:0-0:0' 不匹配实际 |
| 端口字段是数字字符串 | schema | `leftLabel="abc"` |
| 单节点端口在所有边里不重复 | consistency | 节点 0 的 port 0 出现在 2 条 link 里 |
| `speed ∈ {10, 100, 1000, 10000}` | schema | `speed=999` |
| topo_feature 边数 = (topology 链路数 - 含 server 链路数) × 2 | consistency | 数量对不上 |
| topo_feature 每条边 `src_node/dst_node` 是合法 `node_id` | reference | 引用不存在 node_id |
| topo_feature 每条物理边的 forward + reverse 都存在 | consistency | 只有正向、缺反向 |
| topo_feature 每条边 `st_queues = 3` | schema | 其他值 |
| topo_feature 链路自环 (src_node == dst_node) | consistency | — |
| topo_feature `link_id` 不重复 | consistency | — |

### 9.2 builder 内部强制（中间表示 → topology/topo_feature 之间）

下列规则只在 builder `validateIntermediate` 中校验（输入侧），最终 `topology.json` 不含相应字段，validator 无法事后检查：

| 检查项 | 说明 |
|---|---|
| `display_name` 全局唯一 | `topology.json` 不输出 display_name；builder 派生时确保不重复，冲突 → throw |
| `node_id ∈ [0, 65535]` | 超界会让 MAC 派生静默回绕，必须在 builder 输入侧拦截 |
| `imac_base ∈ [0, 65535]` | 非整数会让 imac 变字符串拼接 |
| 节点数 ≤ 1024 / 链路数 ≤ 4096 | 防 DoS |
| port ∈ [0, 65535] 整数 | 防负 port 与浮点 |
| link 不允许自环 (src == dst) | 中间表示侧拒绝 |
| `node_id` / `display_name` 在 nodes 数组中唯一 | builder 抛错 |
| MAC 派生符合公式 | 由 builder 内部纯函数保证；`topology.json` 本身不带 MAC |

### 9.3 MAC 转发表 validator 必须覆盖（topology.json + mac-forwarding-table.json）

| 检查项 | kind | 错误示例 |
|---|---|---|
| JSON 语法合法 | io | 缺括号、非法 JSON |
| 顶级对象 `version = "1.0"` 且 `entries` 是数组 | schema | `entries` 缺失 |
| entry 必填字段齐全且类型正确 | schema | `egress_port` 是字符串 |
| `switch_node` 引用存在且节点类型是 `switch` | reference | 指向 networkcard |
| `switch_imac` 与 topology 对应节点一致 | consistency | switch_node=1 但 switch_imac 错 |
| `destination_node` 引用存在 | reference | 目的节点不存在 |
| `destination_imac` 与 topology 对应节点一致 | consistency | destination_imac 错 |
| `destination_mac` 与 §3 公式一致 | consistency | MAC 拼错或大小写错误 |
| `(switch_node, destination_node)` 不重复 | consistency | 同一目的重复两条 |
| `egress_port` 是该 switch 的已连接端口 | consistency | switch 没有 port 99 |

---

## 10. 命名约定与历史包袱（agent 应注意但不模仿）

- **server 节点在 `project1225` 用了 `sync_name="10"`** 而非顺延的 "3"。这是历史包袱，首期 builder **不沿用**，按 `node_id_base` 起顺序分配
- **imac 段 171/177/183/213** 是 Qunee 旧实例分配的，首期 builder 用 100 起的连续段，可读性更好
- `topology.json` 的 `links[].name` 中端口号是字符串（`"0"`），但 `topo_feature.json` 的 `src_port`/`dst_port` 是 int（`0`）—— 两份文件类型不一致是事实
- `topology.json` 的 `links[].styles.leftLabel/rightLabel/speed` 中 `speed` 是 int，`leftLabel`/`rightLabel` 是 str

---

## 11. 不涵盖（rules.md 之外的规则）

- 节点配置（GCL / OSS / FWD / MAP / INJECT / INFORM）—— 后续 skill
- 母项目 GUI 写盘细节 —— 本 skill 只生成项目文件，不改 Electron 应用
- `project.json` 格式 —— 来自外部 xz-nos API，agent 不接管
- T10 节点类型 —— 首期排除
- Qbu/Qci/CB 等高级特性 —— 远期
