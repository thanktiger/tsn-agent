import { expect, test } from "@playwright/test";

/**
 * Plan v3 Phase B-β：浏览器（非 Tauri）模式 fail-closed。
 * fake-agent 已删除，Web 端不再有本地确定性拓扑流；smoke 验证 UI 骨架
 * 与「需要桌面版」边界提示。完整 agent → sidecar → query_topology 流
 * 由 Tauri e2e（real_agent_e2e）覆盖。
 *
 * 断言对齐当前 UI（2026-06）：planning-export 阶段顶部 note 已移除；右侧
 * 「执行日志」模块已被「评估采集」取代，并折叠进「设置」面板。
 */
test("web preview fails closed with a desktop CTA while the workspace shell stays usable", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "HIBridge Agent" })).toBeVisible();
  await expect(page.getByTestId("topology-canvas")).toBeVisible();
  await expect(page.getByText("描述你的 TSN 需求后生成拓扑图")).toBeVisible();

  const stepper = page.getByLabel("配置步骤");
  await expect(stepper.getByText("拓扑")).toBeVisible();
  await expect(stepper.getByText("流量规划")).toBeVisible();

  await page.getByLabel("输入你的 TSN 需求").fill("我需要4个交换机，每个交换机连接5个端系统");
  await page.getByRole("button", { name: "生成规划草案" }).click();

  await expect(page.getByText(/需要在 HIBridge Agent 桌面版中运行/)).toBeVisible();
  await expect(page.getByText("拓扑生成后在这里显示")).toBeVisible();

  // 设置抽屉：评估采集已折叠进设置，更新日志可见。
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "评估采集" })).toBeVisible();
  await expect(page.getByText("更新日志")).toBeVisible();
});
