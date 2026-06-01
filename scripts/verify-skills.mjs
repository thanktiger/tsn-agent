import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const skillRoot = ".claude/skills";

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
      const resourceSource = `../${filePath}`;
      const resourceTarget = `${filePath}`;
      if (resources[resourceSource] !== resourceTarget) {
        errors.push(`src-tauri/tauri.conf.json must map "${resourceSource}" to "${resourceTarget}".`);
      }

      if (await isGitIgnored(filePath)) {
        errors.push(`${filePath} is ignored by git; update .gitignore so the project skill is tracked.`);
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`verify:skills: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`verify:skills: ${skillNames.join(", ")} ok`);
}

async function listSkillFiles(skillDir) {
  const entries = await readdir(skillDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.name.endsWith(".swp")) {
      continue;
    }

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
