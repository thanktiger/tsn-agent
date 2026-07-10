import { invoke } from "@tauri-apps/api/core";

/** 落地页工程模板（后端 project_templates 行的 camelCase 视图）。 */
export interface TemplateRow {
  id: string;
  /** prompt = 构建 prompt（点卡即提交 agent）；snapshot = 拓扑快照（确定性重建）。 */
  kind: "prompt" | "snapshot";
  scenarioConfigId: string;
  title: string;
  subtitle?: string | null;
  /** kind=prompt 时的构建 prompt；snapshot 行为 null。 */
  promptText?: string | null;
  sortOrder: number;
  origin: "factory" | "user";
}

export interface CreateSnapshotRequest {
  sessionId: string;
  title: string;
  /** 来源 session 的 scenario（前端持有，显式传后端，见 plan KTD7）。 */
  scenarioConfigId: string;
}

export interface UseSnapshotResult {
  scenarioConfigId: string;
  mutationId: number;
}

export interface TemplateService {
  listTemplates(): Promise<TemplateRow[]>;
  deleteTemplate(id: string): Promise<void>;
  reorderTemplates(orderedIds: string[]): Promise<void>;
  createSnapshotTemplate(request: CreateSnapshotRequest): Promise<void>;
  useSnapshotTemplate(templateId: string, sessionId: string): Promise<UseSnapshotResult>;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createTemplateService(): TemplateService {
  if (!isTauriRuntime()) {
    return createBrowserTemplateService();
  }

  return {
    listTemplates() {
      return invoke<TemplateRow[]>("list_project_templates");
    },
    deleteTemplate(id) {
      return invoke<void>("delete_project_template", { id });
    },
    reorderTemplates(orderedIds) {
      return invoke<void>("reorder_project_templates", { orderedIds });
    },
    createSnapshotTemplate(request) {
      return invoke<void>("create_snapshot_template", { request });
    },
    useSnapshotTemplate(templateId, sessionId) {
      return invoke<UseSnapshotResult>("use_snapshot_template", {
        request: { templateId, sessionId },
      });
    },
  };
}

/** 非 Tauri（浏览器预览）兜底：无本地模板库，列表空、写操作抛错。 */
export function createBrowserTemplateService(): TemplateService {
  return {
    async listTemplates() {
      return [];
    },
    async deleteTemplate() {
      throw new Error("请在桌面应用中管理工程模板。");
    },
    async reorderTemplates() {
      throw new Error("请在桌面应用中管理工程模板。");
    },
    async createSnapshotTemplate() {
      throw new Error("请在桌面应用中把工程设为模板。");
    },
    async useSnapshotTemplate() {
      throw new Error("请在桌面应用中使用工程模板。");
    },
  };
}
