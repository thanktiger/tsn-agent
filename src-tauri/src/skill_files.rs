use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{path::BaseDirectory, Manager};

const MAX_TEXT_FILE_BYTES: u64 = 256 * 1024;
const PROJECT_SKILL_ROOT: &str = ".claude/skills";
const SKILL_IDS: &[&str] = &[
    "tsn-topology",
    "tsn-time-sync",
    "tsn-flow-planning",
    "tsn-inet-export",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSkillFilesRequest {
    skill_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSkillFileRequest {
    skill_id: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSkillFileRequest {
    skill_id: String,
    path: String,
    content: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillFileRootStatus {
    Available,
    Readonly,
    Unavailable,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillFileKind {
    File,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    path: String,
    kind: SkillFileKind,
    size_bytes: u64,
    can_preview: bool,
    can_edit: bool,
    reason: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListSkillFilesResponse {
    skill_id: String,
    status: SkillFileRootStatus,
    files: Vec<SkillFileEntry>,
    message: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileContentResponse {
    skill_id: String,
    path: String,
    content: String,
    editable: bool,
    readonly_reason: Option<String>,
}

struct SkillRoot {
    path: PathBuf,
    writable: bool,
    status: SkillFileRootStatus,
    /// 只读时的根级原因（如播种失败回退内置副本），穿透到 readonly_reason。
    reason: Option<String>,
}

/// skills 父根级决策结果（KTD1）：编辑器三命令与 worker spawn 共同消费。
pub struct EffectiveSkillRoot {
    pub path: PathBuf,
    pub writable: bool,
    status: SkillFileRootStatus,
    reason: Option<String>,
}

impl EffectiveSkillRoot {
    /// worker spawn 消费：可用（含只读兜底）时给出根路径，Unavailable 给 None。
    pub fn into_usable_path(self) -> Option<PathBuf> {
        if self.status == SkillFileRootStatus::Unavailable {
            None
        } else {
            Some(self.path)
        }
    }

    /// 诊断用根级原因（如播种失败回退/不可用原因），供 spawn 告警携带。
    pub fn diagnostics_reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }
}

#[tauri::command]
pub fn list_skill_files(
    app: tauri::AppHandle,
    request: ListSkillFilesRequest,
) -> Result<ListSkillFilesResponse, String> {
    validate_skill_id(&request.skill_id)?;
    let root = resolve_skill_root(&app, &request.skill_id)?;

    if root.status == SkillFileRootStatus::Unavailable {
        return Ok(ListSkillFilesResponse {
            skill_id: request.skill_id,
            status: root.status,
            files: Vec::new(),
            message: Some(
                root.reason
                    .unwrap_or_else(|| "暂无可预览的 skill 文件目录。".to_string()),
            ),
        });
    }

    let files = list_skill_files_for_root(&root.path, root.writable)?;

    Ok(ListSkillFilesResponse {
        skill_id: request.skill_id,
        status: root.status,
        files,
        message: None,
    })
}

#[tauri::command]
pub fn read_skill_file(
    app: tauri::AppHandle,
    request: ReadSkillFileRequest,
) -> Result<SkillFileContentResponse, String> {
    validate_skill_id(&request.skill_id)?;
    let root = resolve_existing_skill_root(&app, &request.skill_id)?;
    let path = resolve_existing_file(&root.path, &request.path)?;
    read_text_file(&request.skill_id, &root.path, &path, root.writable, root.reason.as_deref())
}

#[tauri::command]
pub fn write_skill_file(
    app: tauri::AppHandle,
    request: WriteSkillFileRequest,
) -> Result<SkillFileContentResponse, String> {
    validate_skill_id(&request.skill_id)?;
    let root = resolve_existing_skill_root(&app, &request.skill_id)?;

    if !root.writable {
        return Err(root
            .reason
            .clone()
            .unwrap_or_else(|| "该 skill 文件目录当前是只读资源，不能保存修改。".to_string()));
    }

    if request.content.as_bytes().len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("文件内容超过轻量编辑大小限制。".to_string());
    }

    let path = resolve_existing_file(&root.path, &request.path)?;
    let entry = inspect_file(&root.path, &path, true)?;

    if !entry.can_edit {
        return Err(entry
            .reason
            .unwrap_or_else(|| "该文件当前不可编辑。".to_string()));
    }

    let temp_path = path.with_extension(format!("tmp-{}", timestamp_nanos()));
    std::fs::write(&temp_path, request.content)
        .map_err(|error| format!("无法写入临时 skill 文件：{error}"))?;
    std::fs::rename(&temp_path, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("无法保存 skill 文件：{error}")
    })?;

    read_text_file(&request.skill_id, &root.path, &path, root.writable, root.reason.as_deref())
}

fn resolve_existing_skill_root(
    app: &tauri::AppHandle,
    skill_id: &str,
) -> Result<SkillRoot, String> {
    let root = resolve_skill_root(app, skill_id)?;

    if root.status == SkillFileRootStatus::Unavailable {
        return Err("暂无可访问的 skill 文件目录。".to_string());
    }

    Ok(root)
}

/// 三个 skills 父根候选。dev 仅在 debug 构建给出（对齐 find_worker_path 的守卫，
/// 修复编辑器与 worker 解析不对称：release 构建在开发机上不得再选仓库路径）。
fn skill_root_candidates(
    app: &tauri::AppHandle,
) -> (Option<PathBuf>, Option<PathBuf>, Option<PathBuf>) {
    let dev = if cfg!(debug_assertions) {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        Some(repo_root.join(PROJECT_SKILL_ROOT))
    } else {
        None
    };
    let app_data = app.path().app_data_dir().ok().map(|dir| dir.join("skills"));
    let resource = app
        .path()
        .resolve(PROJECT_SKILL_ROOT, BaseDirectory::Resource)
        .ok();
    (dev, app_data, resource)
}

/// 有效 skills 父根（KTD1）：dev（仅 debug）→ app-data 懒播种可写副本 → Resource 只读兜底。
/// worker spawn（commands.rs）与编辑器三命令共同消费此决策。
pub fn effective_skill_root(app: &tauri::AppHandle) -> EffectiveSkillRoot {
    let (dev, app_data, resource) = skill_root_candidates(app);
    resolve_effective_root(dev.as_deref(), app_data.as_deref(), resource.as_deref())
}

/// 父根级决策纯函数：候选路径由调用方注入，可单测。
/// dev 命中时完全跳过播种（开发机不悄悄长出 app-data 副本）。
fn resolve_effective_root(
    dev: Option<&Path>,
    app_data: Option<&Path>,
    resource: Option<&Path>,
) -> EffectiveSkillRoot {
    if let Some(dev) = dev {
        if dev.exists() {
            return EffectiveSkillRoot {
                path: dev.to_path_buf(),
                writable: true,
                status: SkillFileRootStatus::Available,
                reason: None,
            };
        }
    }

    if let Some(app_data) = app_data {
        match ensure_seeded(app_data, resource) {
            Ok(()) => {
                return EffectiveSkillRoot {
                    path: app_data.to_path_buf(),
                    writable: true,
                    status: SkillFileRootStatus::Available,
                    reason: None,
                };
            }
            Err(reason) => {
                if let Some(resource) = resource {
                    if resource.exists() {
                        return EffectiveSkillRoot {
                            path: resource.to_path_buf(),
                            writable: false,
                            status: SkillFileRootStatus::Readonly,
                            reason: Some(format!("可写 skill 副本不可用（{reason}），当前为内置只读副本。")),
                        };
                    }
                }
                return EffectiveSkillRoot {
                    path: app_data.to_path_buf(),
                    writable: false,
                    status: SkillFileRootStatus::Unavailable,
                    reason: Some(reason),
                };
            }
        }
    }

    if let Some(resource) = resource {
        if resource.exists() {
            return EffectiveSkillRoot {
                path: resource.to_path_buf(),
                writable: false,
                status: SkillFileRootStatus::Readonly,
                reason: None,
            };
        }
    }

    EffectiveSkillRoot {
        path: app_data
            .or(dev)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(PROJECT_SKILL_ROOT)),
        writable: false,
        status: SkillFileRootStatus::Unavailable,
        reason: None,
    }
}

/// 出厂 manifest（R1）：记录每个出厂文件的真实出厂哈希与用户修改态。
/// 落点 skills 根下 `.factory-manifest.json`（不在 per-skill 目录内，不进面板）。
#[derive(Debug, Default, Serialize, Deserialize)]
struct FactoryManifest {
    version: u32,
    /// skills 根相对路径 → 真实出厂内容 sha256（不变量：只存真实出厂哈希）。
    #[serde(default)]
    files: std::collections::BTreeMap<String, String>,
    /// 用户改过的出厂文件（显式标记，不存伪哈希）。
    #[serde(default)]
    modified: Vec<String>,
}

const FACTORY_MANIFEST_NAME: &str = ".factory-manifest.json";

fn read_manifest(app_data_root: &Path) -> FactoryManifest {
    // 缺失/损坏一律视同缺失（存量首升路径），由历代哈希表兜底判定。
    std::fs::read_to_string(app_data_root.join(FACTORY_MANIFEST_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_manifest(app_data_root: &Path, manifest: &FactoryManifest) -> Result<(), String> {
    let path = app_data_root.join(FACTORY_MANIFEST_NAME);
    let tmp = path.with_extension(format!("tmp-{}-{}", timestamp_nanos(), std::process::id()));
    let raw = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("无法序列化 skill manifest：{error}"))?;
    std::fs::write(&tmp, raw).map_err(|error| format!("无法写入 skill manifest：{error}"))?;
    std::fs::rename(&tmp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("无法落位 skill manifest：{error}")
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// 收集内置资源下全部出厂文件（递归，跳过 symlink），返回 (绝对路径, skills 根相对路径)。
fn collect_factory_files(resource: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    fn walk(base: &Path, current: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
        let entries = std::fs::read_dir(current)
            .map_err(|error| format!("无法读取内置 skill 目录 {}：{error}", current.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("无法读取内置 skill 目录项：{error}"))?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("无法检查内置 skill 文件：{error}"))?;
            if metadata.file_type().is_symlink() {
                continue; // 防 symlink 解引用复制进用户目录（对齐编辑器侧守卫）。
            }
            if metadata.is_dir() {
                walk(base, &path, out)?;
            } else if metadata.is_file() {
                let rel = path
                    .strip_prefix(base)
                    .map_err(|_| format!("内置 skill 路径异常：{}", path.display()))?
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push((path, rel));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(resource, resource, &mut out)?;
    out.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(out)
}

/// 单文件原子写：tmp（pid+序号防微秒碰撞）+ rename（同父目录同设备）。
fn write_file_atomic(dst: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 skill 副本目录：{error}"))?;
    }
    let tmp = {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        dst.with_extension(format!(
            "tmp-{}-{}-{}",
            timestamp_nanos(),
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    };
    std::fs::write(&tmp, bytes).map_err(|error| format!("无法写入 skill 副本文件：{error}"))?;
    std::fs::rename(&tmp, dst).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("无法落位 skill 副本文件 {}：{error}", dst.display())
    })
}

/// 懒播种（R1 文件粒度三态 + R1a 移除清单）。逐出厂文件判定：
/// 缺失 → 补播并登记；哈希 == 当前出厂 → 仅登记不重写（防与用户保存竞态）；
/// 哈希 ∈ 历代出厂或 manifest 登记值 → 静默更新为新出厂；其余 → 保留并标记
/// 用户修改。manifest 缺失/损坏时由历代哈希表兜底（存量首升路径）。
/// 个别文件失败不阻断其余文件（瞬时失败下次解析自愈）。
fn ensure_seeded(app_data_root: &Path, resource: Option<&Path>) -> Result<(), String> {
    ensure_seeded_with(
        app_data_root,
        resource,
        crate::skill_factory_hashes::HISTORICAL_FACTORY_HASHES,
        crate::skill_factory_hashes::FACTORY_REMOVED_FILES,
    )
}

/// 三态判定核心（历代哈希表与移除清单参数化注入，测试用 fixture 自算哈希）。
fn ensure_seeded_with(
    app_data_root: &Path,
    resource: Option<&Path>,
    historical_hashes: &[&str],
    removed_files: &[&str],
) -> Result<(), String> {
    std::fs::create_dir_all(app_data_root)
        .map_err(|error| format!("无法创建可写 skill 目录：{error}"))?;

    let Some(resource) = resource else {
        return Ok(());
    };
    if !resource.exists() {
        return Ok(());
    }

    let mut manifest = read_manifest(app_data_root);
    let mut changed = false;

    let factory_files = collect_factory_files(resource)?;
    for (src, rel) in &factory_files {
        let Ok(factory_bytes) = std::fs::read(src) else {
            continue; // 个别文件读取失败不阻断。
        };
        let factory_hash = sha256_hex(&factory_bytes);
        let dst = app_data_root.join(rel);

        if !dst.exists() {
            // 缺失补播。
            if write_file_atomic(&dst, &factory_bytes).is_ok() {
                manifest.files.insert(rel.clone(), factory_hash);
                manifest.modified.retain(|p| p != rel);
                changed = true;
            }
            continue;
        }

        let Ok(dst_bytes) = std::fs::read(&dst) else {
            continue;
        };
        let dst_hash = sha256_hex(&dst_bytes);

        if dst_hash == factory_hash {
            // 已是当前出厂内容：仅登记，不重写（重写会与 write_skill_file 竞态）。
            if manifest.files.get(rel) != Some(&factory_hash) {
                manifest.files.insert(rel.clone(), factory_hash);
                manifest.modified.retain(|p| p != rel);
                changed = true;
            }
            continue;
        }

        let recorded_factory = manifest.files.get(rel);
        let is_unedited_old_factory = historical_hashes.contains(&dst_hash.as_str())
            || recorded_factory == Some(&dst_hash);
        if is_unedited_old_factory {
            // 未编辑的旧出厂内容：静默升级为新出厂。
            if write_file_atomic(&dst, &factory_bytes).is_ok() {
                manifest.files.insert(rel.clone(), factory_hash);
                manifest.modified.retain(|p| p != rel);
                changed = true;
            }
            continue;
        }

        // 用户改过：保留内容；files 表维持（或登记）当前出厂哈希作为「应然出厂值」
        // 供恢复使用，modified 显式标记用户态（不变量：files 只存真实出厂哈希）。
        if manifest.files.get(rel) != Some(&factory_hash)
            || !manifest.modified.iter().any(|p| p == rel)
        {
            manifest.files.insert(rel.clone(), factory_hash);
            if !manifest.modified.iter().any(|p| p == rel) {
                manifest.modified.push(rel.clone());
            }
            changed = true;
        }
    }

    // R1a：出厂移除清单——哈希命中历代出厂值的孤儿删除；用户改过的保留。
    for rel in removed_files {
        let dst = app_data_root.join(rel);
        if !dst.exists() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&dst) else {
            continue;
        };
        let hash = sha256_hex(&bytes);
        let recorded = manifest.files.get(*rel);
        if historical_hashes.contains(&hash.as_str()) || recorded == Some(&hash) {
            if std::fs::remove_file(&dst).is_ok() {
                manifest.files.remove(*rel);
                manifest.modified.retain(|p| p != rel);
                changed = true;
            }
        }
    }

    if changed {
        // manifest 写失败不致命：下次解析按历代哈希重新判定。
        let _ = write_manifest(app_data_root, &manifest);
    }
    Ok(())
}

fn resolve_skill_root(app: &tauri::AppHandle, skill_id: &str) -> Result<SkillRoot, String> {
    let effective = effective_skill_root(app);
    let resource_id_dir = app
        .path()
        .resolve(format!("{PROJECT_SKILL_ROOT}/{skill_id}"), BaseDirectory::Resource)
        .ok();
    resolve_skill_root_in(&effective, resource_id_dir.as_deref(), skill_id)
}

/// per-id 解析纯函数：有效父根 join skill_id；可写根下目录缺失（个别播种失败）时
/// 回退该 skill 的内置只读副本，资源也没有则维持既有 Unavailable 语义。
fn resolve_skill_root_in(
    effective: &EffectiveSkillRoot,
    resource_id_dir: Option<&Path>,
    skill_id: &str,
) -> Result<SkillRoot, String> {
    let id_dir = effective.path.join(skill_id);

    if effective.status != SkillFileRootStatus::Unavailable && id_dir.exists() {
        return Ok(SkillRoot {
            path: id_dir
                .canonicalize()
                .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?,
            writable: effective.writable,
            status: if effective.writable {
                SkillFileRootStatus::Available
            } else {
                SkillFileRootStatus::Readonly
            },
            reason: effective.reason.clone(),
        });
    }

    if let Some(resource_id_dir) = resource_id_dir {
        if resource_id_dir.exists() {
            return Ok(SkillRoot {
                path: resource_id_dir
                    .canonicalize()
                    .map_err(|error| format!("无法解析内置 skill 文件目录：{error}"))?,
                writable: false,
                status: SkillFileRootStatus::Readonly,
                reason: Some("该 skill 播种到可写目录失败，当前为内置只读副本。".to_string()),
            });
        }
    }

    Ok(SkillRoot {
        path: id_dir,
        writable: false,
        status: SkillFileRootStatus::Unavailable,
        // 根级不可用原因（如 app-data 创建失败）随 per-id 结果穿出，UI 如实显示。
        reason: effective.reason.clone(),
    })
}

fn validate_skill_id(skill_id: &str) -> Result<(), String> {
    if SKILL_IDS.contains(&skill_id) {
        Ok(())
    } else {
        Err(format!("未知 skill：{skill_id}"))
    }
}

fn list_skill_files_for_root(root: &Path, writable: bool) -> Result<Vec<SkillFileEntry>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?;
    let mut files = Vec::new();

    collect_skill_files(&root, &root, writable, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(files)
}

fn collect_skill_files(
    root: &Path,
    current: &Path,
    writable: bool,
    files: &mut Vec<SkillFileEntry>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(current)
        .map_err(|error| format!("无法读取 skill 文件目录 {}：{error}", current.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取 skill 文件项：{error}"))?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();

        if name == ".DS_Store" || name.ends_with(".swp") {
            continue;
        }

        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("无法检查 skill 文件 {}：{error}", path.display()))?;

        if metadata.file_type().is_symlink() {
            files.push(SkillFileEntry {
                path: relative_display_path(root, &path)?,
                kind: SkillFileKind::File,
                size_bytes: metadata.len(),
                can_preview: false,
                can_edit: false,
                reason: Some("symlink 文件不可预览。".to_string()),
            });
            continue;
        }

        if metadata.is_dir() {
            collect_skill_files(root, &path, writable, files)?;
            continue;
        }

        if metadata.is_file() {
            files.push(inspect_file(root, &path, writable)?);
        }
    }

    Ok(())
}

fn inspect_file(root: &Path, path: &Path, writable: bool) -> Result<SkillFileEntry, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查 skill 文件 {}：{error}", path.display()))?;
    let relative_path = relative_display_path(root, path)?;

    if metadata.file_type().is_symlink() {
        return Ok(SkillFileEntry {
            path: relative_path,
            kind: SkillFileKind::File,
            size_bytes: metadata.len(),
            can_preview: false,
            can_edit: false,
            reason: Some("symlink 文件不可预览。".to_string()),
        });
    }

    if !metadata.is_file() {
        return Ok(SkillFileEntry {
            path: relative_path,
            kind: SkillFileKind::File,
            size_bytes: metadata.len(),
            can_preview: false,
            can_edit: false,
            reason: Some("目录不可作为文本文件预览。".to_string()),
        });
    }

    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Ok(SkillFileEntry {
            path: relative_path,
            kind: SkillFileKind::File,
            size_bytes: metadata.len(),
            can_preview: false,
            can_edit: false,
            reason: Some("文件超过轻量预览大小限制。".to_string()),
        });
    }

    let bytes = std::fs::read(path)
        .map_err(|error| format!("无法读取 skill 文件 {}：{error}", path.display()))?;

    if String::from_utf8(bytes).is_err() {
        return Ok(SkillFileEntry {
            path: relative_path,
            kind: SkillFileKind::File,
            size_bytes: metadata.len(),
            can_preview: false,
            can_edit: false,
            reason: Some("非 UTF-8 文本文件不可预览。".to_string()),
        });
    }

    Ok(SkillFileEntry {
        path: relative_path,
        kind: SkillFileKind::File,
        size_bytes: metadata.len(),
        can_preview: true,
        can_edit: writable,
        reason: if writable {
            None
        } else {
            Some("只读 skill 资源不可编辑。".to_string())
        },
    })
}

fn read_text_file(
    skill_id: &str,
    root: &Path,
    path: &Path,
    writable: bool,
    root_reason: Option<&str>,
) -> Result<SkillFileContentResponse, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?;
    let entry = inspect_file(&root, path, writable)?;

    if !entry.can_preview {
        return Err(entry
            .reason
            .unwrap_or_else(|| "该文件当前不可预览。".to_string()));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("无法读取 skill 文件 {}：{error}", entry.path))?;

    Ok(SkillFileContentResponse {
        skill_id: skill_id.to_string(),
        path: entry.path,
        content,
        editable: entry.can_edit,
        readonly_reason: if entry.can_edit {
            None
        } else {
            // 根级原因（如播种失败回退内置副本）优先于通用 per-file 文案。
            root_reason.map(str::to_string).or(entry.reason)
        },
    })
}

fn resolve_existing_file(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() {
        return Err("skill 文件路径不能为空。".to_string());
    }

    let relative = PathBuf::from(relative_path);

    if relative.is_absolute() {
        return Err(format!("skill 文件路径必须是相对路径：{relative_path}"));
    }

    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err(format!("skill 文件路径逃逸目录：{relative_path}"));
    }

    let root = root
        .canonicalize()
        .map_err(|error| format!("无法解析 skill 文件目录：{error}"))?;
    let candidate = root.join(relative);

    if !candidate.exists() {
        return Err(format!("skill 文件不存在：{relative_path}"));
    }

    let metadata = std::fs::symlink_metadata(&candidate)
        .map_err(|error| format!("无法检查 skill 文件：{error}"))?;

    if metadata.file_type().is_symlink() {
        return Err("拒绝访问 symlink skill 文件。".to_string());
    }

    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析 skill 文件：{error}"))?;

    if !is_parent_or_same(&root, &resolved) {
        return Err(format!("skill 文件路径逃逸目录：{relative_path}"));
    }

    Ok(resolved)
}

fn relative_display_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("skill 文件路径逃逸目录：{}", path.display()))?;

    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn is_parent_or_same(parent: &Path, child: &Path) -> bool {
    let parent = normalize_for_compare(parent);
    let child = normalize_for_compare(child);

    child == parent || child.starts_with(parent)
}

fn normalize_for_compare(path: &Path) -> PathBuf {
    path.components().collect()
}

fn timestamp_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_nested_text_skill_files() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "name: test");
        write_file(&root.join("docs/rules.md"), "# rules");
        write_file(&root.join("tools/run.js"), "console.log('ok');");

        let files = list_skill_files_for_root(&root, true).expect("list skill files");

        assert_eq!(
            files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
            vec!["SKILL.md", "docs/rules.md", "tools/run.js"],
        );
        assert!(files.iter().all(|file| file.can_preview));
        assert!(files.iter().all(|file| file.can_edit));

        cleanup(root);
    }

    #[test]
    fn marks_binary_and_large_files_as_not_previewable() {
        let root = create_test_skill_root();
        std::fs::write(root.join("binary.bin"), [0, 159, 146, 150]).expect("write binary");
        std::fs::write(root.join("large.txt"), vec![b'a'; (MAX_TEXT_FILE_BYTES + 1) as usize])
            .expect("write large");

        let files = list_skill_files_for_root(&root, true).expect("list skill files");

        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|file| !file.can_preview));
        assert!(files.iter().all(|file| !file.can_edit));

        cleanup(root);
    }

    #[test]
    fn reads_and_writes_small_text_files() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "before");
        let path = resolve_existing_file(&root, "SKILL.md").expect("resolve file");

        let before = read_text_file("tsn-topology", &root, &path, true, None).expect("read file");
        assert_eq!(before.content, "before");
        assert!(before.editable);

        let temp_path = path.with_extension(format!("tmp-{}", timestamp_nanos()));
        std::fs::write(&temp_path, "after").expect("write temp");
        std::fs::rename(&temp_path, &path).expect("rename temp");

        let after = read_text_file("tsn-topology", &root, &path, true, None).expect("read file");
        assert_eq!(after.content, "after");

        cleanup(root);
    }

    #[test]
    fn rejects_escaping_and_absolute_paths() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "content");

        assert!(resolve_existing_file(&root, "../SKILL.md").is_err());
        assert!(resolve_existing_file(&root, "/tmp/SKILL.md").is_err());

        cleanup(root);
    }

    #[test]
    fn readonly_roots_can_preview_but_not_edit() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "content");
        let files = list_skill_files_for_root(&root, false).expect("list skill files");

        assert_eq!(files.len(), 1);
        assert!(files[0].can_preview);
        assert!(!files[0].can_edit);
        assert_eq!(files[0].reason.as_deref(), Some("只读 skill 资源不可编辑。"));

        cleanup(root);
    }

    #[test]
    fn effective_root_prefers_existing_dev_root_without_seeding() {
        let dev = create_test_skill_root();
        let app_data = unique_temp_path("tsn-skill-appdata");

        let effective = resolve_effective_root(Some(&dev), Some(&app_data), None);

        assert!(effective.writable);
        assert_eq!(effective.status, SkillFileRootStatus::Available);
        assert_eq!(effective.path, dev);
        assert!(!app_data.exists(), "dev 命中时不得触发 app-data 播种");

        cleanup(dev);
    }

    #[test]
    fn effective_root_seeds_app_data_once_and_preserves_user_edits() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        write_file(&resource.join("tsn-topology/package.json"), "{}");
        let app_data = unique_temp_path("tsn-skill-appdata");

        let first = resolve_effective_root(None, Some(&app_data), Some(&resource));
        assert!(first.writable);
        assert_eq!(first.status, SkillFileRootStatus::Available);
        assert_eq!(first.path, app_data);
        let seeded = app_data.join("tsn-topology/SKILL.md");
        assert_eq!(std::fs::read_to_string(&seeded).expect("seeded"), "factory");

        // 用户编辑后再次解析：目录已播种即跳过，不覆盖（R4）。
        std::fs::write(&seeded, "user-edited").expect("user edit");
        let second = resolve_effective_root(None, Some(&app_data), Some(&resource));
        assert!(second.writable);
        assert_eq!(std::fs::read_to_string(&seeded).expect("seeded"), "user-edited");

        cleanup(resource);
        cleanup(app_data);
    }

    #[test]
    fn effective_root_preserves_unrelated_app_data_siblings() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let app_data = unique_temp_path("tsn-skill-appdata");
        // app-data 根下预置无关内容（如用户备份）——播种不得触碰（R6）。
        write_file(&app_data.join("backup-keep/db.bak"), "precious");

        let effective = resolve_effective_root(None, Some(&app_data), Some(&resource));

        assert!(effective.writable);
        assert_eq!(
            std::fs::read_to_string(app_data.join("backup-keep/db.bak")).expect("kept"),
            "precious"
        );

        cleanup(resource);
        cleanup(app_data);
    }

    #[cfg(unix)]
    #[test]
    fn seeding_skips_symlink_entries() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let outside = resource.join("outside.txt");
        std::fs::write(&outside, "secret").expect("write outside");
        std::os::unix::fs::symlink(&outside, resource.join("tsn-topology/link.txt"))
            .expect("create symlink");
        let app_data = unique_temp_path("tsn-skill-appdata");

        let effective = resolve_effective_root(None, Some(&app_data), Some(&resource));

        assert!(effective.writable);
        assert!(app_data.join("tsn-topology/SKILL.md").exists());
        assert!(
            !app_data.join("tsn-topology/link.txt").exists(),
            "symlink 条目不得被解引用复制进用户目录"
        );

        cleanup(resource);
        cleanup(app_data);
    }

    #[cfg(unix)]
    #[test]
    fn effective_root_falls_back_to_resource_readonly_when_app_data_unwritable() {
        use std::os::unix::fs::PermissionsExt;

        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let locked_parent = create_test_skill_root();
        std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o555))
            .expect("lock parent");
        let app_data = locked_parent.join("skills");

        let effective = resolve_effective_root(None, Some(&app_data), Some(&resource));

        assert!(!effective.writable);
        assert_eq!(effective.status, SkillFileRootStatus::Readonly);
        assert_eq!(effective.path, resource);
        assert!(effective.reason.is_some(), "回退必须带原因穿透 readonly_reason");

        std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o755))
            .expect("unlock parent");
        cleanup(resource);
        cleanup(locked_parent);
    }

    #[test]
    fn effective_root_unavailable_when_all_candidates_absent() {
        let missing_dev = unique_temp_path("tsn-skill-nodev");

        let effective = resolve_effective_root(Some(&missing_dev), None, None);

        assert!(!effective.writable);
        assert_eq!(effective.status, SkillFileRootStatus::Unavailable);
    }

    #[test]
    fn root_reason_takes_precedence_over_per_file_reason() {
        let root = create_test_skill_root();
        write_file(&root.join("SKILL.md"), "content");
        let path = resolve_existing_file(&root, "SKILL.md").expect("resolve file");

        let with_root_reason =
            read_text_file("tsn-topology", &root, &path, false, Some("根级回退原因")).expect("read");
        assert!(!with_root_reason.editable);
        assert_eq!(with_root_reason.readonly_reason.as_deref(), Some("根级回退原因"));

        let without_root_reason =
            read_text_file("tsn-topology", &root, &path, false, None).expect("read");
        assert_eq!(
            without_root_reason.readonly_reason.as_deref(),
            Some("只读 skill 资源不可编辑。")
        );

        cleanup(root);
    }

    #[test]
    fn into_usable_path_maps_status_to_worker_consumption() {
        let usable = EffectiveSkillRoot {
            path: PathBuf::from("/tmp/x"),
            writable: false,
            status: SkillFileRootStatus::Readonly,
            reason: None,
        };
        assert_eq!(usable.into_usable_path(), Some(PathBuf::from("/tmp/x")));

        let unavailable = EffectiveSkillRoot {
            path: PathBuf::from("/tmp/x"),
            writable: false,
            status: SkillFileRootStatus::Unavailable,
            reason: None,
        };
        assert_eq!(unavailable.into_usable_path(), None);
    }

    #[test]
    fn factory_upgrade_three_state_judgment_covers_ae1() {
        // AE1：旧版 app-data（改过的旧 SKILL.md + 未改的旧出厂文件 + 移除清单
        // 孤儿，无 manifest）→ 升级后：缺失补播、未改更新、改过保留、孤儿删除。
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory-v2-index");
        write_file(&resource.join("tsn-topology/references/aero.md"), "aero-v2");
        write_file(&resource.join("tsn-flow-planning/SKILL.md"), "flow-v2");
        let app_data = unique_temp_path("tsn-skill-appdata");
        // 旧出厂内容（v1）：SKILL.md 被用户改过；flow 未改；package.json 是孤儿。
        let old_factory_skill = "factory-v1-monolith";
        let old_factory_flow = "flow-v1";
        let old_factory_pkg = "{\"type\":\"commonjs\"}";
        write_file(&app_data.join("tsn-topology/SKILL.md"), "user-edited-v1");
        write_file(&app_data.join("tsn-flow-planning/SKILL.md"), old_factory_flow);
        write_file(&app_data.join("tsn-topology/package.json"), old_factory_pkg);
        let historical = [
            sha256_hex(old_factory_skill.as_bytes()),
            sha256_hex(old_factory_flow.as_bytes()),
            sha256_hex(old_factory_pkg.as_bytes()),
        ];
        let historical_refs: Vec<&str> = historical.iter().map(String::as_str).collect();

        ensure_seeded_with(
            &app_data,
            Some(&resource),
            &historical_refs,
            &["tsn-topology/package.json"],
        )
        .expect("seed");

        // 缺失补播。
        assert_eq!(read(&app_data, "tsn-topology/references/aero.md"), "aero-v2");
        // 未编辑旧出厂 → 静默更新。
        assert_eq!(read(&app_data, "tsn-flow-planning/SKILL.md"), "flow-v2");
        // 用户改过 → 保留。
        assert_eq!(read(&app_data, "tsn-topology/SKILL.md"), "user-edited-v1");
        // 移除清单孤儿（未改）→ 删除。
        assert!(!app_data.join("tsn-topology/package.json").exists());
        // manifest 落点不在 per-skill 目录内，且记录用户态。
        let manifest = read_manifest(&app_data);
        assert!(manifest.modified.iter().any(|p| p == "tsn-topology/SKILL.md"));
        assert_eq!(
            manifest.files.get("tsn-flow-planning/SKILL.md").map(String::as_str),
            Some(sha256_hex("flow-v2".as_bytes()).as_str())
        );

        cleanup(resource);
        cleanup(app_data);
    }

    #[test]
    fn factory_upgrade_with_manifest_and_user_edit_survives_two_upgrades() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory-v1");
        let app_data = unique_temp_path("tsn-skill-appdata");

        // 首播 → 用户编辑 → 升级两轮（v2、v3 出厂），编辑必须始终保留。
        ensure_seeded_with(&app_data, Some(&resource), &[], &[]).expect("seed v1");
        write_file(&app_data.join("tsn-topology/SKILL.md"), "user-edited");

        write_file(&resource.join("tsn-topology/SKILL.md"), "factory-v2");
        ensure_seeded_with(&app_data, Some(&resource), &[], &[]).expect("seed v2");
        assert_eq!(read(&app_data, "tsn-topology/SKILL.md"), "user-edited");

        write_file(&resource.join("tsn-topology/SKILL.md"), "factory-v3");
        ensure_seeded_with(&app_data, Some(&resource), &[], &[]).expect("seed v3");
        assert_eq!(read(&app_data, "tsn-topology/SKILL.md"), "user-edited");

        cleanup(resource);
        cleanup(app_data);
    }

    #[test]
    fn factory_upgrade_via_manifest_recorded_hash_updates_unedited_file() {
        // manifest 在场的常规升级：未编辑文件（哈希==manifest 登记的旧出厂值）
        // 随新版本更新，无需历代常量表。
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory-v1");
        let app_data = unique_temp_path("tsn-skill-appdata");
        ensure_seeded_with(&app_data, Some(&resource), &[], &[]).expect("seed v1");

        write_file(&resource.join("tsn-topology/SKILL.md"), "factory-v2");
        ensure_seeded_with(&app_data, Some(&resource), &[], &[]).expect("seed v2");

        assert_eq!(read(&app_data, "tsn-topology/SKILL.md"), "factory-v2");
        let manifest = read_manifest(&app_data);
        assert!(manifest.modified.is_empty());

        cleanup(resource);
        cleanup(app_data);
    }

    #[test]
    fn corrupt_manifest_degrades_to_historical_judgment_without_panic() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory-v2");
        let app_data = unique_temp_path("tsn-skill-appdata");
        write_file(&app_data.join("tsn-topology/SKILL.md"), "factory-v1");
        write_file(&app_data.join(FACTORY_MANIFEST_NAME), "{not-json!!");
        let historical = [sha256_hex("factory-v1".as_bytes())];
        let refs: Vec<&str> = historical.iter().map(String::as_str).collect();

        ensure_seeded_with(&app_data, Some(&resource), &refs, &[]).expect("seed");

        assert_eq!(read(&app_data, "tsn-topology/SKILL.md"), "factory-v2");

        cleanup(resource);
        cleanup(app_data);
    }

    #[test]
    fn user_modified_orphan_survives_removal_list() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let app_data = unique_temp_path("tsn-skill-appdata");
        write_file(&app_data.join("tsn-topology/package.json"), "user-customized");

        ensure_seeded_with(&app_data, Some(&resource), &[], &["tsn-topology/package.json"])
            .expect("seed");

        assert_eq!(read(&app_data, "tsn-topology/package.json"), "user-customized");

        cleanup(resource);
        cleanup(app_data);
    }

    #[test]
    fn current_factory_content_is_not_rewritten_on_resolve() {
        // 竞态防线：文件已是当前出厂内容时再次解析不产生写入（mtime 不变）。
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let app_data = unique_temp_path("tsn-skill-appdata");
        ensure_seeded_with(&app_data, Some(&resource), &[], &[]).expect("first seed");

        let dst = app_data.join("tsn-topology/SKILL.md");
        let before = std::fs::metadata(&dst).expect("meta").modified().expect("mtime");
        ensure_seeded_with(&app_data, Some(&resource), &[], &[]).expect("second seed");
        let after = std::fs::metadata(&dst).expect("meta").modified().expect("mtime");

        assert_eq!(before, after, "当前出厂内容不得被无谓重写");

        cleanup(resource);
        cleanup(app_data);
    }

    fn read(root: &Path, rel: &str) -> String {
        std::fs::read_to_string(root.join(rel)).expect("read seeded file")
    }

    #[test]
    fn per_id_resolution_falls_back_to_resource_when_seeded_dir_missing() {
        let resource = create_test_skill_root();
        write_file(&resource.join("tsn-topology/SKILL.md"), "factory");
        let app_data = create_test_skill_root(); // 可写根存在但缺 tsn-topology（个别播种失败）

        let effective = EffectiveSkillRoot {
            path: app_data.clone(),
            writable: true,
            status: SkillFileRootStatus::Available,
            reason: None,
        };
        let resource_id = resource.join("tsn-topology");

        let root = resolve_skill_root_in(&effective, Some(&resource_id), "tsn-topology")
            .expect("resolve");
        assert!(!root.writable);
        assert_eq!(root.status, SkillFileRootStatus::Readonly);
        assert!(root.reason.is_some());

        // 资源也没有 → 维持既有 Unavailable 语义。
        let missing = resolve_skill_root_in(&effective, None, "tsn-time-sync").expect("resolve");
        assert_eq!(missing.status, SkillFileRootStatus::Unavailable);

        cleanup(resource);
        cleanup(app_data);
    }

    /// 唯一临时路径：macOS SystemTime 仅微秒精度，并行测试同微秒会撞名——
    /// 叠加进程内原子序号保证唯一。
    fn unique_temp_path(prefix: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            timestamp_nanos(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn create_test_skill_root() -> PathBuf {
        let root = unique_temp_path("tsn-agent-skill-files-test");
        std::fs::create_dir_all(&root).expect("create root");
        root
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, content).expect("write file");
    }

    fn cleanup(path: PathBuf) {
        std::fs::remove_dir_all(path).expect("cleanup test dir");
    }
}
