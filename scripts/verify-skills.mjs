// skill 构建闸（build:worker 前置）。职责（plan 2026-06-12-001 U7/R9/R13）：
// ① skills 整目录资源映射存在（per-file 映射税已移除——新增 reference 零打包配置改动）；
// ② skill 目录纯文本白名单（只允许 SKILL.md 与 references/*.md，防脚本/二进制/残留回流）；
// ③ frontmatter / worker 声明 / git 跟踪既有校验保留；
// ④ R9 三方对账：reference 文件名 == 已注册 ScenarioConfigId；preset 表 `templateId`
//    必须存在于 Rust catalog；声明了场景的模板必须在该场景 reference 的 preset 表有行。
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const skillRoot = ".claude/skills";
const DIRECTORY_RESOURCE_SOURCE = "../.claude/skills/";
const DIRECTORY_RESOURCE_TARGET = ".claude/skills/";

async function main() {
  const skillNames = await listProjectSkills();
  const workerSource = await readFile("src-node/claude-agent-worker.mjs", "utf8");
  const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const resources = tauriConfig.bundle?.resources ?? {};
  const errors = [];

  if (skillNames.length === 0) {
    errors.push(`${skillRoot} must contain at least one project skill.`);
  }

  if (!workerAllowsSkill(workerSource)) {
    errors.push("src-node/claude-agent-worker.mjs must allow the Skill tool when project skills are configured.");
  }

  // ① 整目录映射（R13）：单条目覆盖全部 skill 文件，悬空 per-file 映射不允许残留。
  if (resources[DIRECTORY_RESOURCE_SOURCE] !== DIRECTORY_RESOURCE_TARGET) {
    errors.push(`src-tauri/tauri.conf.json must map "${DIRECTORY_RESOURCE_SOURCE}" to "${DIRECTORY_RESOURCE_TARGET}".`);
  }
  for (const source of Object.keys(resources)) {
    if (source !== DIRECTORY_RESOURCE_SOURCE && source.startsWith("../.claude/skills/")) {
      errors.push(`src-tauri/tauri.conf.json has a stale per-file skill mapping "${source}"; the directory mapping covers it.`);
    }
  }

  // 整目录映射把 .claude/skills 全树打进包：根层散文件（含 .DS_Store）与
  // 无 SKILL.md 的目录无法在打包时排除，必须在构建前阻断。
  const rootEntries = await readdir(skillRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile()) {
      errors.push(`${skillRoot}/${entry.name} is a stray root-level file; the directory bundle would ship it — remove it.`);
    } else if (entry.isDirectory() && !skillNames.includes(entry.name)) {
      errors.push(`${skillRoot}/${entry.name}/ has no SKILL.md; the directory bundle would ship it — remove it or add SKILL.md.`);
    }
  }

  for (const skillName of skillNames) {
    const skillPath = `${skillRoot}/${skillName}/SKILL.md`;
    const skillSource = await readFile(skillPath, "utf8");
    const frontmatterName = readFrontmatterName(skillSource);

    if (skillName === "tsn-topology" && /topology\.render_mac_table_html|mac-forwarding-table\.html/.test(skillSource)) {
      errors.push(`${skillPath} must not require topology.render_mac_table_html or mac-forwarding-table.html.`);
    }

    if (frontmatterName !== skillName) {
      errors.push(`${skillPath} frontmatter name must be "${skillName}", got "${frontmatterName ?? "missing"}".`);
    }

    if (!workerSource.includes(`"${skillName}"`) && !workerSource.includes(`'${skillName}'`)) {
      errors.push(`src-node/claude-agent-worker.mjs must declare skill "${skillName}".`);
    }

    const skillFiles = await listSkillFiles(`${skillRoot}/${skillName}`);
    for (const filePath of skillFiles) {
      // ② 纯文本白名单：skill 目录只允许 SKILL.md 与 references/*.md。
      const relative = filePath.slice(`${skillRoot}/${skillName}/`.length);
      const allowed = relative === "SKILL.md" || /^references\/[^/]+\.md$/.test(relative);
      if (!allowed) {
        errors.push(`${filePath} is not allowed; skill directories may only contain SKILL.md and references/*.md.`);
      }

      if (await isGitIgnored(filePath)) {
        errors.push(`${filePath} is ignored by git; update .gitignore so the project skill is tracked.`);
      }
    }
  }

  // ④ R9 三方对账（tsn-topology 场景体系）。
  errors.push(...await verifyScenarioAccounting());

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`verify:skills: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`verify:skills: ${skillNames.join(", ")} ok`);
}

// R9 对账：catalog（Rust 源，KTD7 防过匹配锚点）↔ scenario-config.ts ↔ references。
async function verifyScenarioAccounting() {
  const errors = [];
  const rustSource = await readFile("src-tauri/src/topology_compute.rs", "utf8");
  const scenarioSource = await readFile("src/domain/scenario-config.ts", "utf8");

  // 模板目录成员锚点：describe_templates_catalog_filtered 的 `let all = [...]`
  // descriptor 函数清单（templateIds 是运行时计算值，源码无字面量数组可锚）。
  const allMatch = rustSource.match(/let all = \[([\s\S]*?)\];/);
  const descriptorFns = allMatch
    ? [...allMatch[1].matchAll(/(\w+_descriptor)\(\)/g)].map((m) => m[1])
    : [];
  if (descriptorFns.length === 0) {
    errors.push("topology_compute.rs `let all = [...]` descriptor anchor extracted no entries; update verify-skills anchors.");
    return errors;
  }

  // 每个 descriptor 函数块取首个 "id"（descriptor 自身 id 是 json! 首字段，
  // 先于 example 内嵌的伪 id）与首个 "scenarios"。不全文裸匹配 "id"——
  // dual-plane example 内嵌十余个伪 id，裸锚点会静默放绿。
  const templateScenarios = new Map();
  for (const fnName of descriptorFns) {
    const fnStart = rustSource.indexOf(`fn ${fnName}() -> Value {`);
    if (fnStart === -1) {
      errors.push(`descriptor function "${fnName}" referenced by catalog but not found; update verify-skills anchors.`);
      continue;
    }
    const nextFn = rustSource.indexOf("\nfn ", fnStart + 1);
    const block = rustSource.slice(fnStart, nextFn === -1 ? rustSource.length : nextFn);
    const idMatch = block.match(/"id":\s*"([^"]+)"/);
    const scenariosMatch = block.match(/"scenarios":\s*\[([^\]]*)\]/);
    if (!idMatch) {
      errors.push(`descriptor "${fnName}" has no "id" field; update verify-skills anchors.`);
      continue;
    }
    const scenarios = scenariosMatch
      ? [...scenariosMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : [];
    templateScenarios.set(idMatch[1], scenarios);
  }
  const templateIds = [...templateScenarios.keys()];
  if (templateIds.length !== descriptorFns.length) {
    errors.push(`scenario accounting extracted ${templateIds.length} descriptors (expected ${descriptorFns.length}); update verify-skills anchors.`);
    return errors;
  }
  for (const [templateId, scenarios] of templateScenarios) {
    if (scenarios.length === 0) {
      errors.push(`template "${templateId}" must declare a non-empty scenarios list in topology_compute.rs.`);
    }
  }

  // 已注册场景 id：ScenarioConfigId union 单行锚点。
  const unionMatch = scenarioSource.match(/export type ScenarioConfigId\s*=\s*([^;]+);/);
  const scenarioIds = unionMatch
    ? [...unionMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : [];
  if (scenarioIds.length === 0) {
    errors.push("scenario-config.ts ScenarioConfigId anchor extracted no ids; update verify-skills anchors.");
    return errors;
  }

  // reference 文件名 == 已注册 ScenarioConfigId；每个被声明的场景必须有 reference。
  const referenceDir = `${skillRoot}/tsn-topology/references`;
  let referenceFiles = [];
  try {
    referenceFiles = (await readdir(referenceDir)).filter((name) => name.endsWith(".md"));
  } catch {
    errors.push(`${referenceDir} must exist with per-scenario reference files.`);
    return errors;
  }
  for (const file of referenceFiles) {
    const scenarioId = file.replace(/\.md$/, "");
    if (!scenarioIds.includes(scenarioId)) {
      errors.push(`${referenceDir}/${file} does not match any registered ScenarioConfigId (${scenarioIds.join(", ")}).`);
    }
  }

  // preset 表 `templateId` 锚点：定位表头含 templateId 的列，只取该列数据行的
  // 反引号 token——该列只装模板 id，全部无条件对账（不靠前缀启发式，typo 或
  // 新模板族写错都响亮报红）。
  const presetTemplateIdsByScenario = new Map();
  for (const file of referenceFiles) {
    const content = await readFile(`${referenceDir}/${file}`, "utf8");
    const ids = collectPresetTemplateIds(content);
    presetTemplateIdsByScenario.set(file.replace(/\.md$/, ""), ids);

    for (const id of ids) {
      if (!templateIds.includes(id)) {
        errors.push(`${referenceDir}/${file} preset table references unknown templateId \`${id}\` (catalog: ${templateIds.join(", ")}).`);
      }
    }
  }

  // 声明了场景的模板必须被该场景 reference 的 preset 表承载。
  for (const [templateId, scenarios] of templateScenarios) {
    for (const scenario of scenarios) {
      const presetIds = presetTemplateIdsByScenario.get(scenario);
      if (!presetIds) {
        errors.push(`template "${templateId}" declares scenario "${scenario}" but ${referenceDir}/${scenario}.md is missing.`);
        continue;
      }
      if (!presetIds.has(templateId)) {
        errors.push(`template "${templateId}" declares scenario "${scenario}" but ${referenceDir}/${scenario}.md has no preset row for it.`);
      }
    }
  }

  return errors;
}

