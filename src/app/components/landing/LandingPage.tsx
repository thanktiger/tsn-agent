import { BookOpen, ChevronDown, ChevronUp, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import type { TemplateRow } from "../../../templates/template-service";

type PreviewNodeType = "switch" | "endSystem";

interface TemplatePreview {
  nodes: Array<{ id: string; type: PreviewNodeType; x: number; y: number }>;
  links: Array<{ source: string; target: string; plane?: "A" | "B" }>;
}

const FACTORY_TEMPLATE_PREVIEWS: Record<string, TemplatePreview> = {
  "tpl-factory-linear": {
    nodes: [
      { id: "es-left", type: "endSystem", x: 8, y: 50 },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `sw-${index}`,
        type: "switch" as const,
        x: 22 + index * 14,
        y: 50,
      })),
      { id: "es-right", type: "endSystem", x: 92, y: 50 },
    ],
    links: [
      { source: "es-left", target: "sw-0" },
      ...Array.from({ length: 4 }, (_, index) => ({
        source: `sw-${index}`,
        target: `sw-${index + 1}`,
      })),
      { source: "sw-4", target: "es-right" },
    ],
  },
  "tpl-factory-star": {
    nodes: [
      { id: "sw", type: "switch", x: 50, y: 50 },
      { id: "es-top", type: "endSystem", x: 50, y: 12 },
      { id: "es-right", type: "endSystem", x: 86, y: 50 },
      { id: "es-bottom", type: "endSystem", x: 50, y: 88 },
      { id: "es-left", type: "endSystem", x: 14, y: 50 },
    ],
    links: ["es-top", "es-right", "es-bottom", "es-left"].map((target) => ({
      source: "sw",
      target,
    })),
  },
  "tpl-factory-dualplane": {
    nodes: [
      { id: "sw-b1", type: "switch", x: 32, y: 30 },
      { id: "sw-b2", type: "switch", x: 68, y: 30 },
      { id: "sw-a1", type: "switch", x: 32, y: 70 },
      { id: "sw-a2", type: "switch", x: 68, y: 70 },
      { id: "es-1", type: "endSystem", x: 8, y: 30 },
      { id: "es-2", type: "endSystem", x: 8, y: 70 },
      { id: "es-3", type: "endSystem", x: 92, y: 30 },
      { id: "es-4", type: "endSystem", x: 92, y: 70 },
    ],
    links: [
      { source: "sw-a1", target: "sw-a2", plane: "A" },
      { source: "sw-b1", target: "sw-b2", plane: "B" },
      { source: "es-1", target: "sw-a1", plane: "A" },
      { source: "es-1", target: "sw-b1", plane: "B" },
      { source: "es-2", target: "sw-a1", plane: "A" },
      { source: "es-2", target: "sw-b1", plane: "B" },
      { source: "es-3", target: "sw-a2", plane: "A" },
      { source: "es-3", target: "sw-b2", plane: "B" },
      { source: "es-4", target: "sw-a2", plane: "A" },
      { source: "es-4", target: "sw-b2", plane: "B" },
    ],
  },
};

export interface LandingPageProps {
  templates: TemplateRow[];
  /** 卡点击/提交进行中——锁定全部卡片防重复触发（plan R25 守卫）。 */
  busy: boolean;
  onSubmitIntent: (text: string) => void;
  onUsePrompt: (template: TemplateRow) => void;
  onUseSnapshot: (template: TemplateRow) => void;
  onDeleteTemplate: (template: TemplateRow) => void;
  onReorder: (orderedIds: string[]) => void;
}

