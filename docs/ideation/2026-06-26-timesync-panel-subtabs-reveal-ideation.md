---
date: 2026-06-26
topic: timesync-panel-subtabs-reveal
focus: set_gm 后自动揭示配置面板 + 时间同步 tab 改名分软仿/硬部署子 tab + 硬部署空态引导 + 软仿参数默认值可见
mode: repo-grounded
---

# 时间同步面板交互重构 — ideation

把当前「时钟同步」右侧面板从「两个并排按钮 + 空白参数表单 + set_gm 后毫无反馈」重做成「改名时间同步 + 软仿/硬部署子 tab + 操作后揭示 + 默认值可见」。下面是筛过的 7 个方向，按可落地价值排序。

## Codebase Context（现状事实）

- **配置面板**在拓扑画布下方，由 App 级 `configPanelExpanded`（默认收起）+ `activeConfigTab`（`"node-props" | "time-sync"`，默认 node-props）驱动；底部常驻 handle「▴ 配置」可切。`time-sync-panel.tsx` 现在是**软仿/硬仿两个并排按钮**，硬仿点击只弹占位文案 `HARD_SIM_PLACEHOLDER = "待接入真实硬件"`，无任何后端。
- **set_gm**：agent 调 `timesync.set_gm` → sidecar 重算落库 → emit `session_db_changed` → `useTimesyncSnapshot` 自动 refetch、`treeConfirmed` 翻真。**但 UI 不动**：面板不展开、不切 tab。唯一现存的自动跳 tab 是「点节点强制 node-props + 展开」。
- **覆盖参数表单** `SimOverrideForm`：初始 `form = {}`，字段 `value = form.xxx ?? ""` → **三个字段全空白、无 placeholder**；振荡器 select 显示「默认」而非 Random。后端 `DEFAULT_DRIFT_PPM=100 / DEFAULT_SIM_TIME_S=60 / OscillatorKind::Random` 兜底，但前端对此零反馈。
- **state 归属经验**（既有 plan U10/U11/U12）：`expand/activeConfigTab/selectedNodeId` 随 `sessionId` 重置（防 PR#23 id 污染）；`simStatus` + 结果持 App 级（切 tab 不丢、不取消远端命令）；覆盖表单展开态+填值是独立 intent，只随会话切换重置。
- **WebKit 坑（踩过两次）**：`grid + overflow` 的 auto 行会 row collapse 塌成 0 高（a7f06ff / 87c773a）；嵌套 grid 切 tab 会 stretch 跳变。修法：`flex-wrap + overflow:visible`、`align-self/align-content:start`。Playwright 测不出，验靠 Safari 开 5173 或真机截图。
- 画布底部已有 `clock-tree-bar`（time-sync 阶段 + set_gm 后显示 GM 名），是个可复用的就地揭示锚点。

## 外部惯例（web 研究收敛点）

- 两个**相互独立**的平级选项（软仿/硬部署）→ 用 **tab**，不用 segmented control（会低估切换语义重量），也不用 stepper（那是线性序列）。
- **空态**不能留白：要说清「为何空 + 下一步去哪」，单一 CTA 指向前置（去软仿）。
- **操作后自动切 tab 抢焦点是争议反模式**（Cloudscape 焦点管理原则、JetBrains 用户抱怨）；惯例倾向 **badge/提示 + 用户手动切**。
- **折叠表单显默认**：在 header 显示生效值摘要（如 VS Code「Auto Save: afterDelay」）+ 展开预填实值；**用 placeholder 当标签是反模式**（Baymard）。

## Topic Axes

- **A — set_gm 后的揭示/跳转**：做完 set_gm 怎么把用户引到下一步
- **B — 时间同步 tab → 子 tab 结构**：改名 + 软仿/硬部署怎么组织
- **C — 硬件部署空态**：本期占位怎么既诚实又有出口
- **D — 软仿参数默认值可见**：默认值怎么从空白变可见可改

---

## Ranked Ideas

