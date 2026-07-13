/**
 * 流量规划面板内的平级子 tab（流量列表 / 门控规划 / 软仿模拟 / 硬件部署）分段开关。
 *
 * 结构对齐 timesync-subtabs；hw-deploy 暂未开放，disabled 防误点。
 */

/** 流量规划面板内的平级子 tab。 */
export type FlowSubTab = "flow-list" | "gate-plan" | "soft-sim" | "hw-deploy";

export const FLOW_SUBTABS: Array<{ id: FlowSubTab; label: string; disabled?: boolean }> = [
  { id: "flow-list", label: "流量列表" },
  { id: "gate-plan", label: "门控规划" },
  { id: "soft-sim", label: "软仿模拟" },
  { id: "hw-deploy", label: "硬件部署", disabled: true },
];

export function FlowSubTabs({
  activeSubTab,
  onSelectSubTab,
}: {
  activeSubTab: FlowSubTab;
  onSelectSubTab: (tab: FlowSubTab) => void;
}) {
  return (
    <div className="flow-subtabs" role="tablist" aria-label="流量规划阶段">
      {FLOW_SUBTABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`flow-subtab-${tab.id}`}
          aria-selected={activeSubTab === tab.id}
          aria-controls={`flow-subpanel-${tab.id}`}
          className={activeSubTab === tab.id ? "flow-subtab active" : "flow-subtab"}
          disabled={tab.disabled}
          title={tab.disabled ? "即将推出" : undefined}
          onClick={() => onSelectSubTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