export function LandingPage(props: LandingPageProps) {
  const { templates, busy } = props;
  const [input, setInput] = useState("");

  const promptTemplates = templates
    .filter((t) => t.kind === "prompt")
    .sort((a, b) => {
      const aPriority = a.id === "tpl-factory-dualplane" ? 0 : 1;
      const bPriority = b.id === "tpl-factory-dualplane" ? 0 : 1;
      return aPriority - bPriority;
    });
  const snapshotTemplates = templates.filter((t) => t.kind === "snapshot");

  function submit() {
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    props.onSubmitIntent(text);
    setInput("");
  }

  // 同组内上/下移：在全量 templates 序里交换本卡与同组相邻卡的位置，发全量新序
  // （reorder 写全表 sort_order 0..n；只发分组 ids 会破坏跨组顺序）。
  function move(group: TemplateRow[], id: string, delta: number) {
    const groupIds = group.map((t) => t.id);
    const gi = groupIds.indexOf(id);
    const neighborId = groupIds[gi + delta];
    if (neighborId === undefined) {
      return;
    }
    const full = templates.map((t) => t.id);
    const a = full.indexOf(id);
    const b = full.indexOf(neighborId);
    [full[a], full[b]] = [full[b], full[a]];
    props.onReorder(full);
  }

  return (
    <section className="landing" aria-label="新建工程">
      <header className="landing-topbar">
        <button type="button" className="landing-kb" disabled title="知识库（即将上线）">
          <BookOpen size={14} aria-hidden="true" />
          知识库
        </button>
      </header>

      <div className="landing-hero">
        <h2 className="landing-title">你想配置什么 TSN 网络？</h2>
        <p className="landing-subtitle">直接描述需求，或选一个下方的工程模板快速开始。</p>

        <div className="landing-input-row">
          <textarea
            className="landing-input mono"
            aria-label="描述你的 TSN 需求"
            placeholder="例：我需要 4 个交换机，每个交换机连接 5 个端系统"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className="landing-send"
            aria-label="发送需求"
            disabled={busy || input.trim() === ""}
            onClick={submit}
          >
            →
          </button>
        </div>
      </div>

      <div className="landing-gallery">
        <div className="landing-section-head">
          <h3>拓扑模板</h3>
          <small>选择拓扑模板快速创建工程</small>
        </div>
        {promptTemplates.length === 0 ? (
          <div className="empty-panel mono">暂无模板</div>
        ) : (
          <div className="landing-cards landing-template-cards">
            {promptTemplates.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                tpl={tpl}
                preview={FACTORY_TEMPLATE_PREVIEWS[tpl.id]}
                busy={busy}
                onUse={() => props.onUsePrompt(tpl)}
              />
            ))}
          </div>
        )}

        <div className="landing-section-head">
          <h3>我的快捷模板</h3>
          <small>从工程拓扑「设为模板」导出，点击即时重建</small>
        </div>
        {snapshotTemplates.length === 0 ? (
          <div className="empty-panel mono">
            还没有快捷模板——在工程拓扑画布右上角点「设为模板」即可导出当前拓扑。
          </div>
        ) : (
          <div className="landing-cards">
            {snapshotTemplates.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                tpl={tpl}
                kindBadge={{ icon: "zap", text: "即时" }}
                busy={busy}
                onUse={() => props.onUseSnapshot(tpl)}
                onDelete={() => props.onDeleteTemplate(tpl)}
                onUp={() => move(snapshotTemplates, tpl.id, -1)}
                onDown={() => move(snapshotTemplates, tpl.id, 1)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TemplateCard(props: {
  tpl: TemplateRow;
  kindBadge?: { icon: "zap"; text: string };
  preview?: TemplatePreview;
  busy: boolean;
  onUse: () => void;
  onDelete?: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const { tpl, kindBadge, preview, busy } = props;
  return (
    <div className="landing-card">
      <button type="button" className="landing-card-main" disabled={busy} onClick={props.onUse}>
        {kindBadge ? (
          <span className={`landing-card-badge ${kindBadge.icon}`}>
            <Zap size={11} aria-hidden="true" />
            {kindBadge.text}
          </span>
        ) : null}
        <strong className="landing-card-title">{tpl.title}</strong>
        {tpl.subtitle ? <small className="landing-card-sub">{tpl.subtitle}</small> : null}
        {preview ? <TopologyTemplatePreview preview={preview} title={tpl.title} /> : null}
      </button>
      {props.onUp && props.onDown && props.onDelete ? (
        <div className="landing-card-actions">
          <button type="button" aria-label="上移" onClick={props.onUp}>
            <ChevronUp size={13} aria-hidden="true" />
          </button>
          <button type="button" aria-label="下移" onClick={props.onDown}>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          <button type="button" aria-label="删除模板" onClick={props.onDelete}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TopologyTemplatePreview({ preview, title }: { preview: TemplatePreview; title: string }) {
  const nodesById = new Map(preview.nodes.map((node) => [node.id, node]));
  const switchCount = preview.nodes.filter((node) => node.type === "switch").length;
  const endSystemCount = preview.nodes.filter((node) => node.type === "endSystem").length;

  return (
    <span className="landing-topology-preview">
      <svg viewBox="0 0 100 100" role="img" aria-label={`${title}默认拓扑预览`}>
        <defs>
          <pattern id={`preview-grid-${title}`} width="5" height="5" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.35" className="grid-dot" />
          </pattern>
        </defs>
        <rect
          className="preview-grid"
          width="100"
          height="100"
          fill={`url(#preview-grid-${title})`}
        />
        {preview.links.map((link) => {
          const source = nodesById.get(link.source);
          const target = nodesById.get(link.target);
          if (!source || !target) return null;
          return (
            <line
              key={`${link.source}-${link.target}-${link.plane ?? "default"}`}
              className={link.plane ? `plane-${link.plane.toLowerCase()}` : undefined}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
            />
          );
        })}
        {preview.nodes.map((node) => (
          <g
            key={node.id}
            className={`preview-node ${node.type === "switch" ? "switch" : "end-system"}`}
            data-node-id={node.id}
            transform={`translate(${node.x - 5} ${node.y - 3.5})`}
          >
            <rect className="node-surface" width="10" height="7" rx="1.2" />
            <rect className="node-type" x="1.2" y="1.4" width="2.8" height="4.2" rx="0.7" />
          </g>
        ))}
      </svg>
      <span className="landing-topology-counts">
        <span>
          <i className="switch" aria-hidden="true" />
          交换机 {switchCount}
        </span>
        <span>
          <i className="end-system" aria-hidden="true" />
          端系统 {endSystemCount}
        </span>
      </span>
    </span>
  );
}
