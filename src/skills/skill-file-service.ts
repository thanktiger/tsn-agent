import { invoke } from "@tauri-apps/api/core";
import type { StageSkillName } from "../agent/stage-skill-contract";

export type SkillFileRootStatus = "available" | "readonly" | "unavailable";

export interface SkillFileEntry {
  path: string;
  kind: "file";
  sizeBytes: number;
  canPreview: boolean;
  canEdit: boolean;
  reason?: string;
}

export interface SkillFileListResult {
  skillId: StageSkillName;
  status: SkillFileRootStatus;
  files: SkillFileEntry[];
  message?: string;
}

export interface SkillFileContent {
  skillId: StageSkillName;
  path: string;
  content: string;
  editable: boolean;
  readonlyReason?: string;
}

export interface TopologyParam {
  name: string;
  type: string;
  minimum?: number;
  maximum?: number;
  values?: number[];
  description?: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface TopologyTemplateDescriptor {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  params: TopologyParam[];
  example?: Record<string, unknown>;
}

export interface TopologyTemplateCatalog {
  templateCount: number;
  templateIds: string[];
  templates: TopologyTemplateDescriptor[];
}

export interface RestoreFactorySkillsResult {
  dryRun: boolean;
  /** 将被（或已被）恢复为出厂内容的文件。 */
  restored: string[];
  /** 将被（或已被）删除的出厂移除清单文件。 */
  removed: string[];
  /** 用户自建文件，恢复不触碰。 */
  preserved: string[];
  /** 文件已全部恢复但记录清单失败时的提示（下次启动自动校正）。 */
  warning?: string;
}

export interface SkillFileService {
  listFiles(skillId: StageSkillName): Promise<SkillFileListResult>;
  readFile(skillId: StageSkillName, path: string): Promise<SkillFileContent>;
  writeFile(skillId: StageSkillName, path: string, content: string): Promise<SkillFileContent>;
  /** dryRun=true 仅枚举差异清单；false 执行恢复（覆写出厂文件 + 删除移除清单文件）。 */
  restoreFactorySkills(dryRun: boolean): Promise<RestoreFactorySkillsResult>;
  describeTopologyTemplates(): Promise<TopologyTemplateCatalog>;
}

export function createSkillFileService(): SkillFileService {
  if (!isTauriRuntime()) {
    return createBrowserSkillFileService();
  }

  return {
    listFiles(skillId) {
      return invoke<SkillFileListResult>("list_skill_files", {
        request: { skillId },
      });
    },
    readFile(skillId, path) {
      return invoke<SkillFileContent>("read_skill_file", {
        request: { skillId, path },
      });
    },
    writeFile(skillId, path, content) {
      return invoke<SkillFileContent>("write_skill_file", {
        request: { skillId, path, content },
      });
    },
    restoreFactorySkills(dryRun) {
      return invoke<RestoreFactorySkillsResult>("restore_factory_skills", {
        request: { dryRun },
      });
    },
    describeTopologyTemplates() {
      return invoke<TopologyTemplateCatalog>("describe_topology_templates");
    },
  };
}

export function createBrowserSkillFileService(): SkillFileService {
  return {
    async listFiles(skillId) {
      return {
        skillId,
        status: "unavailable",
        files: [],
        message: "请在桌面应用中预览和编辑本地 skill 文件。",
      };
    },
    async readFile() {
      throw new Error("请在桌面应用中预览本地 skill 文件。");
    },
    async writeFile() {
      throw new Error("请在桌面应用中编辑本地 skill 文件。");
    },
    async restoreFactorySkills() {
      throw new Error("请在桌面应用中恢复内置 skill 版本。");
    },
    async describeTopologyTemplates() {
      throw new Error("请在桌面应用中查看拓扑参数合法域。");
    },
  };
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
