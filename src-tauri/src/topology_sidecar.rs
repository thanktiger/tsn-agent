//! Plan v3 U3：axum 本地 sidecar + per-launch Bearer token。
//!
//! 启动顺序（Tauri `setup()` 同步调用）：
//!   1. mint per-launch token (`OsRng` 32 字节 → base64url)
//!   2. bind 127.0.0.1:<random port>（IPv4 literal，避免 Windows IPv6 优先问题）
//!   3. spawn axum task on `tauri::async_runtime`，持 `CancellationToken`
//!   4. 应用 state 持 `SidecarHandle { url, token, cancel, port }`
//!
//! token 仅在 Rust 内存中流转（`SecretToken` 自定义 `Debug` 输出 `[REDACTED]`），
//! UI 永远不接触；worker spawn 时通过 env 注入到 MCP child。
//! Bearer 校验走自定义 `from_fn` middleware + `subtle::ConstantTimeEq`（**不用** tower-http
//! builtin `ValidateRequestHeaderLayer::bearer`，后者按字符串 `==` 非常量时间）。
//!
//! U4a 已完成：8 个 `/db/topology/*` route 由 topology_sidecar_routes 提供 sqlx 实现。

use std::fmt;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::topology_mutation_buffer::TopologyMutationBuffer;
use crate::topology_sidecar_routes::{self, MutationEmitFn, RouteState};

/// per-launch capability token。`Debug` impl 输出 `[REDACTED]`，
/// 进程结束自动 zeroize（`String` 的 buffer 在 Drop 时清零写不保证；
/// 但本 token 进程内只持一次、不持久化、`Debug` 与 panic backtrace 均不泄露字面值，
/// 满足 plan v3 KTD 的 immutability + non-leak invariant）。
#[derive(Clone)]
pub struct SecretToken(Arc<String>);

impl SecretToken {
    fn new(raw: String) -> Self {
        Self(Arc::new(raw))
    }

    /// 暴露字面值。仅在 worker spawn env 注入、HTTP Authorization 字符串比较时使用。
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for SecretToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretToken([REDACTED])")
    }
}

impl Drop for SecretToken {
    fn drop(&mut self) {
        // Arc 引用计数到 0 时 String 被 drop。受 Rust 语义限制无法真正 zeroize 已 alloc 的 String，
        // 但本 token 不会被序列化 / 不持久化 / Debug 不泄漏，对 plan v3 威胁模型足够。
    }
}

/// Tauri State：sidecar 生命周期句柄。`run_claude_agent` 从此处取 `url + token` 注入 worker。
pub struct SidecarHandle {
    pub url: String,
    pub token: SecretToken,
    pub port: u16,
    cancel: CancellationToken,
}

impl SidecarHandle {
    /// Tauri 退出时调用。
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}

impl fmt::Debug for SidecarHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SidecarHandle")
            .field("url", &self.url)
            .field("token", &self.token)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

/// 生成 32 字节 OsRng → base64url-no-pad → 43 字符 token。
fn mint_token() -> SecretToken {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    SecretToken::new(URL_SAFE_NO_PAD.encode(bytes))
}

/// Bind 127.0.0.1:0 拿 ephemeral port。绑定失败直接 panic（plan v3 fail-closed）。
async fn bind_loopback() -> Result<(TcpListener, u16), String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|error| format!("拓扑 sidecar 服务启动失败：{error}；建议检查 127.0.0.1 占用或重启应用"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("拓扑 sidecar 端口解析失败：{error}"))?
        .port();
    Ok((listener, port))
}

/// 自定义 from_fn Bearer middleware：取 `Authorization: Bearer <token>`，
/// 用 `subtle::ConstantTimeEq` 与 state 中持有的 token 比较。
async fn bearer_auth_middleware(
    State(token): State<Arc<SecretToken>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let headers: &HeaderMap = req.headers();
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|hv| hv.to_str().ok())
        .and_then(|raw| raw.strip_prefix("Bearer "));
    let Some(presented) = presented else {
        return unauthorized_response();
    };
    let expected = token.expose();
    if presented.as_bytes().ct_eq(expected.as_bytes()).into() {
        next.run(req).await
    } else {
        unauthorized_response()
    }
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        r#"{"error":"unauthorized","message":"missing or invalid bearer token"}"#,
    )
        .into_response()
}

