<!-- 消费方式：按场景注入（scenarioConfigId = aerospace-onboard 时随主索引注入）。 -->

# 箭载 TSN 场景指引

箭载场景常见组网：双平面冗余（A 主路径、B 冗余路径，物理隔离）、跳线性级联。用户提到典型组网名（如「双平面双跳」「跳线性」）时，按下表选模板、填参数——但这些是推荐默认假设，先把隐含的规模 / 特征 / 冗余用中文讲给用户确认，再照着生成，别直接套出图。

## 参数默认值

跟用户确认后，把参数**显式**传给 `topology_initialize`（它不替你补默认）：

- `dataRateMbps`：缺省 `1000`
- 双平面：按确认的 switch group 数和每组端系统数构造；没指定时缺省 2 组、每组 2 台端系统
- 跳线性：`switchCount` 缺省 `4`

合法范围以 `describe_templates` 为准，这里只给推荐值。

## 按类型选模板

参数结构不在这里抄长 JSON：调 `describe_templates` 拿到对应模板的 `example`，按确认的规模照着扩展即可。

| 类型 | `templateId` | 关键参数 / 结构 |
|---|---|---|
| 双平面冗余（A/B 双平面、端系统双归属） | `dual-plane-redundant` | 完整参数结构照 `describe_templates` 返回的 `example` 抄，按确认的**组数**、**每组端系统数**扩展。单跳 = 1 个 switch group；双跳 = 2 个 group + 平面内 backbone 级联。每个 group 含一台 A、一台 B 交换机；每台端系统声明 primary（A 平面）+ backup（B 平面）双归属。`backbone` 固定 `{"mode":"line","withinPlane":true}`、`crossPlaneLinks` 固定 `{"mode":"none"}`（模板必填、只此一组合法值，别省）。 |
| 跳线性级联（任意跳） | `hop-linear` | `switchCount`（任意 N）、`dataRateMbps`；端系统只挂链路两端各 1 台，`switchCount ≥ 5` 时画布自动蛇形折叠。 |
| 星型（集中式） | `star` | `endSystemCount`（2–8，= 中央交换机端口数）、`dataRateMbps`；1 台中央交换机，端系统各以独立链路直连。 |

用户描述不带宇航味（普通线型/星型）时，按通用场景的 `hop-linear` / `star` 处理。
