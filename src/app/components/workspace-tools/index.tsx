import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  Copy,
  FolderOpen,
  Plus,
  ScrollText,
  Settings,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { DiagnosticLogRepository } from "../../../diagnostics/diagnostic-log-repository";
import { DiagnosticsLogView } from "../../../ui/diagnostics/DiagnosticsDrawer";
import { SkillFilePreview } from "../../../ui/skills/SkillFilePreview";
import { redactProviderNamesForDisplay } from "../../../ui/display-redaction";
import { resolvePlannerBaseUrl } from "../../../planner/planner-contract";
import { appVersion, releaseNotes, type ReleaseNote } from "../../../release/release-info";
import type { TsnSession } from "../../../sessions/session-repository";
import { SKILL_CATALOG, type SkillCatalogItem } from "../../../skills/skill-catalog";
import { DetailRow, formatTime } from "../shared";

export type WorkspaceToolPanel = "sessions" | "diagnostics" | "skills" | "settings";

export interface WorkspaceToolsProps {
  activePanel: WorkspaceToolPanel | undefined;
  setActivePanel: Dispatch<SetStateAction<WorkspaceToolPanel | undefined>>;
  currentSession: TsnSession;
  sessions: TsnSession[];
  diagnosticsRepository: DiagnosticLogRepository;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
  onDuplicateSession: () => void;
  onDeleteSession: () => void;
}

export function WorkspaceTools({
  activePanel,
  setActivePanel,
  currentSession,
  sessions,
  diagnosticsRepository,
  onNewSession,
  onSelectSession,
  onDuplicateSession,
  onDeleteSession,
}: WorkspaceToolsProps) {
  return (
    <>
      <WorkspaceToolRail
        activePanel={activePanel}
        onSelectPanel={(panel) => setActivePanel((current) => (current === panel ? undefined : panel))}
      />
      {activePanel && (
        <WorkspaceToolDrawer
          activePanel={activePanel}
          currentSession={currentSession}
          diagnosticsRepository={diagnosticsRepository}
          sessions={sessions}
          onClose={() => setActivePanel(undefined)}
          onDeleteSession={onDeleteSession}
          onDuplicateSession={onDuplicateSession}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
        />
      )}
    </>
  );
}

