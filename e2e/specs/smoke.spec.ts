import { expect, test } from "@playwright/test";

test("beginner request moves through staged workflow and exports files", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "TSN Agent" })).toBeVisible();
  await page.getByLabel("输入你的 TSN 需求").fill("我需要4个交换机，每个交换机连接5个端系统");
  await page.getByRole("button", { name: "生成规划草案" }).click();

  await expect(page.getByText("交换机 4")).toBeVisible();
  await expect(page.getByText("端系统 20")).toBeVisible();
  await expect(page.getByText("拓扑等待确认")).toBeVisible();
  await expect(page.getByTestId("topology-canvas")).toBeVisible();
  await expect(page.getByTestId("topology-canvas").getByText("SW-1")).toBeVisible();
  await expect(page.getByTestId("topology-canvas").getByText("ES-1-1")).toBeVisible();
  await expect(page.getByText("等待 tsn-topology skill 输出拓扑")).toHaveCount(0);
  await page.getByRole("tab", { name: "导出文件" }).click();
  await expect(page.getByLabel("导出文件列表").getByText("完成“模拟仿真”阶段后显示仿真输入文件")).toBeVisible();
  await page.getByRole("tab", { name: "流量列表" }).click();

  await page.getByRole("button", { name: "确认并继续" }).click();
  await expect(page.getByText("时间同步等待确认")).toBeVisible();
  await page.getByRole("button", { name: "确认并继续" }).click();
  await expect(page.getByText("流量规划等待确认")).toBeVisible();
  await page.getByRole("button", { name: "确认并继续" }).click();
  await expect(page.getByText("模拟仿真等待确认")).toBeVisible();

  await page.getByRole("tab", { name: "导出文件" }).click();
  await expect(page.getByLabel("导出文件列表").getByText("tsnagent/generated/network.ned", { exact: true })).toBeVisible();
  await expect(page.getByLabel("导出文件列表").getByText("omnetpp.ini", { exact: true })).toBeVisible();
  await expect(page.getByText("INET/OMNeT++ 最小运行配置")).toBeVisible();
  await page.getByRole("tab", { name: "执行步骤" }).click();
  await expect(page.getByLabel("执行步骤").getByText("工具状态").first()).toBeVisible();
  await page.getByRole("tab", { name: "导出文件" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已导出 5 个文件：browser-preview")).toBeVisible();
  await page.getByRole("button", { name: "日志" }).click();
  await expect(page.getByRole("complementary", { name: "诊断日志" })).toBeVisible();
  await expect(page.getByLabel("当前会话诊断日志").getByText("用户提交需求").first()).toBeVisible();
  await expect(page.getByLabel("当前会话诊断日志").getByText("artifact bundle 已生成").first()).toBeVisible();
  await expect(page.getByLabel("当前会话诊断日志").getByText("项目文件已导出").first()).toBeVisible();
});