/// 构建 8 route router + Bearer middleware。U4a-2 后 build_artifacts /
/// validate_artifacts / describe_* 占位会被替换为 Rust 端 artifacts 实现。
pub fn build_router(token: SecretToken, route_state: Arc<RouteState>) -> Router {
    let token_state = Arc::new(token);
    Router::new()
        .route("/healthz", get(topology_sidecar_routes::healthz))
        .route(
            "/db/topology/describe_templates",
            post(topology_sidecar_routes::describe_templates),
        )
        .route(
            "/db/topology/describe_artifacts",
            post(topology_sidecar_routes::describe_artifacts),
        )
        .route(
            "/db/topology/initialize",
            post(topology_sidecar_routes::initialize),
        )
        .route(
            "/db/topology/inspect",
            post(topology_sidecar_routes::inspect),
        )
        .route(
            "/db/topology/validate",
            post(topology_sidecar_routes::validate),
        )
        .route(
            "/db/topology/build_artifacts",
            post(topology_sidecar_routes::build_artifacts),
        )
        .route(
            "/db/topology/validate_artifacts",
            post(topology_sidecar_routes::validate_artifacts),
        )
        .route(
            "/db/topology/apply_operations",
            post(topology_sidecar_routes::apply_operations),
        )
        .with_state(route_state)
        .route_layer(middleware::from_fn_with_state(
            token_state,
            bearer_auth_middleware,
        ))
}

/// 测试辅助：用 in-memory pool 起 router；emit closure 为 no-op。
#[cfg(test)]
pub(crate) async fn build_test_router_with_pool(
    pool: sqlx::Pool<sqlx::Sqlite>,
    mutation_buffer: Arc<TopologyMutationBuffer>,
) -> (Router, SecretToken) {
    let token = mint_token();
    let state = Arc::new(RouteState {
        pool,
        mutation_buffer,
        emit: Arc::new(|_record| {}),
    });
    (build_router(token.clone(), state), token)
}

