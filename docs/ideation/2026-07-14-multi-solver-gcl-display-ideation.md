# 多求解器接入 + 门控详情三视图：数据层差距分析与方向清单

- 日期：2026-07-14
- 焦点：以现有 INET Z3 求解器为基准，接入外部 HTTP 求解器（castup 接口文档），并实现门控详情三视图展示（门控可视化甘特 / 流量维度窗口链 / 门控表全列 + q0-q7 位图 + Excel 导出）
- 方法：ce-ideate，6 框架并行生成 37 个想法 → 聚类去重 → 批判筛选出 7 个方向
- Grounding：castup 接口文档全文抓取 + 代码扫描（flow_plan_command/db/flow_query_command/flow_route/inet-sim-http）+ docs/solutions 契约（.sca dump 唯一路径 / 三态语义 / guard band）+ 外部生态调研（TSNsched/Chameleon/INET 配置器/TTEthernet/Reusch 公式）

## 先回答 boss 的三个问题

### 问题 1：HTTP 接口有哪些字段需要更新、哪些结构需要改变？

**输入侧：零新增采集。** 逐字段盘点 castup `plan_input`：

| castup 输入字段 | 我们的数据源 | 状态 |
|---|---|---|
| topology_nodes.mid/node_name/node_type | topology_nodes 表 | ✓ 直接有 |
| topology_nodes.ip/mac | flow_streams v1.1.0 新列的推导规则（MAC=00:00:23:00:00:{mid}、IP=192.168.0.{mid+1}） | ✓ 同一推导函数复用 |
| topology_links.link_id/src/dst/port/speed | topology_links 表 | ✓ 直接有 |
| flows.stream_id/name/pcp/size | flow_streams（name 是 v1.1.0 新列） | ✓ 直接有 |
| flows.period(ms)/latency(ms)/jitter(ms) | period_us/max_latency_us/jitter_ns | ✓ 换单位即得 |
| flows.redundant/paths[].route（link_id 序列） | derive_route/derive_redundant_routes 的 Route.link_seqs | ✓ 现成，RC 双路径正好填多 paths |

唯一要写的是一个 link_seq↔link_id、(node,ethN)↔端口 的双向映射工具（topology_links 已含全部素材），它同时服务输出侧展示换算。**不需要动任何录入表、不需要用户多填一个字段。**

**输出侧：现有 flow_plans 表装不下，需要新结构。** castup 返回 `schedules[]`（link_id + gcl_entries[]{interval(μs), state 八队列位图 "0b001", stream_id[] 逐窗流关联}）——而 flow_plans 现状是 stream_seq 恒 0、只存 ST 门 gate7、durations 交替 JSON，存 castup 输出等于有损压缩（丢位图、丢流关联、丢空窗）。见方向 1。

### 问题 2：数据层两个求解器是否都满足三视图展示？

| 展示元素 | castup HTTP | INET Z3 现状 | 结论 |
|---|---|---|---|
| q0-q7 八队列位图（视图1悬浮卡/视图3圆点） | ✓ state 直接给 | ✗ 只入库了 gate7 单门 | INET 可补：.sca 原始输出**有全门调度，是解析时丢弃的**，改解析即可（方向 3） |
| 逐窗关联流（F1/F3 徽章） | ✓ stream_id[] 直接给 | ✗ stream_seq 恒写 0 | INET 需确定性回算（读 .sca 每流偏移，需一次 spike 验证；失败降级到「ST 类」级并标注）（方向 3） |
| 空窗行（视图3「空窗」） | ✓ state=0b000 条目 | 交替序列隐式含有 | 展示层可补，无数据缺口 |
| 端口 G{n} 标注 | link_id→端口换算 | eth_n 直接有 | 映射层解决 |
| 入/出窗口链（视图2 发/入/出/收） | ✗ 不给 | ✗ 不给 | **两者都不给**——GCL 本质是出端口调度。纯推导层解决（上一跳出窗 + 传播/串行化/处理时延，Reusch WFCS 2020 公式），竞品截图「数据来源:GCL 规划结果」「不代表实际到达时刻」的标注证明它也是推导的（方向 5） |
| 流名称/时间参数 | name 回显 / latency 等回显 | flow_streams v1.1.0 新列 | ✓ 两边都有 |
| 头部统计（周期/端口数/窗口数） | Σinterval 聚合 | GATE_CYCLE_NS + 行聚合 | ✓ 查询聚合可得 |
| Excel 导出 | – | – | 前端序列化，与求解器无关 |

