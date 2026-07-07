#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  writeFileSync(join(rootDir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid semver version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function bumpVersion(version, bump) {
  if (bump === "major") {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }
  if (bump === "minor") {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }
  if (bump === "patch") {
    return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }
  return version;
}

function latestReleaseTag() {
  // tag 触发的 CI 打包里，正在发布的 tag（如 v1.0.0）已指向 HEAD——必须排除它，否则
  // 取到的「最新 tag」是自己，`<tag>..HEAD` 区间为空，release 正文的升级类型/提交数量/
  // 基准版本三行元信息全失真（none / 0 / 自己）。在 release 分支预演时 HEAD 无 tag，
  // 排除集为空、行为不变（仍取最新的上一个版本 tag）。
  const headTags = new Set(
    tryGit(["tag", "--points-at", "HEAD", "--list", "v[0-9]*.[0-9]*.[0-9]*"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return tryGit(["tag", "--merged", "HEAD", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((tag) => !headTags.has(tag));
}

function readJsonFromHead(relativePath) {
  const raw = tryGit(["show", `HEAD:${relativePath}`]);
  return raw ? JSON.parse(raw) : null;
}

function collectCommits(fromTag) {
  const range = fromTag ? `${fromTag}..HEAD` : "HEAD";
  const raw = tryGit(["log", range, "--format=%H%x1f%s%x1f%b%x1e"]);
  if (!raw) {
    return [];
  }

  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body = ""] = record.split("\x1f");
      const conventional =
        /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<summary>.+)$/i.exec(subject);
      return {
        hash,
        shortHash: hash.slice(0, 7),
        subject,
        body,
        type: conventional?.groups?.type?.toLowerCase() ?? "other",
        summary: conventional?.groups?.summary ?? subject,
        breaking:
          conventional?.groups?.breaking === "!" ||
          /(^|\n)BREAKING CHANGE:/i.test(body) ||
          /(^|\n)BREAKING-CHANGE:/i.test(body),
      };
    });
}

function decideBump(commits) {
  if (commits.some((commit) => commit.breaking)) {
    return "major";
  }
  if (commits.some((commit) => commit.type === "feat")) {
    return "minor";
  }
  if (commits.length > 0) {
    return "patch";
  }
  return "none";
}

const exactTranslations = new Map([
  ["integrate planner service workflow", "接入规划服务工作流"],
  ["handle crlf skill frontmatter", "处理 skill frontmatter 的 CRLF 兼容"],
  ["add production desktop build", "新增生产桌面端构建"],
  ["stabilize tsn skill production flow", "稳定 TSN skill 生产流程"],
  ["clean skill traces and topology edits", "清理 skill 运行痕迹和拓扑编辑"],
  ["use neutral topology empty state", "使用中性的拓扑空状态"],
  ["wire real tsn stage skills", "接入真实 TSN 阶段 skill"],
  ["initialize agent project context", "初始化 Agent 项目上下文"],
  ["add staged tsn planning workflow", "新增分阶段 TSN 规划工作流"],
  ["complete tsn agent desktop mvp", "完成 TSN Agent 桌面端 MVP"],
  ["scaffold tsn agent mvp", "初始化 TSN Agent MVP"],
]);

const wordReplacements = [
  [/\bintegrate\b/gi, "接入"],
  [/\badd\b/gi, "新增"],
  [/\bhandle\b/gi, "处理"],
  [/\bstabilize\b/gi, "稳定"],
  [/\bclean\b/gi, "清理"],
  [/\buse\b/gi, "使用"],
  [/\bwire\b/gi, "接入"],
  [/\binitialize\b/gi, "初始化"],
  [/\bcomplete\b/gi, "完成"],
  [/\bscaffold\b/gi, "初始化"],
  [/\bplanner service workflow\b/gi, "规划服务工作流"],
  [/\bproduction desktop build\b/gi, "生产桌面端构建"],
  [/\bstaged TSN planning workflow\b/gi, "分阶段 TSN 规划工作流"],
  [/\bdesktop MVP\b/gi, "桌面端 MVP"],
];

function chineseSummary(summary) {
  if (/[\u4e00-\u9fff]/.test(summary)) {
    return summary;
  }

  const exact = exactTranslations.get(summary.toLowerCase());
  if (exact) {
    return exact;
  }

  let translated = summary;
  for (const [pattern, replacement] of wordReplacements) {
    translated = translated.replace(pattern, replacement);
  }

  return /[\u4e00-\u9fff]/.test(translated) ? translated : `更新 ${summary}`;
}

function categoryFor(commit) {
  if (commit.breaking) {
    return "breaking";
  }
  if (commit.type === "feat") {
    return "features";
  }
  if (commit.type === "fix") {
    return "fixes";
  }
  if (commit.type === "perf") {
    return "performance";
  }
  if (commit.type === "docs") {
    return "docs";
  }
  if (commit.type === "test") {
    return "tests";
  }
  if (["build", "ci", "chore", "refactor"].includes(commit.type)) {
    return "engineering";
  }
  return "other";
}

const internalCategoryTitles = [
  ["engineering", "工程与构建"],
  ["docs", "文档"],
  ["tests", "测试"],
];

function buildInternalReleaseDetails(commits) {
  const lines = [];

  if (commits.length === 0) {
    return lines.join("\n");
  }

  const byCategory = new Map(internalCategoryTitles.map(([key]) => [key, []]));
  for (const commit of commits) {
    const category = categoryFor(commit);
    if (byCategory.has(category)) {
      byCategory.get(category).push(commit);
    }
  }

  for (const [key, title] of internalCategoryTitles) {
    const entries = byCategory.get(key);
    if (!entries.length) {
      continue;
    }
    lines.push(`### ${title}`, "");
    for (const commit of entries) {
      lines.push(`- ${chineseSummary(commit.summary)}（${commit.shortHash}）`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// 发布说明来自人工/大模型精修的 CHANGELOG.md：读取与本次版本号匹配的顶层条目作为
// release 正文。缺失即报错中止——发布前必须先写好 `## vX.Y.Z` 段并提交（不再机械生成，
// 也不再覆盖 CHANGELOG）。
function readCuratedChangelogEntry(version) {
  const changelogPath = join(rootDir, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    throw new Error(`CHANGELOG.md 不存在，无法取得 v${version} 的发布说明。`);
  }
  const content = readFileSync(changelogPath, "utf8");
  const escaped = version.replace(/[.]/gu, "\\.");
  const section = content
    .split(/(?=^## )/mu)
    .map((part) => part.trim())
    .find((part) => new RegExp(`^## v${escaped}(\\s|$)`, "u").test(part));
  if (!section) {
    throw new Error(
      `CHANGELOG.md 缺少 v${version} 的条目。发布前请先写好「## v${version} - 日期」段并提交，再触发发布。`,
    );
  }
  return section;
}

function writeReleaseNotes(version, entry, metadata, internalDetails) {
  const lines = [
    `# HIBridge Agent v${version}`,
    "",
    `升级类型：${metadata.bump}`,
    `提交数量：${metadata.commitCount}`,
    "",
    entry.trim(),
    "",
  ];

  if (metadata.previousTag) {
    lines.push(`基准版本：\`${metadata.previousTag}\``, "");
  }

  if (internalDetails) {
    lines.push("## 内部变更", "", internalDetails, "");
  }

  writeFileSync(join(rootDir, "release-notes.md"), lines.join("\n"));
}

function updateCargoTomlVersion(version) {
  const cargoTomlPath = join(rootDir, "src-tauri", "Cargo.toml");
  const lines = readFileSync(cargoTomlPath, "utf8").split("\n");
  let inPackage = false;
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\[package\]\s*$/.test(line)) {
      inPackage = true;
      return line;
    }
    if (/^\[.+\]\s*$/.test(line) && !/^\[package\]\s*$/.test(line)) {
      inPackage = false;
    }
    if (inPackage && !replaced && /^version\s*=/.test(line)) {
      replaced = true;
      return `version = "${version}"`;
    }
    return line;
  });
  writeFileSync(cargoTomlPath, next.join("\n"));
}

function updateCargoLockVersion(version) {
  const cargoLockPath = join(rootDir, "src-tauri", "Cargo.lock");
  if (!existsSync(cargoLockPath)) {
    return;
  }

  const lines = readFileSync(cargoLockPath, "utf8").split("\n");
  let inPackage = false;
  let isTsnAgent = false;
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\[\[package\]\]\s*$/.test(line)) {
      inPackage = true;
      isTsnAgent = false;
      return line;
    }
    if (inPackage && /^name\s*=\s*"tsn-agent"\s*$/.test(line)) {
      isTsnAgent = true;
      return line;
    }
    if (inPackage && isTsnAgent && !replaced && /^version\s*=/.test(line)) {
      replaced = true;
      return `version = "${version}"`;
    }
    return line;
  });
  writeFileSync(cargoLockPath, next.join("\n"));
}

function writeGitHubOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

const packageJson = readJson("package.json");
const tag = latestReleaseTag();
const headPackageJson = readJsonFromHead("package.json");
const baseVersion = parseVersion(tag ?? headPackageJson?.version ?? packageJson.version);
const commits = collectCommits(tag);
const bump = decideBump(commits);
const nextVersion = formatVersion(bumpVersion(baseVersion, bump));
const internalDetails = buildInternalReleaseDetails(commits);
const metadata = {
  version: nextVersion,
  previousVersion: formatVersion(baseVersion),
  previousTag: tag ?? null,
  bump,
  commitCount: commits.length,
  generatedAt: new Date().toISOString(),
};

if (!dryRun) {
  packageJson.version = nextVersion;
  writeJson("package.json", packageJson);

  const packageLock = readJson("package-lock.json");
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
  writeJson("package-lock.json", packageLock);

  const tauriConfig = readJson("src-tauri/tauri.conf.json");
  tauriConfig.version = nextVersion;
  writeJson("src-tauri/tauri.conf.json", tauriConfig);

  updateCargoTomlVersion(nextVersion);
  updateCargoLockVersion(nextVersion);
  // 发布说明取自已提交的精修 CHANGELOG.md（缺失即中止），不再机械生成、不再覆盖 CHANGELOG。
  const changelogEntry = readCuratedChangelogEntry(nextVersion);
  writeJson("release-metadata.json", metadata);
  writeReleaseNotes(nextVersion, changelogEntry, metadata, internalDetails);
  writeGitHubOutput(metadata);
}

console.log(`Release version: v${nextVersion}`);
console.log(`Bump: ${bump}`);
console.log(`Commits: ${commits.length}`);
if (tag) {
  console.log(`Previous tag: ${tag}`);
}
if (dryRun) {
  console.log("Dry run only; no files were changed.");
}
