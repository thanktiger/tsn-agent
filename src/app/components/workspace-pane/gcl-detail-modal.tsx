import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildGclDisplayModel,
  buildGclOverview,
  degradedFlowSeqs,
  type FlowRefDto,
  type GclDetail,
  type GclFilters,
  type GclWindowRow,
  invokeGetGclDetail,
} from "./flow-sim";
import { GclFlowChainChart } from "./gcl-flow-chain-chart";
import { GclGanttChart } from "./gcl-gantt-chart";

export interface GclDetailModalProps {
  /** false = 不渲染（不出 DOM、不拉数据）。 */
  open: boolean;
  sessionId: string;
  onClose: () => void;
  /** 门控明细读通道（U5，测试注入替身，默认 get_gcl_detail Tauri command）。 */
  getGclDetail?: (sessionId: string) => Promise<GclDetail>;
}

/** 弹窗三页签（R7）：gantt / flow-chain 本单元先渲染占位容器（U6/U7 填充），table 完整实现。 */
type GclDetailTab = "gantt" | "flow-chain" | "table";

const GCL_DETAIL_TABS: Array<{ id: GclDetailTab; label: string }> = [
  { id: "gantt", label: "门控可视化" },
  { id: "flow-chain", label: "流量维度" },
  { id: "table", label: "门控表" },
];

/** 查询三态（R13）：加载中 / 失败（可重试）/ 已回。空态由 loaded 数据推导。 */
type GclQueryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; detail: GclDetail };

/** ns → μs 显示（R10：除以 1000 保留 1 位小数）。 */
function fmtUs(ns: number): string {
  return (ns / 1000).toFixed(1);
}

/** CSV 字段转义：含逗号/引号/换行时套引号（引号翻倍）。 */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 关联流文本化（表格徽章与 CSV 同口径）：derived → F{seq}·流名、class 降级 → ST 类、
 * 无 refs → 空窗。 */
function flowRefText(ref: FlowRefDto, flowNames: Map<number, string>): string {
  return ref.source === "class"
    ? "ST 类"
    : `F${ref.seq}·${flowNames.get(ref.seq) ?? `流${ref.seq}`}`;
}

/** 当前筛选行序列化 CSV（R10/AE4）：UTF-8 BOM 前缀 + 中文列头，gate_states 展开成
 * q0-q7 八列 0/1，flow_refs 文本化。前端纯序列化，无网络请求。 */
export function buildGclCsv(rows: GclWindowRow[], flowNames: Map<number, string>): string {
  const header = [
    "节点",
    "端口",
    "索引",
    "开始(μs)",
    "结束(μs)",
    "持续(μs)",
    "门控操作",
    "q0",
    "q1",
    "q2",
    "q3",
    "q4",
    "q5",
    "q6",
    "q7",
    "关联流",
  ];
  const lines = [header.join(",")];
  for (const w of rows) {
    const bits = Array.from({ length: 8 }, (_, g) => String((w.gateStates >> g) & 1));
    const refs = w.flowRefs ?? [];
    const refText =
      refs.length === 0 ? "空窗" : refs.map((r) => flowRefText(r, flowNames)).join("；");
    lines.push(
      [
        csvField(w.nodeName),
        `G${w.ethN}`,
        String(w.entryIdx),
        fmtUs(w.startNs),
        fmtUs(w.startNs + w.durationNs),
        fmtUs(w.durationNs),
        "set-gate-states",
        ...bits,
        csvField(refText),
      ].join(","),
    );
  }
  return `\uFEFF${lines.join("\n")}`;
}

/** 八个队列门位（q0-q7，固定顺序——门位号即语义身份）。 */
const QUEUE_GATES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** q0-q7 八圆点（R10）：实心 = 开（bit=1）、空心 = 关，圆点下方微字号下标。 */
function QDots({ gateStates }: { gateStates: number }) {
  return (
    <span className="gcl-q-dots">
      {QUEUE_GATES.map((g) => (
        <span key={`q${g}`} className="gcl-q">
          <span className={`gcl-q-dot ${gateStates & (1 << g) ? "on" : "off"}`} />
          <span className="gcl-q-label">q{g}</span>
        </span>
      ))}
    </span>
  );
}

