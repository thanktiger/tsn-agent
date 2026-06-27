# 发版指南

正式版从 **main** 出：版本号先经 PR 合入 main，再在 main 上打 tag 触发打包。

## 前提：main 分支保护

- ❌ **不能直接 `git push origin main`** —— 所有改动必须走 PR。
- ✅ PR 必须三项 CI 全绿才能合：`Lint + Rust tests (Biome + Rust)`、`Legacy types grep gate`、`Tests (vitest + Playwright e2e)`。
- 审批数为 0：要 PR，但不强制别人批准，自己的 PR 绿了自己就能合（谁提 PR 谁负责修绿）。
- 对 owner 也生效。应急需直推时，去 GitHub → Settings → Branches 临时关掉 enforce_admins。

## 发版流程（5 步）

### 1. 确定版本号

```bash
npm run release:prepare -- --dry-run
# 打印 "Release version: vX.Y.Z"
```

版本号**由 commit 自动决定**（相对最新 tag）：

| commit 类型 | bump | 例 |
| --- | --- | --- |
| `feat:` | minor | 0.8.0 → 0.9.0 |
| `fix:` / 其它 | patch | 0.8.0 → 0.8.1 |
| `BREAKING CHANGE` / `feat!:` | major | 0.8.0 → 1.0.0 |

不能随便指定版本号；想发某个版本，得让 commit 配得上。

### 2. 开分支：写 CHANGELOG + 同步版本号

```bash
git checkout -b release/vX.Y.Z
```

在 `CHANGELOG.md` 顶部加一段（版本号要和第 1 步 dry-run 算出的一致）：

```markdown
## vX.Y.Z - YYYY-MM-DD

### 新功能

- 客户能看懂的人话（不是 commit 标题）

### 修复

- ……
```

类别只能用：`新功能` / `修复` / `性能优化` / `破坏性变更` / `其它`（其它类别不会显示在 app 内更新日志）。
缺对应版本条目的话，打包时 `release:prepare` 会**直接中止**。

然后同步版本号到所有文件并提交：

```bash
npm run release:prepare          # 同步 package.json / package-lock / Cargo.toml / Cargo.lock / tauri.conf.json
git commit -am "chore(release): bump version to X.Y.Z + changelog"
git push -u origin release/vX.Y.Z
gh pr create --base main --title "chore(release): vX.Y.Z"
```

### 3. 合并 PR 到 main

CI 三项绿后：

```bash
gh pr merge <PR号> --merge --delete-branch
```

版本号此时落到 main，app 内版本号（顶部 `VER` + 设置里「当前版本」，取自 CHANGELOG 顶部条目）随之更新。

### 4. 在 main 上打 tag 触发打包

```bash
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

push tag 后 `Production Desktop Build` 自动跑：4 平台打包（mac arm64/x64、Windows、Linux）+ 建好 GitHub Release（名「HIBridge Agent vX.Y.Z」）+ 上传安装包。约 15–20 分钟。

### 5. 取产物

GitHub → **Releases** 页：`.dmg`（mac）/ `.exe` `.msi`（Windows）/ `.deb` `.rpm`（Linux）/ `.app.tar.gz`。
也可在 Actions 里那次 run 的 artifacts 下载。

## 备注

- 手动触发：Actions → Production Desktop Build → "Run workflow"（workflow_dispatch），用于不打 tag 的临时构建。
- 版本号事实源是 `CHANGELOG.md` 顶部条目；`prepare-release.mjs` 读它当 release 正文，`src/release/release-info.ts` 读它当 app 内版本。
- `prepare-release -- --dry-run` **不**校验 CHANGELOG（dry-run 在写条目之前），只有真打包才校验中止。
