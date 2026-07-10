import { expect, test } from "@playwright/test";

/**
 * Plan v3 Phase B-β：浏览器（非 Tauri）模式 fail-closed。
 * fake-agent 已删除，Web 端不再有本地确定性拓扑流；smoke 验证 UI 骨架
 * 与「需要桌面版」边界提示。完整 agent → sidecar → query_topology 流
 * 由 Tauri e2e（real_agent_e2e）覆盖。
 *
 * 断言对齐当前 UI（2026-07）：空 session 首屏为落地页（U5，取代旧空态 stepper/画布）；
 * 右侧「评估采集」折叠进「设置」面板。
 */
test("web preview fails closed with a desktop CTA while the workspace shell stays usable", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "HIBridge Agent" })).toBeVisible();
  // 空 session 首屏是落地页。
  await expect(page.getByText("你想配置什么 TSN 网络？")).toBeVisible();

  // 从落地页输入框提交需求 → 进入工作区。
  await page.getByLabel("描述你的 TSN 需求").fill("我需要4个交换机，每个交换机连接5个端系统");
  await page.getByRole("button", { name: "发送需求" }).click();

  await expect(page.getByText(/需要在 HIBridge Agent 桌面版中运行/)).toBeVisible();
  await expect(page.getByText("拓扑生成后在这里显示")).toBeVisible();

  // 设置抽屉：评估采集已折叠进设置，更新日志可见。
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "评估采集" })).toBeVisible();
  await expect(page.getByText("更新日志")).toBeVisible();
});