/** 关联流单元格：徽章 F{seq}·流名（class 降级显示「ST 类」），无 refs 显示「空窗」。 */
function FlowRefCell({
  refs,
  flowNames,
}: {
  refs: FlowRefDto[] | null;
  flowNames: Map<number, string>;
}) {
  if (!refs || refs.length === 0) {
    return <span className="gcl-flow-ref-empty">空窗</span>;
  }
  return (
    <>
      {refs.map((r) => (
        <span
          key={`${r.seq}-${r.source}`}
          className={r.source === "class" ? "gcl-flow-ref-badge degraded" : "gcl-flow-ref-badge"}
        >
          {flowRefText(r, flowNames)}
        </span>
      ))}
    </>
  );
}

/**
 * 全屏「门控详情」弹窗（U5，R7/R10/R13）：三页签（门控可视化 / 流量维度 / 门控表）+
 * 头部元信息 + 双筛选下拉（三页签联动同一 state）+ 数据三态。open=true 挂载即拉数据、
 * 打开时筛选器重置「全部」（R7）。结构照 flow-detail-modal 先例（layer / backdrop button /
 * section role=dialog / ESC 关闭），尺寸全屏（92vw × 88vh）。
 */
export function GclDetailModal({
  open,
  sessionId,
  onClose,
  getGclDetail = invokeGetGclDetail,
}: GclDetailModalProps) {
  const [query, setQuery] = useState<GclQueryState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<GclDetailTab>("gantt");
  const [filters, setFilters] = useState<GclFilters>({ flowSeq: null, node: null });
  // requestSeq 丢弃过期响应（弹窗开着切会话时旧响应不落地）。
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqRef.current;
    setQuery({ status: "loading" });
    try {
      const detail = await getGclDetail(sessionId);
      if (reqRef.current === seq) setQuery({ status: "loaded", detail });
    } catch (e) {
      if (reqRef.current === seq) {
        setQuery({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }, [getGclDetail, sessionId]);

  // 打开（或开着时切会话）→ 重置页签/筛选并拉数据。
  useEffect(() => {
    if (!open) return;
    setActiveTab("gantt");
    setFilters({ flowSeq: null, node: null });
    void refresh();
  }, [open, refresh]);

  // ESC 键关闭弹窗。
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const detail = query.status === "loaded" ? query.detail : null;
  // 空态口径（R13）：meta null（从未规划/老工程）或无窗 → 提示重新规划，不渲染页签内容。
  const hasData = detail !== null && detail.meta !== null && detail.windows.length > 0;
  const overview = detail && hasData ? buildGclOverview(detail) : null;
  const model = detail && hasData ? buildGclDisplayModel(detail, filters) : null;
  const rows = model ? model.groups.flatMap((g) => g.windows) : [];
  // 筛选下拉选项（model.flowNames 恒由全量窗口构建，不受筛选影响）。
  const flowOptions = model ? [...model.flowNames.entries()].sort((a, b) => a[0] - b[0]) : [];
  const nodeOptions = detail ? [...new Set(detail.windows.map((w) => w.nodeName))] : [];

  function handleExport() {
    if (!model) return;
    const csv = buildGclCsv(rows, model.flowNames);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gcl-windows-${sessionId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flow-detail-modal-layer">
      {/* backdrop：<button> 确保键盘可访问（对齐 flow-detail-modal 先例）。 */}
      <button
        type="button"
        className="flow-detail-modal-backdrop"
        aria-label="关闭门控详情"
        onClick={onClose}
      />
      <section
        className="flow-detail-modal gcl-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gcl-detail-modal-title"
      >
        <h3 id="gcl-detail-modal-title">门控详情</h3>

        {query.status === "loading" && <p className="gcl-detail-state mono">加载中…</p>}

        {query.status === "error" && (
          <div className="gcl-detail-state">
            <p className="flow-detail-modal-error">门控明细读取失败：{query.message}</p>
            <button type="button" className="btn" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        )}

        {query.status === "loaded" && !hasData && (
          <p className="gcl-detail-state">请重新规划以生成门控明细</p>
        )}

        {query.status === "loaded" && hasData && overview && model && (
          <>
            {/* 头部元信息（R7，数据来自 buildGclOverview）。 */}
            <p className="gcl-detail-subtitle">
              展示周期 {fmtUs(overview.cycleNs ?? 0)} μs · 超周期 {fmtUs(overview.cycleNs ?? 0)} μs
              · {overview.gatedPortCount} 个门控端口 · {overview.openWindowCount} 个打开窗口
            </p>

            {/* 双筛选下拉（单选默认「全部」，三页签联动同一 state）。 */}
            <div className="gcl-detail-filters">
              <label htmlFor="gcl-filter-flow">流量</label>
              <select
                id="gcl-filter-flow"
                value={filters.flowSeq ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    flowSeq: e.target.value === "" ? null : Number(e.target.value),
                  }))
                }
              >
                <option value="">全部</option>
                {flowOptions.map(([seq, name]) => (
                  <option key={seq} value={seq}>
                    F{seq}·{name}
                  </option>
                ))}
              </select>
              <label htmlFor="gcl-filter-node">节点</label>
              <select
                id="gcl-filter-node"
                value={filters.node ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, node: e.target.value === "" ? null : e.target.value }))
                }
              >
                <option value="">全部</option>
                {nodeOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            {/* 三页签分段开关（照 flow-subtabs 先例）。 */}
            <div className="flow-subtabs gcl-detail-tabs" role="tablist" aria-label="门控详情页签">
              {GCL_DETAIL_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`gcl-detail-tab-${tab.id}`}
                  aria-selected={activeTab === tab.id}
                  aria-controls={`gcl-detail-tabpanel-${tab.id}`}
                  className={activeTab === tab.id ? "flow-subtab active" : "flow-subtab"}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="gcl-detail-body">
              {activeTab === "gantt" && (
                <div
                  id="gcl-detail-tabpanel-gantt"
                  role="tabpanel"
                  aria-labelledby="gcl-detail-tab-gantt"
                  data-testid="gcl-gantt-slot"
                  className="gcl-detail-slot"
                >
                  {/* U6：ECharts 甘特（model 已按弹窗筛选过滤）。 */}
                  {model && detail && (
                    <GclGanttChart
                      model={model}
                      cycleNs={detail.meta?.cycleNs ?? 0}
                      degradedSeqs={degradedFlowSeqs(detail)}
                    />
                  )}
                </div>
              )}
              {activeTab === "flow-chain" && (
                <div
                  id="gcl-detail-tabpanel-flow-chain"
                  role="tabpanel"
                  aria-labelledby="gcl-detail-tab-flow-chain"
                  data-testid="gcl-chain-slot"
                  className="gcl-detail-slot"
                >
                  {/* U7：窗口链（R9：不受节点筛选影响，流选择在组件内；与顶部流量筛选共 state）。 */}
                  {detail && (
                    <GclFlowChainChart
                      detail={detail}
                      selectedFlowSeq={filters.flowSeq}
                      onSelectFlow={(seq) => setFilters((f) => ({ ...f, flowSeq: seq }))}
                    />
                  )}
                </div>
              )}
              {activeTab === "table" && (
                <div
                  id="gcl-detail-tabpanel-table"
                  role="tabpanel"
                  aria-labelledby="gcl-detail-tab-table"
                >
                  <div className="gcl-table-toolbar">
                    <span className="gcl-table-count">筛选结果 {rows.length} 条</span>
                    <button type="button" className="btn" onClick={handleExport}>
                      导出 Excel
                    </button>
                  </div>
                  <table className="eng-table gcl-table">
                    <thead>
                      <tr>
                        <th>节点</th>
                        <th>端口</th>
                        <th>索引</th>
                        <th>开始(μs)</th>
                        <th>结束(μs)</th>
                        <th>持续(μs)</th>
                        <th>门控操作</th>
                        <th>门控状态</th>
                        <th>关联流</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((w) => (
                        <tr key={`${w.node}-${w.ethN}-${w.entryIdx}`}>
                          <td title={w.node}>{w.nodeName}</td>
                          <td className="mono">G{w.ethN}</td>
                          <td className="mono">{w.entryIdx}</td>
                          <td className="mono">{fmtUs(w.startNs)}</td>
                          <td className="mono">{fmtUs(w.startNs + w.durationNs)}</td>
                          <td className="mono">{fmtUs(w.durationNs)}</td>
                          <td className="mono">set-gate-states</td>
                          <td>
                            <QDots gateStates={w.gateStates} />
                          </td>
                          <td>
                            <FlowRefCell refs={w.flowRefs} flowNames={model.flowNames} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
