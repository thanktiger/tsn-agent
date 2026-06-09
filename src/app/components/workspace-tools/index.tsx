import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  Copy,
  Download,
  FolderOpen,
  Plus,
  ScrollText,
  Settings,
  Trash2,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import type { DiagnosticLogRepository } from "../../../diagnostics/diagnostic-log-repository";
import { DiagnosticsLogView } from "../../../ui/diagnostics/DiagnosticsDrawer";
import { SkillFilePreview } from "../../../ui/skills/SkillFilePreview";
import { resolvePlannerBaseUrl } from "../../../planner/planner-contract";
import { appVersion, releaseNotes, type ReleaseNote } from "../../../release/release-info";
import type { TsnSession } from "../../../sessions/session-repository";
import { SKILL_CATALOG, type SkillCatalogItem } from "../../../skills/skill-catalog";
import { DetailRow, formatTime } from "../shared";
import { describeBackfillError, type BackfillFailureRow } from "../../hooks/use-backfill-failures";
import type { TransferNotice } from "../../session-transfer";

export type WorkspaceToolPanel = "sessions" | "diagnostics" | "skills" | "settings";

export interface WorkspaceToolsProps {
  activePanel: WorkspaceToolPanel | undefined;
  setActivePanel: Dispatch<SetStateAction<WorkspaceToolPanel | undefined>>;
  currentSession: TsnSession;
  sessions: TsnSession[];
  diagnosticsRepository: DiagnosticLogRepository;
  backfillFailures: BackfillFailureRow[];
  transferNotice: TransferNotice | undefined;
  transferBusy: boolean;
  payloadView: { sessionId: string; text: string } | undefined;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
  onDuplicateSession: () => void;
  onDeleteSession: () => void;
  onExportSession: () => void;
  onImportSession: () => void;
  onViewPayload: (sessionId: string) => void;
  onRequestRetry: (sessionId: string) => void;
  onRevealExport: (path: string) => void;
  onClosePayloadView: () => void;
}

export function WorkspaceTools({
  activePanel,
  setActivePanel,
  currentSession,
  sessions,
  diagnosticsRepository,
  backfillFailures,
  transferNotice,
  transferBusy,
  payloadView,
  onNewSession,
  onSelectSession,
  onDuplicateSession,
  onDeleteSession,
  onExportSession,
  onImportSession,
  onViewPayload,
  onRequestRetry,
  onRevealExport,
  onClosePayloadView,
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
          backfillFailures={backfillFailures}
          transferNotice={transferNotice}
          transferBusy={transferBusy}
          payloadView={payloadView}
          onClose={() => setActivePanel(undefined)}
          onDeleteSession={onDeleteSession}
          onDuplicateSession={onDuplicateSession}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onExportSession={onExportSession}
          onImportSession={onImportSession}
          onViewPayload={onViewPayload}
          onRequestRetry={onRequestRetry}
          onRevealExport={onRevealExport}
          onClosePayloadView={onClosePayloadView}
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
  backfillFailures,
  transferNotice,
  transferBusy,
  payloadView,
  onClose,
  onDeleteSession,
  onDuplicateSession,
  onNewSession,
  onSelectSession,
  onExportSession,
  onImportSession,
  onViewPayload,
  onRequestRetry,
  onRevealExport,
  onClosePayloadView,
}: {
  activePanel: WorkspaceToolPanel;
  currentSession: TsnSession;
  diagnosticsRepository: DiagnosticLogRepository;
  sessions: TsnSession[];
  backfillFailures: BackfillFailureRow[];
  transferNotice: TransferNotice | undefined;
  transferBusy: boolean;
  payloadView: { sessionId: string; text: string } | undefined;
  onClose: () => void;
  onDeleteSession: () => void;
  onDuplicateSession: () => void;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
  onExportSession: () => void;
  onImportSession: () => void;
  onViewPayload: (sessionId: string) => void;
  onRequestRetry: (sessionId: string) => void;
  onRevealExport: (path: string) => void;
  onClosePayloadView: () => void;
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
          backfillFailures={backfillFailures}
          transferNotice={transferNotice}
          transferBusy={transferBusy}
          payloadView={payloadView}
          onDeleteSession={onDeleteSession}
          onDuplicateSession={onDuplicateSession}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onExportSession={onExportSession}
          onImportSession={onImportSession}
          onViewPayload={onViewPayload}
          onRequestRetry={onRequestRetry}
          onRevealExport={onRevealExport}
          onClosePayloadView={onClosePayloadView}
        />
      )}
      {activePanel === "diagnostics" && (
        <DiagnosticsLogView sessionId={currentSession.id} repository={diagnosticsRepository} />
      )}
      {activePanel === "skills" && <SkillToolPanel />}
      {activePanel === "settings" && <SettingsToolPanel version={appVersion} releases={releaseNotes} />}
    </aside>
  );
}