function WorkspaceToolRail({
  activePanel,
  onSelectPanel,
}: {
  activePanel?: WorkspaceToolPanel;
  onSelectPanel: (panel: WorkspaceToolPanel) => void;
}) {
  const tools: Array<{ id: WorkspaceToolPanel; label: string; icon: typeof FolderOpen }> = [
    { id: "sessions", label: "会话", icon: FolderOpen },
    { id: "diagnostics", label: "执行日志", icon: ScrollText },
    { id: "skills", label: "Skill", icon: Wrench },
    { id: "settings", label: "设置", icon: Settings },
  ];

  return (
    <nav className="workspace-tool-rail" aria-label="工作台工具">
      {tools.map((tool) => {
        const Icon = tool.icon;

        return (
          <button
            className={activePanel === tool.id ? "workspace-tool-button active" : "workspace-tool-button"}
            key={tool.id}
            type="button"
            aria-pressed={activePanel === tool.id}
            onClick={() => onSelectPanel(tool.id)}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{tool.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function WorkspaceToolDrawer({
  activePanel,
  currentSession,
  diagnosticsRepository,
  sessions,
  onClose,
  onDeleteSession,
  onDuplicateSession,
  onNewSession,
  onSelectSession,
}: {
  activePanel: WorkspaceToolPanel;
  currentSession: TsnSession;
  diagnosticsRepository: DiagnosticLogRepository;
  sessions: TsnSession[];
  onClose: () => void;
  onDeleteSession: () => void;
  onDuplicateSession: () => void;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
}) {
  return (
    <aside className="workspace-tool-drawer" aria-label={workspacePanelLabel(activePanel)}>
      <div className="drawer-header">
        <div>
          <p className="drawer-kicker">{workspacePanelKicker(activePanel)}</p>
          <h2>{workspacePanelLabel(activePanel)}</h2>
        </div>
        <button className="icon-button" type="button" aria-label={`关闭${workspacePanelLabel(activePanel)}`} onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {activePanel === "sessions" && (
        <SessionToolPanel
          currentSession={currentSession}
          sessions={sessions}
          onDeleteSession={onDeleteSession}
          onDuplicateSession={onDuplicateSession}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
        />
      )}
      {activePanel === "diagnostics" && (
        <DiagnosticsLogView sessionId={currentSession.id} repository={diagnosticsRepository} />
      )}
      {activePanel === "skills" && <SkillToolPanel currentSession={currentSession} />}
      {activePanel === "settings" && <SettingsToolPanel version={appVersion} releases={releaseNotes} />}
    </aside>
  );
}

function SessionToolPanel({
  currentSession,
  sessions,
  onDeleteSession,
  onDuplicateSession,
  onNewSession,
  onSelectSession,
}: {
  currentSession: TsnSession;
  sessions: TsnSession[];
  onDeleteSession: () => void;
  onDuplicateSession: () => void;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
}) {
  return (
    <>
      <button className="new-session-button" type="button" onClick={onNewSession}>
        <Plus size={16} aria-hidden="true" />
        新建会话
      </button>

      <div className="session-list" aria-label="最近会话">
        {sessions.map((session) => (
          <button
            className={session.id === currentSession.id ? "session-item active" : "session-item"}
            key={session.id}
            type="button"
            onClick={() => onSelectSession(session)}
          >
            <div className="session-row1">
              <span className="session-title">{session.title}</span>
              <span className="session-time">{formatTime(session.updatedAt)}</span>
            </div>
            <p className="session-desc">{session.messages.at(-1)?.content ?? "暂无对话"}</p>
            <span className={session.topologyMutationId ? "badge planned" : "badge draft"}>
              <span className="badge-dot" />
              {session.topologyMutationId ? "配置草案" : "空会话"}
            </span>
          </button>
        ))}
      </div>

      <div className="drawer-actions">
        <button className="btn" type="button" onClick={onDuplicateSession}>
          <Copy size={15} aria-hidden="true" />
          复制当前
        </button>
        <button className="btn danger" type="button" onClick={onDeleteSession}>
          <Trash2 size={15} aria-hidden="true" />
          删除当前
        </button>
      </div>
    </>
  );
}

function SkillToolPanel({ currentSession }: { currentSession: TsnSession }) {
  const [selectedSkillId, setSelectedSkillId] = useState(SKILL_CATALOG[0]?.id);
  const selectedSkill = SKILL_CATALOG.find((skill) => skill.id === selectedSkillId) ?? SKILL_CATALOG[0];
  const recentEvent = selectedSkill
    ? [...currentSession.agentEvents]
      .reverse()
      .find((event) => event.skillName === selectedSkill.id || event.stage === selectedSkill.stage)
    : undefined;

  return (
    <div className="workspace-tool-panel split-panel">
      <p className="tool-panel-summary">
        查看当前工作台可调用的 TSN 阶段能力，并预览已注册 skill 的本地文件。
      </p>
      <div className="master-detail-layout skill-detail-layout">
        <div className="master-list" aria-label="Skill 列表">
          {SKILL_CATALOG.map((skill) => (
            <button
              className={selectedSkill?.id === skill.id ? "master-list-item active" : "master-list-item"}
              key={skill.id}
              type="button"
              aria-selected={selectedSkill?.id === skill.id}
              onClick={() => setSelectedSkillId(skill.id)}
            >
              <span className="tool-card-label mono">{skill.id}</span>
              <strong>{skill.displayName}</strong>
              <small>{skill.stageLabel}</small>
            </button>
          ))}
        </div>

        <section className="detail-surface skill-detail" aria-label="Skill 详情">
          {selectedSkill ? (
            <>
              <div className="detail-surface-header">
                <div>
                  <p className="drawer-kicker">Skill Detail</p>
                  <h3>{selectedSkill.displayName}</h3>
                </div>
                <span className={`skill-status ${selectedSkill.status}`}>{skillStatusLabel(selectedSkill.status)}</span>
              </div>

              <p className="detail-description">{selectedSkill.description}</p>
              <SkillFilePreview skillId={selectedSkill.id} />
              <div className="detail-grid">
                <DetailRow label="Skill ID" value={selectedSkill.id} />
                <DetailRow label="阶段" value={selectedSkill.stageLabel} />
                <DetailRow label="输入" value={selectedSkill.inputSummary} />
                <DetailRow label="输出" value={selectedSkill.outputSummary} />
                <DetailRow
                  label="最近运行"
                  value={recentEvent
                    ? `${redactProviderNamesForDisplay(recentEvent.title)} · ${formatTime(recentEvent.createdAt ?? currentSession.updatedAt)}`
                    : "当前会话暂无记录"}
                />
                <DetailRow label="备注" value={selectedSkill.notes || "无"} />
              </div>
            </>
          ) : (
            <div className="empty-panel mono">请选择一个 skill</div>
          )}
        </section>
      </div>
    </div>
  );
}

function SettingsToolPanel({ version, releases }: { version: string; releases: ReleaseNote[] }) {
  const defaultSelectedVersion = releases.find((release) => release.version === version)?.version ?? releases[0]?.version;
  const [selectedVersion, setSelectedVersion] = useState(defaultSelectedVersion);
  const selectedRelease = releases.find((release) => release.version === selectedVersion) ?? releases[0];

  useEffect(() => {
    setSelectedVersion(defaultSelectedVersion);
  }, [defaultSelectedVersion]);

  return (
    <div className="workspace-tool-panel split-panel">
      <p className="tool-panel-summary">集中管理工作台运行参数、版本号和客户可见的更新内容。</p>
      <div className="settings-list" aria-label="工作台设置">
        <DetailRow label="当前版本" value={`v${version}`} />
        <DetailRow label="默认规划服务" value={resolvePlannerBaseUrl()} />
        <DetailRow label="会话存储" value={window.__TAURI_INTERNALS__ ? "本机数据库" : "浏览器 localStorage"} />
        <DetailRow label="导出模式" value={window.__TAURI_INTERNALS__ ? "桌面文件系统" : "浏览器预览"} />
      </div>

      <section className="settings-release-panel" aria-label="更新日志">
        <div className="detail-surface-header">
          <div>
            <p className="drawer-kicker">Release Notes</p>
            <h3>更新日志</h3>
          </div>
        </div>
        {releases.length > 0 ? (
          <div className="master-detail-layout release-detail-layout">
            <div className="master-list release-version-list" aria-label="版本列表">
              {releases.map((release) => (
                <button
                  className={selectedRelease?.version === release.version ? "master-list-item active" : "master-list-item"}
                  key={release.version}
                  type="button"
                  aria-selected={selectedRelease?.version === release.version}
                  onClick={() => setSelectedVersion(release.version)}
                >
                  <span className="release-version mono">v{release.version}</span>
                  <strong>{release.version === version ? "当前版本" : `版本 ${release.version}`}</strong>
                  {release.date && <small>{release.date}</small>}
                </button>
              ))}
            </div>
            <ReleaseNoteDetail version={version} release={selectedRelease} />
          </div>
        ) : (
          <div className="empty-panel mono">暂无可展示的更新内容</div>
        )}
      </section>
    </div>
  );
}

function workspacePanelLabel(panel: WorkspaceToolPanel): string {
  const labels: Record<WorkspaceToolPanel, string> = {
    sessions: "会话管理",
    diagnostics: "执行日志",
    skills: "Skill 能力",
    settings: "工作台设置",
  };

  return labels[panel];
}

function workspacePanelKicker(panel: WorkspaceToolPanel): string {
  const labels: Record<WorkspaceToolPanel, string> = {
    sessions: "Sessions",
    diagnostics: "Diagnostics",
    skills: "Skills",
    settings: "Settings",
  };

  return labels[panel];
}

function ReleaseNoteDetail({ version, release }: { version: string; release?: ReleaseNote }) {
  if (!release) {
    return <div className="empty-panel mono">暂无可展示的更新内容</div>;
  }

  return (
    <article className="detail-surface release-note-detail" aria-label={`v${release.version} 更新内容`}>
      <div className="release-note-header">
        <div>
          <span className="release-version mono">v{release.version}</span>
          <h3>{release.version === version ? "当前版本" : `版本 ${release.version}`}</h3>
        </div>
        {release.date && <time dateTime={release.date}>{release.date}</time>}
      </div>
      <div className="release-category-list">
        {release.categories.map((category) => (
          <section className="release-category" key={`${release.version}-${category.title}`}>
            <h4>{category.title}</h4>
            <ul>
              {category.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}

function skillStatusLabel(status: SkillCatalogItem["status"]): string {
  const labels: Record<SkillCatalogItem["status"], string> = {
    enabled: "已启用",
    draft: "草稿",
    disabled: "已停用",
  };

  return labels[status];
}
