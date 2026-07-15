---
module: inet_sim / flow-planning
problem_type: integration_gotcha
root_cause: framework_semantics
severity: high
symptom: Z3GateScheduleConfigurator 报 "The specified constraints might not be satisfiable"
---

# INET 配置器把 source/destination 当子串 PatternMatcher——节点名前缀歧义致 Z3 假性 unsat

## 症状

ES ≥10 的拓扑（首例：5 交换机 + 12 端系统）跑门控综合，Z3 报
`The specified constraints might not be satisfiable`，而纸面负载极低（最重端口 ~5%）。
release build 下 unsat core（EV_WARN）不可见，报错毫无线索。

## 根因

`GateScheduleConfiguratorBase.cc:157-158`（INET 4.6.0）把 configuration 的
`source`/`destination` 当 **PatternMatcher** 匹配所有节点 fullPath，且
`fullstring=false`——`patternmatcher.cc:82-90` 会给模式两端自动补 `**`（**子串匹配**）。

`destination: "es1"` 实际是 `**es1**`，同时命中 es1/es10/es11/es12——双层节点循环把
一条 entry 展开成 4 条流，其中 3 条的 pathFragments 终点（es1）与 endDevice
（es10/11/12）矛盾 → Z3 必然 unsat。

**pattern 侧无解**：es1 是 es10 的真前缀，子串匹配下任何以 es1 收尾的模式都是
es10 匹配串的子串——只能改名字。

## 修复

NED 命名恒定两位零填充（`es01`…/`sw01`…），改 `inet_sim_bundle::node_ned_names`
单一源即全链路跟随（bundle 生成 / .sca 解析 ned→mid / verify / 流关联回算）。
防回归锁：`ned_names_zero_padded_no_prefix_ambiguity` 断言任一 ned 名不是另一名的子串。

## 诊断手法（可复用）

1. 宿主机 run 目录抓失败 bundle（`/tmp/tsn-agent-runs/run-*/omnetpp.ini`），复制出实验目录
2. 手工 `opp_env run … -c "cd <dir> && inet -u Cmdenv -f omnetpp.ini -n ."` 复现（不占服务单任务锁）
3. 写脚本按下标裁剪 configuration 数组做**流级二分**（本例 10→5→2→1 条收敛到单流）
4. 单流后做**单参数对照**（时间参数/方向互换/换端点）——本例「es1→es6 sat 而 es6→es1 unsat」
   的方向不对称 + 「es6→es3 sat」把变量钉死到 destination=es1
5. 读 INET/OMNeT++ 源码闭环（宿主机 `~/inet-workspace/` 有全源码）

## 教训

- INET configurator 的字符串参数很多是 pattern 不是字面名——写入端生成名字时要保证
  **无前缀歧义**（零填充是最廉价的系统性解法）
- release build 的 EV_WARN/unsat core 不可见，`cmdenv-express-mode=false` 也救不回——
  真机二分比等日志快
