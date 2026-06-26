import { Download, FolderOpen, Plus, Settings, Trash2, Upload, Wrench, X } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { resolvePlannerBaseUrl } from "../../../planner/planner-contract";
import { appVersion, type ReleaseNote, releaseNotes } from "../../../release/release-info";
import type { TsnSession } from "../../../sessions/session-repository";
import { SKILL_CATALOG, type SkillCatalogItem } from "../../../skills/skill-catalog";
import { SkillFilePreview } from "../../../ui/skills/SkillFilePreview";
import {
  clearEvalForSession,
  clearEvalStore,
  exportEvalDataset,
  openEvalDir,
} from "../../eval-transfer";
import { getInetHostConfig, type InetHostConfig, setInetHostConfig } from "../../inet-host-config";
import type { TransferNotice } from "../../session-transfer";
import { DetailRow, formatTime } from "../shared";

export type WorkspaceToolPanel = "sessions" | "skills" | "settings";

export interface WorkspaceToolsProps {
  activePanel: WorkspaceToolPanel | undefined;
  setActivePanel: Dispatch<SetStateAction<WorkspaceToolPanel | undefined>>;
  currentSession: TsnSession;
  sessions: TsnSession[];
  transferNotice: TransferNotice | undefined;
  transferBusy: boolean;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
  onDeleteSession: () => void;
  onExportSession: () => void;
  onImportSession: () => void;
  onRevealExport: (path: string) => void;
}

