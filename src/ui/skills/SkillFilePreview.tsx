import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, Pencil, RotateCcw } from "lucide-react";
import type { StageSkillName } from "../../agent/stage-skill-contract";
import {
  createSkillFileService,
  type RestoreFactorySkillsResult,
  type SkillFileContent,
  type SkillFileEntry,
  type SkillFileListResult,
  type SkillFileService,
  type TopologyParam,
  type TopologyTemplateCatalog,
} from "../../skills/skill-file-service";

const defaultSkillFileService = createSkillFileService();

type CatalogState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; catalog: TopologyTemplateCatalog }
  | { kind: "unavailable"; message: string };

type RestoreState =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "confirming"; plan: RestoreFactorySkillsResult }
  | { kind: "restoring" }
  | { kind: "done"; result: RestoreFactorySkillsResult };

export function SkillFilePreview({
  skillId,
  service = defaultSkillFileService,
}: {
  skillId: StageSkillName;
  service?: SkillFileService;
}) {
  const [fileList, setFileList] = useState<SkillFileListResult>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [content, setContent] = useState<SkillFileContent>();
  const [draft, setDraft] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string>();
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: "idle" });
  const [restoreState, setRestoreState] = useState<RestoreState>({ kind: "idle" });
  const [reloadToken, setReloadToken] = useState(0);

  const isTopologySkill = skillId === "tsn-topology";
  // 恢复确认/执行期间锁编辑：确认清单是按当下盘面枚举的，窗口内的保存会被
  // 恢复覆盖却不在清单里（确认内容与实际操作漂移）。
  const isRestoreLocked = restoreState.kind === "confirming" || restoreState.kind === "restoring";

  const previewableFiles = useMemo(
    () => fileList?.files.filter((file) => file.canPreview) ?? [],
    [fileList],
  );
  const selectedFile = fileList?.files.find((file) => file.path === selectedPath);
  const hasDraftChanges = content ? draft !== content.content : false;
  const effectiveText = isEditing ? draft : content?.content ?? "";
  const showEmptyGuidanceHint =
    isTopologySkill &&
    selectedPath === "SKILL.md" &&
    Boolean(content?.editable) &&
    effectiveText.trim() === "";

  useEffect(() => {
    let cancelled = false;

    setIsLoadingList(true);
    setError(undefined);
    setFileList(undefined);
    setContent(undefined);
    setSelectedPath(undefined);
    setIsEditing(false);
    setSavedNotice(false);

    service
      .listFiles(skillId)
      .then((result) => {
        if (cancelled) {
          return;
        }

        setFileList(result);
        const defaultPath =
          result.files.find((file) => file.path === "SKILL.md" && file.canPreview)?.path
          ?? result.files.find((file) => file.canPreview)?.path;
        setSelectedPath(defaultPath);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingList(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [service, skillId, reloadToken]);

  useEffect(() => {
    if (!isTopologySkill) {
      setCatalogState({ kind: "idle" });
      return;
    }

    let cancelled = false;
    setCatalogState({ kind: "loading" });

    service
      .describeTopologyTemplates()
      .then((catalog) => {
        if (!cancelled) {
          setCatalogState({ kind: "ready", catalog });
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setCatalogState({ kind: "unavailable", message: errorMessage(cause) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [service, skillId, isTopologySkill]);

  useEffect(() => {
    if (!selectedPath) {
      setContent(undefined);
      setDraft("");
      setIsEditing(false);
      return;
    }

    let cancelled = false;

    setIsLoadingContent(true);
    setError(undefined);
    setContent(undefined);
    setIsEditing(false);
    setSavedNotice(false);

    service
      .readFile(skillId, selectedPath)
      .then((result) => {
        if (cancelled) {
          return;
        }

        setContent(result);
        setDraft(result.content);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingContent(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [service, skillId, selectedPath]);

  function selectFile(file: SkillFileEntry) {
    if (!file.canPreview) {
      setError(file.reason ?? "该文件当前不可预览。");
      return;
    }

    setSelectedPath(file.path);
  }

  function startEditing() {
    setSavedNotice(false);
    setIsEditing(true);
  }

  async function saveDraft() {
    if (!content || !hasDraftChanges || !content.editable || isRestoreLocked) {
      return;
    }

    setIsSaving(true);
    setError(undefined);

    try {
      const saved = await service.writeFile(skillId, content.path, draft);
      setContent(saved);
      setDraft(saved.content);
      setIsEditing(false);
      setSavedNotice(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsSaving(false);
    }
  }

  // 恢复内置版本（R2）：dryRun 枚举差异清单 → 内联确认 → 执行并刷新列表。
  // 影响全部 skill（不止当前 tab）；dev 直连仓库/Resource 缺失由后端报错说明。
  async function previewRestore() {
    setRestoreState({ kind: "previewing" });
    setError(undefined);
    try {
      const plan = await service.restoreFactorySkills(true);
      setRestoreState({ kind: "confirming", plan });
    } catch (cause) {
      setError(errorMessage(cause));
      setRestoreState({ kind: "idle" });
    }
  }

  async function confirmRestore() {
    setRestoreState({ kind: "restoring" });
    setError(undefined);
    try {
      const result = await service.restoreFactorySkills(false);
      setRestoreState({ kind: "done", result });
      setReloadToken((token) => token + 1);
    } catch (cause) {
      setError(errorMessage(cause));
      setRestoreState({ kind: "idle" });
    }
  }

  return (
    <section className="skill-files-panel" aria-label="Skill 文件">
      <div className="skill-files-header">
        <small>编辑会保存到当前选中的 skill 文件，下次 agent 运行生效。</small>
        <div className="skill-files-header-actions">
          <button
            className="btn"
            type="button"
            onClick={previewRestore}
            disabled={
              fileList?.status !== "available"
              || restoreState.kind === "previewing"
              || restoreState.kind === "restoring"
              || restoreState.kind === "confirming"
            }
          >
            <RotateCcw size={14} aria-hidden="true" />
            {restoreState.kind === "previewing" ? "正在比对..." : "恢复内置版本"}
          </button>
          {fileList?.status && <span className={`skill-file-status ${fileList.status}`}>{rootStatusLabel(fileList.status)}</span>}
        </div>
      </div>

      {error && <div className="skill-file-error">{error}</div>}

      {restoreState.kind === "confirming" && (
        <div className="skill-restore-confirm" role="alertdialog" aria-label="恢复内置版本确认">
          <p>将把全部 skill 文件恢复为内置出厂版本（影响所有 skill，下次 agent 运行生效）：</p>
          <ul>
            <li>
              {restoreState.plan.restored.length > 0
                ? `恢复 ${restoreState.plan.restored.length} 个文件：${restoreState.plan.restored.join("、")}`
                : "没有需要恢复的文件（已与内置版本一致）"}
            </li>
            {restoreState.plan.removed.length > 0 && (
              <li>删除 {restoreState.plan.removed.length} 个出厂已移除文件：{restoreState.plan.removed.join("、")}</li>
            )}
            {restoreState.plan.preserved.length > 0 && (
              <li>自建文件不受影响：{restoreState.plan.preserved.join("、")}</li>
            )}
          </ul>
          <div className="skill-file-actions">
            <button
              className="btn-primary"
              type="button"
              onClick={confirmRestore}
              disabled={restoreState.plan.restored.length === 0 && restoreState.plan.removed.length === 0}
            >
              确认恢复
            </button>
            <button className="btn" type="button" onClick={() => setRestoreState({ kind: "idle" })}>
              取消
            </button>
          </div>
        </div>
      )}

      {restoreState.kind === "done" && (
        <div className="skill-file-saved-notice" role="status">
          已恢复内置版本（恢复 {restoreState.result.restored.length} 个、删除 {restoreState.result.removed.length} 个文件），下次 agent 运行生效。
          {restoreState.result.warning ? ` ${restoreState.result.warning}` : ""}
        </div>
      )}

      {isLoadingList ? (
        <div className="empty-panel mono">正在加载 skill 文件...</div>
      ) : (
        <div className="skill-files-layout">
          <div className="skill-file-list" aria-label="Skill 文件列表">
            {fileList?.files.length ? (
              fileList.files.map((file) => (
                <button
                  className={selectedPath === file.path ? "skill-file-item active" : "skill-file-item"}
                  key={file.path}
                  type="button"
                  aria-selected={selectedPath === file.path}
                  onClick={() => selectFile(file)}
                >
                  <FileText size={14} aria-hidden="true" />
                  <span className="mono">{file.path}</span>
                  <small>{file.canPreview ? formatSize(file.sizeBytes) : file.reason ?? "不可预览"}</small>
                </button>
              ))
            ) : (
              <div className="empty-panel mono">{fileList?.message ?? "暂无文件"}</div>
            )}
          </div>

          <div className="skill-file-preview">
            {isLoadingContent ? (
              <div className="empty-panel mono">正在读取文件...</div>
            ) : content ? (
              <>
                <div className="skill-file-preview-header">
                  <div>
                    <span className="mono">{content.path}</span>
                  </div>
                  <div className="skill-file-actions">
                    {content.editable ? (
                      isEditing ? (
                        <>
                          <button
                            className="btn-primary"
                            type="button"
                            onClick={saveDraft}
                            disabled={!hasDraftChanges || isSaving || isRestoreLocked}
                          >
                            {isSaving ? "保存中..." : "保存"}
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => {
                              setDraft(content.content);
                              setIsEditing(false);
                            }}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button className="btn" type="button" onClick={startEditing} disabled={isRestoreLocked}>
                          <Pencil size={14} aria-hidden="true" />
                          编辑文件
                        </button>
                      )
                    ) : null}
                  </div>
                </div>
                {!content.editable && (
                  <div className="skill-file-readonly-notice" role="note">
                    当前为只读指引（可写副本不可用时的兜底）{content.readonlyReason ? `：${content.readonlyReason}` : ""}
                  </div>
                )}
                {savedNotice && !isEditing && (
                  <div className="skill-file-saved-notice" role="status">
                    已保存，下次 agent 运行生效。
                  </div>
                )}
                {showEmptyGuidanceHint && (
                  <div className="skill-file-empty-hint" role="note">
                    指引为空：清空将使 agent 失去领域指引，下次运行生效。
                  </div>
                )}
                {isEditing ? (
                  <textarea
                    className="skill-file-editor mono"
                    value={draft}
                    aria-label="Skill 文件内容"
                    onChange={(event) => setDraft(event.target.value)}
                  />
                ) : content.path.endsWith(".md") ? (
                  <MarkdownFileView text={content.content} />
                ) : (
                  <pre className="skill-file-content">{content.content}</pre>
                )}
              </>
            ) : selectedFile && !selectedFile.canPreview ? (
              <div className="empty-panel mono">{selectedFile.reason ?? "该文件当前不可预览"}</div>
            ) : previewableFiles.length === 0 ? (
              <div className="empty-panel mono">暂无可预览文本文件</div>
            ) : (
              <div className="empty-panel mono">请选择一个文件</div>
            )}
          </div>
        </div>
      )}

      {isTopologySkill && <TopologyLegalDomain state={catalogState} />}
    </section>
  );
}

/** .md 预览：frontmatter 折成顶部 meta 块，正文走 react-markdown（GFM）。 */
function MarkdownFileView({ text }: { text: string }) {
  const { frontmatter, body } = splitFrontmatter(text);

  return (
    <div className="skill-file-markdown">
      {frontmatter && <pre className="skill-file-frontmatter mono">{frontmatter}</pre>}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}

function splitFrontmatter(text: string): { frontmatter?: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    return { body: text };
  }

  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function TopologyLegalDomain({ state }: { state: CatalogState }) {
  return (
    <section className="skill-legal-domain" aria-label="参数合法域">
      <div className="skill-legal-domain-header">
        <h5>参数合法域</h5>
        <small>来自 MCP describe_templates，只读、不可编辑。</small>
      </div>
      {state.kind === "loading" && <div className="empty-panel mono">正在加载参数合法域...</div>}
      {state.kind === "unavailable" && (
        <div className="empty-panel mono">参数合法域当前不可用：{state.message}</div>
      )}
      {state.kind === "ready" && (
        <div className="skill-legal-domain-templates">
          {state.catalog.templates.map((template) => (
            <div className="skill-legal-domain-template" key={template.id}>
              <span className="mono">{template.id}</span>
              <dl className="skill-legal-domain-params">
                {template.params.map((param) => (
                  <div className="skill-legal-domain-param" key={param.name}>
                    <dt className="mono">{param.name}</dt>
                    <dd>{paramConstraint(param)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function paramConstraint(param: TopologyParam): string {
  if (typeof param.minimum === "number" && typeof param.maximum === "number") {
    return `${param.type} ${param.minimum}–${param.maximum}`;
  }

  if (Array.isArray(param.values) && param.values.length > 0) {
    return `枚举 ${param.values.join(" / ")}`;
  }

  return param.type;
}

function rootStatusLabel(status: SkillFileListResult["status"]): string {
  switch (status) {
    case "available":
      return "可编辑";
    case "readonly":
      return "只读";
    case "unavailable":
      return "暂无目录";
  }
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  return `${Math.round(sizeBytes / 102.4) / 10} KB`;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
}
