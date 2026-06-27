//! INET 软仿 HTTP 服务配置（2026-06-27）：base_url 持久化 + 读写命令。
//!
//! 镜像 `hardware_api_config.rs`，但**默认为空 = 未启用**：配了 base_url 走 HTTP 软仿，
//! 留空走现有 SSH 兜底（plan KTD4/U5）。与 `InetHostConfig`（SSH）、`HardwareApiConfig`
//! 三套配置解耦。base_url 自用工具信任输入，仅校验「空，或 http(s) 前缀」。

use serde::{Deserialize, Serialize};

/// app_state 里 INET 软仿 HTTP 配置的 key。
const INET_SIM_HTTP_CONFIG_KEY: &str = "inet_sim_http_config";
/// 覆盖 base_url 的环境变量。
const INET_SIM_HTTP_URL_ENV: &str = "TSN_AGENT_INET_SIM_HTTP_URL";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InetSimHttpConfig {
    /// 软仿 HTTP 服务根地址（如 `http://100.104.38.106:19090`）；空=未启用，走 SSH。序列化为 `baseUrl`。
    pub base_url: String,
}

/// base_url 合法性：空（未启用）OK，否则需 http(s) 前缀。
fn is_valid_base_url(url: &str) -> bool {
    let u = url.trim();
    u.is_empty() || u.starts_with("http://") || u.starts_with("https://")
}

/// 读 UI 持久的软仿 HTTP 配置（app_state）。无记录 → None。
async fn load_config(pool: &sqlx::Pool<sqlx::Sqlite>) -> Option<InetSimHttpConfig> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_state WHERE key = ? LIMIT 1")
            .bind(INET_SIM_HTTP_CONFIG_KEY)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    raw.and_then(|s| serde_json::from_str::<InetSimHttpConfig>(&s).ok())
}

/// 解析最终 base_url：env 覆盖 > UI 持久值 > 默认（空）。
/// 空 → Ok(None)（未启用，走 SSH）；非空非法 → Err；非空合法 → Ok(Some(url))。
pub async fn resolve_inet_sim_http_url(
    pool: &sqlx::Pool<sqlx::Sqlite>,
) -> Result<Option<String>, String> {
    let env_url = std::env::var(INET_SIM_HTTP_URL_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty());
    let resolved = match env_url {
        Some(u) => u,
        None => load_config(pool)
            .await
            .map(|c| c.base_url)
            .unwrap_or_default(),
    };
    let trimmed = resolved.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !is_valid_base_url(trimmed) {
        return Err(format!(
            "软仿 HTTP 地址 {trimmed:?} 非法（需 http:// 或 https:// 前缀），请在设置里改正。"
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// 读软仿 HTTP 配置给设置面板展示：UI 持久值优先，无则空（未启用）。
#[tauri::command]
pub async fn get_inet_sim_http_config(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
) -> Result<InetSimHttpConfig, String> {
    let pool = store.pool(&app).await?;
    if let Some(cfg) = load_config(pool).await {
        return Ok(cfg);
    }
    Ok(InetSimHttpConfig {
        base_url: String::new(),
    })
}

/// 写软仿 HTTP 配置（设置面板保存）。落 app_state；空（清空=禁用）或 http(s) 前缀才放行。
#[tauri::command]
pub async fn set_inet_sim_http_config(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    config: InetSimHttpConfig,
) -> Result<(), String> {
    if !is_valid_base_url(&config.base_url) {
        return Err("软仿 HTTP 地址需为空（走 SSH）或 http:// / https:// 前缀。".to_string());
    }
    let pool = store.pool(&app).await?;
    // 存 trim 后的值（空串=未启用）。
    let normalized = InetSimHttpConfig {
        base_url: config.base_url.trim().to_string(),
    };
    let json = serde_json::to_string(&normalized).map_err(|e| format!("序列化配置失败：{e}"))?;
    sqlx::query(
        "INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    )
    .bind(INET_SIM_HTTP_CONFIG_KEY)
    .bind(&json)
    .execute(pool)
    .await
    .map_err(|e| format!("写配置失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn app_state_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = SqliteConnectOptions::new().in_memory(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE app_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn write_ui(pool: &sqlx::Pool<sqlx::Sqlite>, url: &str) {
        let json = serde_json::to_string(&InetSimHttpConfig {
            base_url: url.to_string(),
        })
        .unwrap();
        sqlx::query(
            "INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, 'now')",
        )
        .bind(INET_SIM_HTTP_CONFIG_KEY)
        .bind(&json)
        .execute(pool)
        .await
        .unwrap();
    }

    #[test]
    fn valid_base_url_allows_empty_or_http() {
        assert!(is_valid_base_url("")); // 未启用
        assert!(is_valid_base_url("   "));
        assert!(is_valid_base_url("http://h:19090"));
        assert!(is_valid_base_url("https://h"));
        assert!(!is_valid_base_url("ftp://h"));
        assert!(!is_valid_base_url("100.104.38.106:19090"));
    }

    #[tokio::test]
    async fn no_value_resolves_none() {
        let pool = app_state_pool().await;
        if std::env::var(INET_SIM_HTTP_URL_ENV).is_err() {
            assert_eq!(resolve_inet_sim_http_url(&pool).await.unwrap(), None);
        }
    }

    #[tokio::test]
    async fn ui_value_round_trips_and_resolves_some() {
        let pool = app_state_pool().await;
        write_ui(&pool, "http://10.0.0.9:19090").await;
        if std::env::var(INET_SIM_HTTP_URL_ENV).is_err() {
            assert_eq!(
                resolve_inet_sim_http_url(&pool).await.unwrap(),
                Some("http://10.0.0.9:19090".to_string())
            );
        }
    }

    #[tokio::test]
    async fn empty_ui_value_resolves_none() {
        let pool = app_state_pool().await;
        write_ui(&pool, "").await;
        if std::env::var(INET_SIM_HTTP_URL_ENV).is_err() {
            assert_eq!(resolve_inet_sim_http_url(&pool).await.unwrap(), None);
        }
    }

    #[tokio::test]
    async fn invalid_persisted_url_rejected_on_resolve() {
        let pool = app_state_pool().await;
        write_ui(&pool, "not-a-url").await;
        if std::env::var(INET_SIM_HTTP_URL_ENV).is_err() {
            assert!(resolve_inet_sim_http_url(&pool).await.is_err());
        }
    }
}
