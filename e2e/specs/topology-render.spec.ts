import { expect, test } from "@playwright/test";

/**
 * 浏览器层覆盖前端「检测到 Tauri 运行时 → query_topology 取数 → 真 React Flow 画布渲染拓扑」
 * 这一段——vitest 把画布与 adapter 都 stub 了，只验数据流；smoke 只验 web fail-closed。
 * 这里通过 addInitScript 注入一个 mock 的 Tauri 桥（invoke + 事件插件 + transformCallback），
 * 让真前端以为跑在桌面版里，喂 canned 拓扑，断言真画布渲染出真实节点/链路 DOM。
 *
 * 仍不驱动真 Rust sidecar/agent（那条链由 cargo 集成测试 + agent-adapter 单测覆盖）；
 * 本测试的增量价值是「真 React Flow 渲染 + 真 isTauriRuntime 分支」。
 */

// 注入到页面、在 app JS 之前执行：伪造 window.__TAURI_INTERNALS__，让 isTauriRuntime() 为真，
// 并把 invoke / 事件插件路由到 canned 响应。
const BRIDGE_INIT = `
(() => {
  let cbId = 0;
  const sampleTopology = {
    sessionId: "e2e",
    nodes: [
      { mid: "0", name: null, x: 0, y: 0, nodeType: "switch", insertOrder: 0 },
      { mid: "1", name: null, x: 200, y: 0, nodeType: "switch", insertOrder: 1 },
      { mid: "2", name: null, x: 0, y: 160, nodeType: "endSystem", insertOrder: 2 },
    ],
    links: [
      { linkSeq: 0, name: null, srcNode: "0", dstNode: "1", srcPort: 0, dstPort: 0, stylesJson: "{}" },
      { linkSeq: 1, name: "uplink", srcNode: "0", dstNode: "2", srcPort: 1, dstPort: 0, stylesJson: "{}" },
    ],
  };
  // query_topology 的结果必须回传请求里的 sessionId，否则快照 hook 会因 sessionId 不符而丢弃。
  const sid = (args) => (args && args.request && args.request.sessionId) || "e2e";
  const handlers = {
    "plugin:event|listen": () => ++cbId,
    "plugin:event|unlisten": () => null,
    get_current_session: () => null,
    list_sessions: () => [],
    query_topology: (args) => ({ ...sampleTopology, sessionId: sid(args) }),
    get_topology_mutations_since: () => ({ mutations: [], latest: 0, outOfRange: false }),
    query_timesync: (args) => ({ sessionId: sid(args), gmMid: null, nodes: [] }),
    get_inet_host_config: () => ({ host: "100.104.38.106", user: "zhang", inetPath: "/home/zhang/.local/bin/inet" }),
  };
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(cb) {
      const id = ++cbId;
      window["_" + id] = cb;
      return id;
    },
    invoke(cmd, args) {
      const h = handlers[cmd];
      return Promise.resolve(h ? h(args) : null);
    },
  };
  // @tauri-apps/api/event 卸载监听时会调 __TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener，
  // 缺它会在 effect cleanup 抛错、连累拓扑快照 effect → 画布不渲染。
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {},
  };
})();
`;

test("desktop runtime renders topology from query_topology on a real React Flow canvas", async ({
  page,
}) => {
  await page.addInitScript(BRIDGE_INIT);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "TSN Agent" })).toBeVisible();

  // 检测到 Tauri 运行时 → 不再 fail-closed（web 预览的「需要桌面版」文案不应出现）。
  await expect(page.getByText(/需要在 TSN Agent 桌面版中运行/)).toHaveCount(0);

  // 真 React Flow 画布渲染出 canned 拓扑：节点/链路统计取自 query_topology。
  await expect(page.getByTestId("topology-canvas")).toBeVisible();
  const stats = page.getByLabel("拓扑统计");
  await expect(stats.getByText("交换机 2")).toBeVisible();
  await expect(stats.getByText("端系统 1")).toBeVisible();
  await expect(stats.getByText("链路 2")).toBeVisible();
  await expect(page.getByText("草案已生成")).toBeVisible();
});