/// 启动 sidecar：bind + token + spawn axum task。返回 `SidecarHandle`。
/// 失败 panic：plan v3 显式 fail-closed，不再有 fallback flag。
pub async fn launch(
    pool: sqlx::Pool<sqlx::Sqlite>,
    mutation_buffer: Arc<TopologyMutationBuffer>,
    emit: MutationEmitFn,
) -> SidecarHandle {
    let token = mint_token();
    let (listener, port) = bind_loopback()
        .await
        .unwrap_or_else(|msg| panic!("{msg}"));
    let url = format!("http://127.0.0.1:{port}");
    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    let route_state = Arc::new(RouteState {
        pool,
        mutation_buffer,
        emit,
    });
    let router = build_router(token.clone(), route_state);

    tauri::async_runtime::spawn(async move {
        let serve = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(async move {
                cancel_for_task.cancelled().await;
            });
        if let Err(error) = serve.await {
            // shutdown 之后 axum 正常返回 Ok；只有 unexpected error 走这里。
            eprintln!("拓扑 sidecar 终止：{error}");
        }
    });

    SidecarHandle {
        url,
        token,
        port,
        cancel,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use sqlx::sqlite::SqlitePoolOptions;
    use tower::ServiceExt;

    async fn test_state() -> (sqlx::Pool<sqlx::Sqlite>, Arc<TopologyMutationBuffer>) {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();
        let buffer = Arc::new(TopologyMutationBuffer::default());
        (pool, buffer)
    }

    #[test]
    fn mint_token_returns_43_char_base64url_no_pad() {
        let t = mint_token();
        let exposed = t.expose();
        assert_eq!(exposed.len(), 43);
        assert!(exposed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }

    #[test]
    fn mint_token_two_calls_produce_distinct_tokens() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a.expose(), b.expose());
    }

    #[test]
    fn debug_secret_token_redacts() {
        let t = mint_token();
        let formatted = format!("{:?}", t);
        assert!(!formatted.contains(t.expose()));
        assert!(formatted.contains("REDACTED"));
    }

    #[test]
    fn router_rejects_missing_bearer_with_401() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, _token) = build_test_router_with_pool(pool, buf).await;
            let resp = router
                .clone()
                .oneshot(Request::builder().method("GET").uri("/healthz").body(Body::empty()).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        });
    }

    #[test]
    fn router_rejects_wrong_bearer_with_401() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, _token) = build_test_router_with_pool(pool, buf).await;
            let resp = router
                .oneshot(Request::builder().method("GET").uri("/healthz")
                    .header("Authorization", "Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxx")
                    .body(Body::empty()).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        });
    }

    #[test]
    fn router_accepts_correct_bearer_and_returns_200_on_healthz() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            let resp = router
                .oneshot(Request::builder().method("GET").uri("/healthz")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .body(Body::empty()).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let body = to_bytes(resp.into_body(), 1024).await.unwrap();
            assert!(body.starts_with(b"{\"status\":\"ok\""));
        });
    }

    #[test]
    fn router_returns_template_catalog_on_describe_templates() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            let body = serde_json::json!({ "sessionId": "s1" }).to_string();
            let resp = router
                .oneshot(Request::builder().method("POST").uri("/db/topology/describe_templates")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body)).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 16_384).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["templateCount"], 3);
        });
    }

    #[test]
    fn initialize_persists_topology_and_mints_mutation_id() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let body = serde_json::json!({
                "sessionId": "s1",
                "templateId": "generic-line",
                "params": { "switchCount": 2, "endSystemsPerSwitch": 2 }
            }).to_string();
            let resp = router
                .oneshot(Request::builder().method("POST").uri("/db/topology/initialize")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body)).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);

            let bytes = to_bytes(resp.into_body(), 16_384).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["mutationId"], 1);
            assert_eq!(parsed["summary"]["persisted"], true);
            assert_eq!(parsed["summary"]["sessionId"], "s1");
            // 不再返回 full topology（agent 用 inspect 查询切片）。
            assert!(parsed.get("full").is_none());

            // 2 交换机 + 4 端系统 = 6 节点；1 条骨干 + 4 条接入 = 5 链路。
            let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            let link_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(node_count, 6);
            assert_eq!(link_count, 5);

            // ring buffer 推进。
            assert_eq!(buf.since("s1", 0).latest, 1);
        });
    }

    #[test]
    fn initialize_replaces_previous_topology_on_reinitialize() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            for params in [
                serde_json::json!({ "switchCount": 4, "endSystemsPerSwitch": 5 }),
                serde_json::json!({ "switchCount": 2, "endSystemsPerSwitch": 2 }),
            ] {
                let body = serde_json::json!({
                    "sessionId": "s1",
                    "templateId": "generic-line",
                    "params": params,
                }).to_string();
                let resp = router.clone()
                    .oneshot(Request::builder().method("POST").uri("/db/topology/initialize")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body)).unwrap())
                    .await.unwrap();
                assert_eq!(resp.status(), StatusCode::OK);
            }

            // 第二次 initialize 整表重建为 2×2。
            let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(node_count, 6);
            assert_eq!(buf.since("s1", 0).latest, 2);
        });
    }

    #[test]
    fn apply_operations_inserts_and_mints_mutation_id() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let body = serde_json::json!({
                "sessionId": "s1",
                "operations": [
                    { "op": "node_add", "imac": 1, "syncName": "0", "x": 0.0, "y": 0.0, "syncType": "{}", "insertOrder": 0 }
                ],
                "dryRun": false
            }).to_string();
            let resp = router
                .oneshot(Request::builder().method("POST").uri("/db/topology/apply_operations")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body)).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);

            let bytes = to_bytes(resp.into_body(), 8192).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["mutationId"], 1);

            // 验证行真的写到 db
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(count, 1);

            // 验证 ring buffer 推进了
            let resp = buf.since("s1", 0);
            assert_eq!(resp.latest, 1);
        });
    }

    #[test]
    fn apply_operations_dry_run_rolls_back_and_skips_mutation_id() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            let body = serde_json::json!({
                "sessionId": "s1",
                "operations": [
                    { "op": "node_add", "imac": 2, "syncName": "0", "x": 0.0, "y": 0.0, "syncType": "{}", "insertOrder": 0 }
                ],
                "dryRun": true
            }).to_string();
            let resp = router
                .oneshot(Request::builder().method("POST").uri("/db/topology/apply_operations")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body)).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 8192).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["summary"]["dryRun"], true);
            assert!(parsed["summary"]["mutationId"].is_null());

            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(count, 0);
            assert_eq!(buf.since("s1", 0).mutations.len(), 0);
        });
    }

    #[test]
    fn apply_operations_rejects_unknown_session_with_forbidden_operation() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            let body = serde_json::json!({
                "sessionId": "ghost",
                "operations": [],
                "dryRun": false
            }).to_string();
            let resp = router
                .oneshot(Request::builder().method("POST").uri("/db/topology/apply_operations")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body)).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
        });
    }

    #[test]
    fn inspect_returns_counts_for_session() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO topology_nodes (session_id, imac, sync_name, x, y, sync_type, insert_order) VALUES ('s1', 1, '0', 0, 0, '{}', 0), ('s1', 2, '1', 1, 1, '{}', 1)")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            let body = serde_json::json!({ "sessionId": "s1" }).to_string();
            let resp = router
                .oneshot(Request::builder().method("POST").uri("/db/topology/inspect")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body)).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["summary"]["nodeCount"], 2);
            assert_eq!(parsed["summary"]["linkCount"], 0);
        });
    }

    #[test]
    fn validate_detects_dangling_link_references() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            // Insert link pointing at non-existent nodes
            sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_imac, dst_imac, styles_json) VALUES ('s1', 0, 99, 100, '{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            let body = serde_json::json!({ "sessionId": "s1" }).to_string();
            let resp = router
                .oneshot(Request::builder().method("POST").uri("/db/topology/validate")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body)).unwrap())
                .await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], false);
            assert!(parsed["summary"]["errors"].as_array().unwrap().len() >= 1);
        });
    }
}
