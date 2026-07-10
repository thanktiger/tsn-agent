<!-- 消费方式：按场景注入（scenarioConfigId = generic-tsn 时随主索引注入；也是未知场景的回退指引）。 -->

# 通用 TSN 场景指引

通用 TSN 组网：交换机线型互联、端系统挂在链路两端。没有行业规范图约束，按用户说的规模直接参数化就行。

## 参数默认值

用户没指定时，下面这些要**显式**传给 `topology_initialize`（它不替你补默认）：

- `switchCount`（交换机数量 / 跳数）：缺省 `4`
- `dataRateMbps`（链路速率）：缺省 `1000`

合法范围以 `describe_templates` 为准，这里只给推荐值。

## 按类型选模板

| 类型 | `templateId` | 关键参数 / 结构 |
|---|---|---|
| 线型（任意跳） | `hop-linear` | `switchCount`（任意 N）、`dataRateMbps`；端系统只挂链路两端各 1 台。 |
| 星型（集中式） | `star` | `endSystemCount`（2–8，= 中央交换机端口数）、`dataRateMbps`；1 台中央交换机，端系统各以独立链路直连。 |

例：「4 个交换机线型互联」→ `hop-linear`，`switchCount=4`。
例：「1 台中央交换机接 4 个端系统的星型」→ `star`，`endSystemCount=4`。