跳转：[1 子tab结构](#1) · [2 set_gm揭示](#2) · [3 折叠默认摘要](#3) · [4 硬部署空态](#4) · [5 通用揭示机制](#5) · [6 递进解锁](#6) · [7 通用折叠/占位组件](#7)

<a id="1"></a>
### 1. 时间同步 tab 改名 + 软仿/硬部署子 tab（结构骨架）

- **description**：「时钟同步」tab 改名「时间同步」。内部从「软仿/硬仿两个并排按钮」改为两个子 tab：**软件仿真**（承载现有覆盖表单 + 收敛表 + 抖动曲线）、**硬件部署**（本期占位空态）。子 tab 容器用一份阶段清单（`[{id:'soft-sim'}, {id:'hard-deploy', placeholder:true}]`）渲染，而不是写死两个常量——将来加阶段（真机对账等）= 往清单加一项。
- **axis**：B
- **basis**：`direct:` 现状是 `软仿`/`硬仿` 两按钮 + `HARD_SIM_PLACEHOLDER`；改子 tab 是 boss 明确要求。`external:` 两独立阶段用 tab（非 segmented/stepper）是设计系统收敛结论。
- **rationale**：这是整个重构的骨架，其余几条都挂在它上面。两个长得一样的按钮让「未实现的硬部署」看着像「能点的功能」；子 tab 把「这是另一条独立路径」表达准。清单驱动让后续加阶段是配置而非重写。
- **downsides**：子 tab 切换在 WebKit 下嵌套 grid 会跳变/塌 0 高——容器必须 flex 不能 grid，且只能靠 Safari/真机验。本期硬部署是占位，"阶段清单"抽象别过度（就两项，清单是薄薄一层不是框架）。
- **confidence**：90%
- **complexity**：Medium

<a id="2"></a>
### 2. set_gm 后揭示配置面板并落到时间同步 tab（揭示强度分级）⭐

- **description**：set_gm 成功（`treeConfirmed` 翻真）后：① 若面板**收起**→ 展开并直接落到时间同步 tab（用户此刻多半就是要看同步）；② 若面板**已开但用户在别的 tab**（如正编节点属性）→ 不抢焦点，只在「时间同步」tab 标题挂一个脉冲 badge，由用户自己点过去。把 boss 要的「自动弹出+跳转」与「不抢焦点」的争议调和成一条按当前状态分级的规则。
- **axis**：A
- **basis**：`direct:` 现状 set_gm 自动刷 snapshot 但 UI 不动；`handleNodeSelect` 已有「强制切 tab + 展开」先例可对称。`external:` 自动抢 tab 焦点是争议反模式，惯例用 badge/提示 + 手动切。
- **rationale**：boss 的诉求（做完 set_gm 看不到任何反馈、找不到下一步）和「别在我编别的东西时把我甩走」是同一枚硬币的两面。分级规则在「面板本来就关着」的常见情况下满足 boss 的「弹出+跳转」，又在少数「用户正忙别处」时退化成不打扰的提示。
- **downsides**：要和「点节点强制 node-props + 展开」抢 `activeConfigTab`，得想清竞态边界（先来后到/谁覆盖谁）。badge 的「未读」语义要有清除时机（首次进 tab 即清）。
- **confidence**：85%
- **complexity**：Medium

<a id="3"></a>
### 3. 覆盖参数折叠态 header 显示生效默认摘要 + 展开预填实值 ⭐

- **description**：覆盖参数默认收起，但折叠那一行不再是死文案「覆盖参数（不填走默认）」，而是直接显示**当前生效摘要**：`振荡器 Random · 漂移 100ppm · 时长 60s · 默认`。展开后表单字段**预填这些实值**（`form` 初始化为真实默认而非 `{}`），用户看到的就是后端会跑的值；改过的字段在 header 高亮标「已覆盖」。隐藏的是「编辑」，不是「信息」。
- **axis**：D
- **basis**：`direct:` 现状 `form={}`、字段 `value=form.xxx??""` 空白无 placeholder，后端常量兜底。`external:` 折叠区 header 显生效值摘要 + 展开预填是 VS Code 设置面板同款；placeholder 当标签是反模式（Baymard）。
- **rationale**：直击 boss 的「参数空白看不到默认」，且改动很小（改初始 state + 加一行摘要）。消除「不填=不是会出错」的焦虑，工程用户能先看默认再决定改不改。
- **downsides**：预填实值后，"留空走默认"的语义变成"显式提交当前值"——若将来默认值随场景变化，预填的值可能与后端最新默认不同步，得让前端默认值有单一事实源（理想是后端给一个 `defaults` 让前端读，而非前后端各写一份）。
- **confidence**：90%
- **complexity**：Low

<a id="4"></a>
### 4. 硬件部署空态：解释 + 回软仿出口（可叠加就绪清单）

- **description**：硬部署子 tab 本期无功能，空态不止「待接入真实硬件」一句，而是说清三件事：这是什么、本期不可用、现在请去软件仿真——并带一个**直接切回软仿子 tab 的按钮**，把死胡同变成岔路口。进阶（可选）：把空态做成一份**硬件部署就绪清单**（SSH 免密 / 远端 INET / 目标机映射，各标「待接入」），让用户提前知道将来上机要准备什么。
- **axis**：C
- **basis**：`external:` 空态惯例 = 解释 + 下一步 CTA。`direct:` 现状 `HARD_SIM_PLACEHOLDER` 是无出口的死文案；就绪清单内容有事实依据（既有 INET plan 的免密/bundle/端口映射前置）。
- **rationale**：一片空白的 tab 是典型「不知所措」摩擦点。带出口的空态把用户无缝带回唯一可用路径；就绪清单则把占位期变成有信息量的披露面，而非空话。
- **downsides**：就绪清单若与最终硬部署实现脱节，会变成要维护的过期文档——本期先做"解释+回软仿"，清单作为后续真做硬部署时再填的骨架。「切回软仿」按钮是否算给占位加了真交互，需确认本期范围。
- **confidence**：75%
- **complexity**：Low

<a id="5"></a>
### 5. reveal-on-action 做成通用机制（set_gm 是第一个消费者）

- **description**：不把「set_gm 后弹面板 + 切 tab」写成 set_gm 专属硬编码，而是抽一个轻约定：写操作完成后给出一个 `{revealPanel, revealTab}` 意图，App 级统一消费（未展开则展开、按强度规则切 tab）。set_gm 注册成第一个映射条目；将来 apply 拓扑、覆盖参数生效、硬部署提交都复用同一处。
- **axis**：A（杠杆/复利）
- **basis**：`reasoned:` 确认闸接入用的就是「新增并列分支」的同构模式；揭示逻辑集中一处避免散落各 intent handler。多个写操作都需要「做完跳到能看结果的地方」。
- **rationale**：二阶效应——下个写操作要揭示别的面板时是「加一行映射」而非「又写一个 if」。一次做对省掉 N 次重复分支。
- **downsides**：当前只有 set_gm 一个消费者，提前抽象有「为想象中的未来过度设计」之嫌（boss 明确不加假设性扩展点）。判断标准：若机制比硬编码只贵一点点就值得；若要引入事件总线等重型基础设施则不值——倾向最薄的一层映射表。
- **confidence**：60%
- **complexity**：Medium

<a id="6"></a>
### 6. 递进解锁：硬部署 gated 直到软仿收敛（挑战「平级子 tab」假设）

- **description**：把软仿/硬部署从「平级两个子 tab」重新框定为「有序两阶段」：硬部署子 tab 常驻可见但**灰显/锁定**，附文案「软仿收敛后启用」；软仿一旦产出 `isFullyConverged` 的结果，硬部署点亮。这样「空态引导」从额外写文案变成结构自带——前置条件就在用户上方。
- **axis**：B + C
- **basis**：`reasoned:` TSN 真实工序就是先仿真验证再上硬件，软仿的 `SimResult.status==="converged"` 是天然解锁信号（代码已有该判定）。`external:` CI/CD 流水线未到阶段灰显 + 前置条件提示、AWS 向导完成一步解锁下一步是同款。
- **rationale**：平级 tab 暗示「随便先点哪个都行」，而工程语义是有序的。递进结构本身就是最好的空态引导，且把「用户该先做什么」固化进 UI 而非靠文档。这是对 boss「两个平级子 tab」写法的一个值得过一遍的替代。
- **downsides**：与 boss 明确说的「分两个子 tab」有张力——是平级还是 gated 是个需 boss 拍板的取舍。本期硬部署只是占位，"解锁"在没真硬件时可能是空承诺（点亮了也没东西）；可能更适合占位期先平级、真做硬部署时再加 gating。
- **confidence**：55%
- **complexity**：Medium
- **裁定（2026-06-26 boss 定）**：❌ 不采纳。软仿/硬部署做成**平级**子 tab——有时不需要软件仿真也可以直接硬件部署，不做「软仿收敛才解锁硬部署」的 gating。#1 与 #4 按平级落地。

<a id="7"></a>
### 7. 折叠摘要 / 占位空态抽成通用组件（跨面板复用）

- **description**：把两个会反复出现的形态抽成通用组件：① `CollapsibleSummary`（折叠时 header 显生效摘要、展开见全表单）——覆盖参数和节点属性面板都能用；② `PlaceholderPhase`（标题 + 说明 + CTA 的占位阶段）——硬部署是首个使用者，流量规划当前也是下线占位，可复用。WebKit grid 行塌的防护只在这两个组件里各做一次。
- **axis**：D + C（杠杆/复利）
- **basis**：`direct:` 项目里占位阶段是常态（flow-planning 下线占位、INET 曾占位）；折叠摘要在覆盖参数和节点属性两处都需要。`reasoned:` 一处防住 WebKit 塌陷，处处不踩。
- **rationale**：把想法 3、4 的实现沉淀成可复用件，避免两处各写一套折叠逻辑、各踩一次 WebKit 坑。
- **downsides**：抽象要等到第二个真实使用者出现再做才稳——本期可以先在硬部署/覆盖参数各自落地，等节点属性也要折叠摘要时再提取，避免单一使用者的过早抽象。属于"落地时顺手考虑"而非独立要做的事。
- **confidence**：55%
- **complexity**：Medium

---

## Rejection Summary

| 砍掉的想法 | 轴 | 理由 |
|---|---|---|
| 进 time-sync tab 若已 set_gm 且没跑过 → 自动触发一次默认软仿 | A | 太激进：未经同意自动发起远端命令（跑真仿真），违背「操作不抢焦点」原则，意外感强 |
| set_gm 后记住并回到用户上次所在子 tab | A/B | 过早：硬部署是占位，"记住上次在硬部署"当前无意义，为没落地的功能加状态 |
| time-sync 做成右侧贴边常驻工作台（脱离底部抽屉） | A/B | 范围溢出：重写主布局，远超本期改动量，违反「选更简单改动更小」 |
| 覆盖参数改预设方案下拉（典型晶振/高漂移压测…） | D | 过早抽象：当前就 3 个参数，预设层是为想象中的几十个参数设计，boss 明确不加假设性扩展点 |
| header 摘要即内联编辑器（点哪个值改哪个，无展开） | D | 与想法 3 重复但 UX 更险（内联编辑数值控件在窄面板里易误触）；想法 3 的"摘要+展开预填"更稳 |
| 展开表单用 placeholder 显默认值 | D | placeholder 当标签是公认反模式（易被当成已填、跨引擎行为不一致）；被想法 3 的预填实值取代 |
| 默认值带来源标注「按 8 节点拓扑推算，可改」 | D | 事实不符：默认是写死的固定常量（100ppm/60s），并非按拓扑推算，标注会误导 |
| 单 tab + 上下分区，取消子 tab | B | 与 boss 明确要的「分两个子 tab」直接冲突；其合理内核（节省嵌套高度）已由想法 1 的 flex 容器吸收 |
| 「时间同步」tab 本身做成 set_gm 门控（之前不存在/灰显） | A/B | 藏 tab 损害可发现性，且 boss 要的是改名不是条件存在；与想法 2 的揭示相比得不偿失 |
| set_gm 后纯被动呼吸高亮/角标、完全不弹不跳 | A | 被动信号天花板低（易错过），且 boss 明确要「弹出+跳转」；作为想法 2 分级规则的保守端已被吸收 |
| 软仿入口前移到画布 clock-tree-bar（弹板退二线） | A | 有价值但偏离 boss「弹配置面板」的明确方向；作为约束翻转的对照保留思路，本期不做 |

> 轴覆盖：A、B、C、D 均有 survivor。无空轴。