export function WorkspaceTools({
  activePanel,
  setActivePanel,
  currentSession,
  sessions,
  transferNotice,
  transferBusy,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onExportSession,
  onImportSession,
  onRevealExport,
}: WorkspaceToolsProps) {
  return (
    <>
      <WorkspaceToolRail
        activePanel={activePanel}
        onSelectPanel={(panel) =>
          setActivePanel((current) => (current === panel ? undefined : panel))
        }
      />
      {activePanel && (
        <WorkspaceToolDrawer
          activePanel={activePanel}
          currentSession={currentSession}
          sessions={sessions}
          transferNotice={transferNotice}
          transferBusy={transferBusy}
          onClose={() => setActivePanel(undefined)}
          onDeleteSession={onDeleteSession}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onExportSession={onExportSession}
          onImportSession={onImportSession}
          onRevealExport={onRevealExport}
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
    { id: "skills", label: "Skill", icon: Wrench },
    { id: "settings", label: "设置", icon: Settings },
  ];

  return (
    <nav className="workspace-tool-rail" aria-label="工作台工具">
      {tools.map((tool) => {
        const Icon = tool.icon;

        return (
          <button
            className={
              activePanel === tool.id ? "workspace-tool-button active" : "workspace-tool-button"
            }
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
  sessions,
  transferNotice,
  transferBusy,
  onClose,
  onDeleteSession,
  onNewSession,
  onSelectSession,
  onExportSession,
  onImportSession,
  onRevealExport,
}: {
  activePanel: WorkspaceToolPanel;
  currentSession: TsnSession;
  sessions: TsnSession[];
  transferNotice: TransferNotice | undefined;
  transferBusy: boolean;
  onClose: () => void;
  onDeleteSession: () => void;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
  onExportSession: () => void;
  onImportSession: () => void;
  onRevealExport: (path: string) => void;
}) {
  return (
    <aside className="workspace-tool-drawer" aria-label={workspacePanelLabel(activePanel)}>
      <div className="drawer-header">
        <div>
          <p className="drawer-kicker">{workspacePanelKicker(activePanel)}</p>
          <h2>{workspacePanelLabel(activePanel)}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={`关闭${workspacePanelLabel(activePanel)}`}
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {activePanel === "sessions" && (
        <SessionToolPanel
          currentSession={currentSession}
          sessions={sessions}
          transferNotice={transferNotice}
          transferBusy={transferBusy}
          onDeleteSession={onDeleteSession}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onExportSession={onExportSession}
          onImportSession={onImportSession}
          onRevealExport={onRevealExport}
        />
      )}
      {activePanel === "skills" && <SkillToolPanel />}
      {activePanel === "settings" && (
        <SettingsToolPanel
          version={appVersion}
          releases={releaseNotes}
          currentSessionId={currentSession.id}
          onClose={onClose}
        />
      )}
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
  transferNotice,
  transferBusy,
  onDeleteSession,
  onNewSession,
  onSelectSession,
  onExportSession,
  onImportSession,
  onRevealExport,
}: {
  currentSession: TsnSession;
  sessions: TsnSession[];
  transferNotice: TransferNotice | undefined;
  transferBusy: boolean;
  onDeleteSession: () => void;
  onNewSession: () => void;
  onSelectSession: (session: TsnSession) => void;
  onExportSession: () => void;
  onImportSession: () => void;
  onRevealExport: (path: string) => void;
}) {
  return (
    <>
      <button className="new-session-button" type="button" onClick={onNewSession}>
        <Plus size={16} aria-hidden="true" />
        新建会话
      </button>

      <div className="session-list" role="group" aria-label="最近会话">
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
            <span className={session.topologyMutationId ? "badge planned" : "badge draft"}>
              <span className="badge-dot" />
              {session.topologyMutationId ? "配置草案" : "空会话"}
            </span>
          </button>
        ))}
      </div>

      <div className="drawer-actions three-up">
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
        <button className="btn danger" type="button" onClick={onDeleteSession}>
          <Trash2 size={15} aria-hidden="true" />
          删除当前
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
    </>
  );
}

function EvalToolPanel({ currentSessionId }: { currentSessionId: string }) {
  const [notice, setNotice] = useState<string | undefined>();

  const handle = async (action: () => Promise<string>) => {
    try {
      setNotice(await action());
    } catch (error) {
      setNotice(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <section className="settings-eval-section" aria-label="评估采集">
      <h3 className="settings-eval-section__title">评估采集</h3>
      <p className="tool-panel-summary">
        每次与大模型的交互都原样保存为 eval 样本（不脱敏、含密钥原文），用于离线评估。 数据存在本机
        eval 目录，删除会话不会删除它——隐私清除请用下方按钮。
      </p>
      <div className="drawer-actions three-up">
        <button
          className="btn"
          type="button"
          onClick={() =>
            handle(async () => {
              await openEvalDir();
              return "已打开 eval 目录";
            })
          }
        >
          <FolderOpen size={15} aria-hidden="true" />
          打开目录
        </button>
        <button
          className="btn"
          type="button"
          onClick={() =>
            handle(async () => {
              const outcome = await exportEvalDataset();
              if (outcome.status === "error") {
                throw new Error(outcome.message);
              }
              return outcome.status === "done" ? `已导出到 ${outcome.path}` : "已取消导出";
            })
          }
        >
          <Download size={15} aria-hidden="true" />
          导出数据集
        </button>
        <button
          className="btn"
          type="button"
          onClick={() =>
            handle(async () => {
              await clearEvalForSession(currentSessionId);
              return "已清除当前会话的 eval 样本";
            })
          }
        >
          <Trash2 size={15} aria-hidden="true" />
          清除当前会话
        </button>
      </div>
      <div className="drawer-actions">
        <button
          className="btn danger"
          type="button"
          onClick={() =>
            handle(async () => {
              await clearEvalStore();
              return "已清空全部 eval 样本";
            })
          }
        >
          <Trash2 size={15} aria-hidden="true" />
          清空全部 eval
        </button>
      </div>
      {notice && (
        <p className="transfer-notice" role="status">
          <span>{notice}</span>
        </p>
      )}
    </section>
  );
}

function SkillToolPanel() {
  const [selectedSkillId, setSelectedSkillId] = useState(SKILL_CATALOG[0]?.id);
  const selectedSkill =
    SKILL_CATALOG.find((skill) => skill.id === selectedSkillId) ?? SKILL_CATALOG[0];

  return (
    <div className="workspace-tool-panel split-panel">
      <p className="tool-panel-summary">
        查看当前工作台可调用的 TSN 阶段能力，并预览已注册 skill 的本地文件。
      </p>
      <div className="master-detail-layout skill-detail-layout">
        <div className="master-list" role="group" aria-label="Skill 列表">
          {SKILL_CATALOG.map((skill) => (
            <button
              className={
                selectedSkill?.id === skill.id ? "master-list-item active" : "master-list-item"
              }
              key={skill.id}
              type="button"
              aria-current={selectedSkill?.id === skill.id}
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
              {/* 描述 + 状态一行带过：标题已由上方选中卡片承担，不再重复占位。 */}
              <div className="skill-detail-meta">
                <p className="detail-description">{selectedSkill.description}</p>
                <span className={`skill-status ${selectedSkill.status}`}>
                  {skillStatusLabel(selectedSkill.status)}
                </span>
              </div>
              <SkillFilePreview skillId={selectedSkill.id} />
            </>
          ) : (
            <div className="empty-panel mono">请选择一个 skill</div>
          )}
        </section>
      </div>
    </div>
  );
}

const HOST_KEY_HINT = "新主机首次连接需先手动 ssh 建立 host key 信任";

/**
 * U5：远端 INET 主机配置表单（host / user / INET 环境命令，自由输入）。
 * doc-review 决定：显式「保存」提交（非 blur 自动存）；保存后关抽屉；关闭不保存则回滚
 * （表单 form-local，重开时重新从后端加载）。known_hosts 常驻提示挂在主机输入框下方。
 */
function InetHostConfigForm({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<InetHostConfig | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    getInetHostConfig()
      .then((loaded) => {
        if (!cancelled) {
          setConfig(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("读取远端主机配置失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!config || saving) {
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await setInetHostConfig(config);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-host-form" aria-label="远端仿真主机">
      <div className="detail-surface-header">
        <div>
          <p className="drawer-kicker">Remote Host</p>
          <h3>远端仿真主机</h3>
        </div>
      </div>
      {config ? (
        <div className="host-form-fields">
          <label className="sim-field">
            <span>主机</span>
            <input
              type="text"
              value={config.host}
              onChange={(event) => setConfig({ ...config, host: event.target.value })}
            />
          </label>
          <p className="host-form-hint">{HOST_KEY_HINT}</p>
          <label className="sim-field">
            <span>用户名</span>
            <input
              type="text"
              value={config.user}
              onChange={(event) => setConfig({ ...config, user: event.target.value })}
            />
          </label>
          <label className="sim-field">
            <span>INET 环境命令</span>
            <input
              type="text"
              value={config.inetEnvCmd}
              onChange={(event) => setConfig({ ...config, inetEnvCmd: event.target.value })}
            />
          </label>
          <p className="host-form-hint">
            在此环境里跑 inet 与 opp_scavetool（如 opp_env wrapper），app 以 “命令 -c 实际指令”
            方式调用。一般用默认即可。
          </p>
          <label className="sim-field">
            <span>运行目录</span>
            <input
              type="text"
              value={config.baseDir}
              onChange={(event) => setConfig({ ...config, baseDir: event.target.value })}
            />
          </label>
          <p className="host-form-hint">
            远端运行目录的父目录，每次软仿在其下建 run-&lt;随机&gt; 子目录。目录保留不删（默认
            /tmp，重启自动清），可 SSH 进去看实际 ini/ned 与 results/。换主机若家目录不同记得改。
          </p>
          <div className="drawer-actions">
            <button
              className="btn primary"
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              保存
            </button>
          </div>
          {error && (
            <p className="transfer-notice error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="empty-panel mono">{error ?? "加载中…"}</div>
      )}
    </section>
  );
}

function SettingsToolPanel({
  version,
  releases,
  currentSessionId,
  onClose,
}: {
  version: string;
  releases: ReleaseNote[];
  currentSessionId: string;
  onClose: () => void;
}) {
  const defaultSelectedVersion =
    releases.find((release) => release.version === version)?.version ?? releases[0]?.version;
  const [selectedVersion, setSelectedVersion] = useState(defaultSelectedVersion);
  const selectedRelease =
    releases.find((release) => release.version === selectedVersion) ?? releases[0];

  useEffect(() => {
    setSelectedVersion(defaultSelectedVersion);
  }, [defaultSelectedVersion]);

  return (
    <div className="workspace-tool-panel split-panel">
      <p className="tool-panel-summary">集中管理工作台运行参数、版本号和客户可见的更新内容。</p>
      <div className="settings-list" role="group" aria-label="工作台设置">
        <DetailRow label="当前版本" value={`v${version}`} />
        <DetailRow label="默认规划服务" value={resolvePlannerBaseUrl()} />
        <DetailRow
          label="会话存储"
          value={window.__TAURI_INTERNALS__ ? "本机数据库" : "浏览器 localStorage"}
        />
        <DetailRow
          label="导出模式"
          value={window.__TAURI_INTERNALS__ ? "桌面文件系统" : "浏览器预览"}
        />
      </div>

      <EvalToolPanel currentSessionId={currentSessionId} />

      <InetHostConfigForm onClose={onClose} />

      <section className="settings-release-panel" aria-label="更新日志">
        <div className="detail-surface-header">
          <div>
            <p className="drawer-kicker">Release Notes</p>
            <h3>更新日志</h3>
          </div>
        </div>
        {releases.length > 0 ? (
          <div className="master-detail-layout release-detail-layout">
            <div className="master-list release-version-list" role="group" aria-label="版本列表">
              {releases.map((release) => (
                <button
                  className={
                    selectedRelease?.version === release.version
                      ? "master-list-item active"
                      : "master-list-item"
                  }
                  key={release.version}
                  type="button"
                  aria-current={selectedRelease?.version === release.version}
                  onClick={() => setSelectedVersion(release.version)}
                >
                  <span className="release-version mono">v{release.version}</span>
                  <strong>
                    {release.version === version ? "当前版本" : `版本 ${release.version}`}
                  </strong>
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
    skills: "Skill 能力",
    settings: "工作台设置",
  };

  return labels[panel];
}

function workspacePanelKicker(panel: WorkspaceToolPanel): string {
  const labels: Record<WorkspaceToolPanel, string> = {
    sessions: "Sessions",
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
    <article
      className="detail-surface release-note-detail"
      aria-label={`v${release.version} 更新内容`}
    >
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