**一句话：castup 输出几乎直给三视图全部所需；INET 现状不满足，但缺的信息在 .sca 原始输出里都有（或可确定性回算），是解析层改动而非仿真改动；视图 2 的窗口链两家都不给、本来就该是推导层。**

### 问题 3：各需要怎么变更？

- **INET 侧**：.sca 解析从「只捡 gate7」改成全门收窗合成位图（相当于删一个过滤条件）+ 流归属回算 spike + 写入新 门控明细表
- **castup 侧**：新写一个 adapter（payload 构造 + 结果解析 + 单位换算 ms/μs→ns）+ 任务生命周期接入现有轮询状态机
- **共同**：新增 门控明细表（逐窗一行）（方向 1）；三视图读这张表

---

## 幸存方向（按依赖顺序排列）

### 1. 门控明细表（逐窗一行） `gcl_windows`——本期承重墙（6/6 框架独立命中）

新表逐窗一行：`(session_id, node, eth_n, entry_idx)` 为键，列含 `start_ns / duration_ns / gate_states`（q0-q7 位图）`/ flow_refs`（JSON 数组，带来源标记）`/ provider / algorithm`。空窗（位图全 0）也是普通行。**flow_plans 不迁移不改 PK**，保留 ok/solver_failed/no_gating 三态状态职责（既有契约：勿加第四态）；GCL 明细读取切到新表单路径。明细表形态直接以 castup 输出（≈展示靶面的超集）为蓝本，INET 经 adapter 向上凑——「以 INET 为基准」的正确含义是「INET 结果必须能填满这个形状」，不是「形状长得像 INET」。

- basis：生态调研证实无现成跨求解器归一 schema（arXiv 2305.16772 综述 17 方法未归一），自建 统一明细格式 + 各求解器各写一个转换器 是唯一形态；castup 的 stream_id[] 超出 TSNsched/Chameleon 惯例，是最贵的增值字段，schema 必须给它留位
- 带 provider 维度、同流集两求解器结果共存不覆盖（本期只做头部切换，逐窗对比视图 defer）
- 为什么值得做：定对了，第三个求解器接入只是写 adapter；三视图、Excel、软仿对账、硬件下发全部共用

### 2. `GclSolver` 任务式 trait + 单位/映射收口 adapter

inet-sim-http（POST 202+轮询+409 单任务）与 castup（task_validate/start/query/result/stop）是同一个状态机的两种方言。抽 trait（submit/poll/fetch/cancel），复用 RemoteRunner 抽象先例；castup 的 task_validate 作为可选预检步骤。**铁律：明细表内部只有 ns 整数（i64）+ eth_n + 位图**，单位换算（castup ms/μs）和 link_id↔端口映射只发生在 adapter 边界，每个 adapter 配 golden fixture（真实响应→明细行字节锁，复用 plan 2026-07-01-002 的手法）。

- basis：两接口形态是文档/代码事实；gateIndex=流量类下标≠pcp 的语义错位本项目已踩过一次
- 为什么值得做：单位错是静默杀手（μs 当 ns 错 1000 倍，甘特图上「看起来还行」）；收口后 Mock provider 顺手就有，单测不依赖真机

### 3. INET 侧补齐：停止丢弃 .sca + 流归属确定性回算（需一次 spike）

八队列位图**不是新工程**：.sca 原始输出本来就有全门调度，是现有解析器只捡 gate7 主动丢的——改成全量收窗，位图与空窗就地产出。流归属更进一步：Z3 排窗的前提是它同时决定了每流发送偏移，该偏移大概率同样被 param-recording 记进 .sca（与门参数同一份文件）——**spike 验证参数在场性**，在场则「读数 + 逐跳时延算术」确定性回算归属，与 castup 的 stream_id[] 同精度；不在场退回按流 offset 匹配，仍歧义则降级写「ST 类」级。flow_refs 带来源标记（solver-given / derived / class-level），悬浮卡如实展示，不把推导冒充求解器原话。