// 取 markdown 表中 `templateId` 列的全部反引号 token（跨表累计）。
function collectPresetTemplateIds(content) {
  const ids = new Set();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trimStart().startsWith("|") || !line.includes("templateId")) {
      continue;
    }
    const column = splitTableRow(line).findIndex((cell) => cell.includes("templateId"));
    if (column === -1) {
      continue;
    }
    // i+1 是分隔行，数据行从 i+2 起到表结束。
    for (let j = i + 2; j < lines.length; j++) {
      if (!lines[j].trimStart().startsWith("|")) {
        break;
      }
      const match = splitTableRow(lines[j])[column]?.match(/`([^`]+)`/);
      if (match) {
        ids.add(match[1]);
      }
    }
  }
  return ids;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

async function listSkillFiles(skillDir) {
  const entries = await readdir(skillDir, { withFileTypes: true });
  const files = [];

  // 不豁免 .DS_Store/*.swp：整目录打包会把它们带进 Resource，落入白名单
  // 检查报错让开发者在构建前删除。
  for (const entry of entries) {
    const path = `${skillDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listSkillFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files.sort();
}

async function listProjectSkills() {
  await access(skillRoot, constants.R_OK);
  const entries = await readdir(skillRoot, { withFileTypes: true });
  const skillNames = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillPath = `${skillRoot}/${entry.name}/SKILL.md`;
    try {
      await access(skillPath, constants.R_OK);
      skillNames.push(entry.name);
    } catch {
      // Ignore directories that are not project skills.
    }
  }

  return skillNames.sort();
}

function readFrontmatterName(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return undefined;
  }

  return match[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^name:\s*(.+?)\s*$/)?.[1])
    .find(Boolean);
}

function workerAllowsSkill(source) {
  return /allowedTools:\s*\[[^\]]*["']Skill["']/s.test(source)
    || /allowedTools:\s*buildAllowedToolsForStage\(/.test(source)
      && /return\s*\[[^\]]*["']Skill["']/s.test(source);
}

async function isGitIgnored(path) {
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", path]);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) {
      return false;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`verify:skills: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
