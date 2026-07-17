import { BookOpen, ChevronDown, ChevronUp, Sparkles, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import type { ScenarioConfigId } from "../../../domain/scenario-config";
import type { TemplateRow } from "../../../templates/template-service";

/** 场景 → 画廊分组标签（航空/箭载统一显示「航空航天」，见 plan U1/R19）。 */
const CATEGORY_LABEL: Record<string, string> = {
  "generic-tsn": "普通",
  "aerospace-onboard": "航空航天",
};

const CATEGORY_ORDER: ScenarioConfigId[] = ["aerospace-onboard", "generic-tsn"];

export interface LandingExample {
  id: string;
  label: string;
  intent: string;
}

export interface LandingPageProps {
  templates: TemplateRow[];
  examples: LandingExample[];
  /** 卡点击/提交进行中——锁定全部卡片防重复触发（plan R25 守卫）。 */
  busy: boolean;
  onSubmitIntent: (text: string) => void;
  onUsePrompt: (template: TemplateRow) => void;
  onUseSnapshot: (template: TemplateRow) => void;
  onDeleteTemplate: (template: TemplateRow) => void;
  onReorder: (orderedIds: string[]) => void;
}

export function LandingPage(props: LandingPageProps) {
  const { templates, examples, busy } = props;
  const [input, setInput] = useState("");

  const promptTemplates = templates.filter((t) => t.kind === "prompt");
  const snapshotTemplates = templates.filter((t) => t.kind === "snapshot");

  const promptByCategory = CATEGORY_ORDER.map((scenario) => ({
    scenario,
    label: CATEGORY_LABEL[scenario] ?? scenario,
    items: promptTemplates.filter((t) => t.scenarioConfigId === scenario),
  })).filter((group) => group.items.length > 0);

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

        {examples.length > 0 && (
          <div className="landing-examples" role="group" aria-label="示例需求">
            {examples.map((ex) => (
              <button
                key={ex.id}
                type="button"
                className="landing-example-chip"
                onClick={() => setInput(ex.intent)}
              >
                {ex.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="landing-gallery">
        <div className="landing-section-head">
          <h3>拓扑模板</h3>
          <small>点击让 AI 现场生成对应拓扑</small>
        </div>
        {promptByCategory.length === 0 ? (
          <div className="empty-panel mono">暂无模板</div>
        ) : (
          promptByCategory.map((group) => (
            <div key={group.scenario} className="landing-category">
              <div className="landing-category-label">{group.label}</div>
              <div className="landing-cards">
                {group.items.map((tpl) => (
                  <TemplateCard
                    key={tpl.id}
                    tpl={tpl}
                    kindBadge={{ icon: "spark", text: "现场生成" }}
                    busy={busy}
                    onUse={() => props.onUsePrompt(tpl)}
                    onDelete={() => props.onDeleteTemplate(tpl)}
                    onUp={() => move(group.items, tpl.id, -1)}
                    onDown={() => move(group.items, tpl.id, 1)}
                  />
                ))}
              </div>
            </div>
          ))
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
  kindBadge: { icon: "spark" | "zap"; text: string };
  busy: boolean;
  onUse: () => void;
  onDelete: () => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const { tpl, kindBadge, busy } = props;
  return (
    <div className="landing-card">
      <button type="button" className="landing-card-main" disabled={busy} onClick={props.onUse}>
        <span className={`landing-card-badge ${kindBadge.icon}`}>
          {kindBadge.icon === "spark" ? (
            <Sparkles size={11} aria-hidden="true" />
          ) : (
            <Zap size={11} aria-hidden="true" />
          )}
          {kindBadge.text}
        </span>
        <strong className="landing-card-title">{tpl.title}</strong>
        {tpl.subtitle ? <small className="landing-card-sub">{tpl.subtitle}</small> : null}
      </button>
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
    </div>
  );
}