- basis：「.sca 有全门调度、解析时丢弃」是代码扫描确认的事实；.sca param-recording 是 learnings 钉死的唯一 dump 路径
- 为什么值得做：不补齐，三视图在基准求解器上就是残废（无位图无徽章），「以 INET 为基准」名存实亡

### 4. raw 求解器响应落 blob 存档，解析可重放

每次求解把原始输出（.sca 文本 / castup plan_result JSON）按 plan 级存 blob + provider/algorithm 血统字段。明细行是「解码产物」，解析器升级或 schema 加列时对存档重放，**不必重跑分钟级求解**。仓内先例：undo pre-image blob 表、eval 采集 raw JSONL。

- basis：「解析时丢弃」正是没有存档的代价的现行实例；视图 4「时间参数」尚未定稿，字段需求必然再变
- 开放问题：blob 体积上界与保留策略（.sca 可能不小），一句话决策但影响 DB 尺寸

### 5. 视图 2 窗口链 = 纯推导层，永不落库

「发/入/出/收」四类时刻两个求解器都不给（GCL 本质 egress-only）。统一推导：hop N+1 入窗 = hop N 出窗 + 传播 + 串行化 + 处理时延（Reusch WFCS 2020；TTEthernet 显式双窗先例）。做成读侧纯函数（输入 明细行 + topology_links.speed + 每流路径），**DB 一个字节不存推导结果**——它是 GCL 的确定性投影，落库只会制造第二事实源。UI 挂死「时间戳=门控窗口边界，非报文实际到达时刻」标注（与竞品同款诚实）。将来软仿产出实测到达时刻，这层的输入可平滑从「推导」换「实测」，视图不改。

- 开放问题：传播/处理时延取常数还是可配置——这是视图 2 数值可信度的分水岭

### 6. 视图 3 全列单查询 = 数据层完成的验收标准（DoD）

门控表（视图 3）列最全，视图 1 是它的图形化投影、视图 2 是它加推导层。把「**单条查询能拉出视图 3 全部列，对两个 provider 都成立**」写成数据层 DoD 和集成测试——schema 缺列在测试期暴露，不在 UI 期。三视图 + 头部统计共享一次查询构建的内存 display model（流/节点筛选在 model 层做，三视图联动）；Excel 导出 = 视图 3 当前筛选行集的前端序列化，**导出按钮背后没有网络请求**（默认 CSV + UTF-8 BOM 零依赖；真 .xlsx 需引 SheetJS 属新外部依赖，需 boss 批准）。

### 7. castup 输入构造「零新增采集」结论（已在问题 1 回答，此处存档为决策依据）

接 castup 不需要用户多填字段、不需要动录入表；真实成本 = 一个映射函数 + 一个 adapter。v1.1.0 刚落库的 name/ip/mac 默认值恰好补上了 castup 输入的最后缺口。

---

## 淘汰清单（含理由）

| 想法 | 淘汰理由 |
|---|---|
| 双 provider 逐窗对比视图 | 数据层支持（provider 共存）并入方向 1；对比 UI 是纯增量、本期无需求支撑，defer |
| SheetJS 真 .xlsx 导出 | 新外部依赖需 boss 明示批准；CSV+BOM 已满足「Excel 双击直开」 |
| 按 provider 能力渐进揭示 UI | 并入方向 3 的 flow_refs 来源标记，不值得独立立项 |
| 把推导入窗落库 | 与方向 5 直接冲突：制造第二事实源，改公式变成改数据迁移 |
| 统一格式 形状照 INET 现状设计 | castup 输出信息量更大且更贴展示靶面；照 INET 设计等于把 stream_id[] 扔在门口 |

## 建议下一步

方向 1+2+3 构成最小闭环（门控明细表 + trait 接入 + INET 补齐），4-6 是其上的消费与保险。建议先对方向 3 的 spike（.sca 里每流偏移参数在场性）做半天验证——它决定 INET 流归属走「确定性回算」还是「降级类级」，影响方向 1 的 flow_refs 设计。之后 `/ce-brainstorm` 把选定范围收敛成需求文档。