/**
 * 会话列表预览取最后一条自然语言消息。
 * 工具调用/结果以 `[工具]` 开头存进 assistant 消息（agent 渲染层约定），
 * 列表不展示这类内部 trace，回退到最近的对话内容。
 */
function sessionPreview(messages: TsnSession["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content ?? "";
    if (!content.startsWith("[工具]")) {
      return content;
    }
  }
  return "暂无对话";
}

function SessionToolPanel({
  currentSession,
  sessions,
  backfillFailures,
  transferNotice,
  transferBusy,
  payloadView,
  onDeleteSession,
  onDuplicateSession,
  onNewSession,
  onSelectSession,
  onExportSession,
  onImportSession,
  onViewPayload,
  onRequestRetry,
  onRevealExport,
  onClosePayloadView,
}: {
  currentSession: TsnSession;
  sessions: TsnSession[];
  backfillFailures: BackfillFailureRow[];
  transferNotice: TransferNotice | undefined;
  transferBusy: boolean;
  payloadView: { sessionId: string; text: string } | undefined;
  onDeleteSession: () => void;
  onDuplicateSession: () => void;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
  onExportSession: () => void;
  onImportSession: () => void;
  onViewPayload: (sessionId: string) => void;
  onRequestRetry: (sessionId: string) => void;
  onRevealExport: (path: string) => void;
  onClosePayloadView: () => void;
}) {
  const failedSessionIds = new Set(backfillFailures.map((failure) => failure.sessionId));
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
            <p className="session-desc">{sessionPreview(session.messages)}</p>
            {failedSessionIds.has(session.id) ? (
              <span className="badge failed">
                <span className="badge-dot" />
                迁移失败
              </span>
            ) : (
              <span className={session.topologyMutationId ? "badge planned" : "badge draft"}>
                <span className="badge-dot" />
                {session.topologyMutationId ? "配置草案" : "空会话"}
              </span>
            )}
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

      <div className="drawer-actions">
        <button
          className="btn"
          type="button"
          disabled={transferBusy}
          title={transferBusy ? "智能助手运行中，暂不可导出" : "把当前会话的拓扑数据导出为文件"}
          onClick={onExportSession}
        >
          <Download size={15} aria-hidden="true" />
          导出当前
        </button>
        <button
          className="btn"
          type="button"
          disabled={transferBusy}
          title={transferBusy ? "智能助手运行中，暂不可导入" : "从导出文件导入会话"}
          onClick={onImportSession}
        >
          <Upload size={15} aria-hidden="true" />
          导入会话
        </button>
      </div>

      {transferNotice && (
        <p className={`transfer-notice ${transferNotice.kind}`} role="status">
          <span>{transferNotice.text}</span>
          {transferNotice.path && (
            <button
              className="link-button"
              type="button"
              onClick={() => transferNotice.path && onRevealExport(transferNotice.path)}
            >
              在 Finder 中显示
            </button>
          )}
        </p>
      )}

      {backfillFailures.length > 0 && (
        <div className="backfill-failures" aria-label="待恢复会话">
          <p className="drawer-kicker">待恢复会话</p>
          {backfillFailures.map((failure) => (
            <div className="backfill-failure-item" key={failure.sessionId}>
              <div className="failure-row1">
                <span className="failure-desc">{describeBackfillError(failure.errorCode)}</span>
                <span className="failure-session mono">{failure.sessionId.slice(0, 18)}</span>
              </div>
              <div className="failure-actions">
                <button
                  className="link-button"
                  type="button"
                  onClick={() => onViewPayload(failure.sessionId)}
                >
                  查看原始数据
                </button>
                <button
                  className="btn danger"
                  type="button"
                  disabled={transferBusy}
                  title={transferBusy ? "智能助手运行中，暂不可重建" : "从原始数据重建该会话的拓扑"}
                  onClick={() => onRequestRetry(failure.sessionId)}
                >
                  重建
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {payloadView && (
        <div className="payload-view" aria-label="原始数据预览">
          <div className="payload-view-header">
            <span className="mono">{payloadView.sessionId.slice(0, 18)}</span>
            <div className="failure-actions">
              <button
                className="link-button"
                type="button"
                onClick={() => void navigator.clipboard?.writeText(payloadView.text)}
              >
                复制全部
              </button>
              <button className="link-button" type="button" onClick={onClosePayloadView}>
                关闭
              </button>
            </div>
          </div>
          <pre className="payload-view-body">{payloadView.text}</pre>
        </div>
      )}
    </>
  );
}

function SkillToolPanel() {
  const [selectedSkillId, setSelectedSkillId] = useState(SKILL_CATALOG[0]?.id);
  const selectedSkill = SKILL_CATALOG.find((skill) => skill.id === selectedSkillId) ?? SKILL_CATALOG[0];

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
