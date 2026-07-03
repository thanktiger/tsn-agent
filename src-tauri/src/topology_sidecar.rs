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

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use rand::rngs::OsRng;
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
    let listener = TcpListener::bind(addr).await.map_err(|error| {
        format!("拓扑 sidecar 服务启动失败：{error}；建议检查 127.0.0.1 占用或重启应用")
    })?;
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

/// 构建 8 route router + Bearer middleware。build_artifacts / validate_artifacts /
/// describe_* 均已是 Rust 端实现（见 topology_sidecar_routes.rs）。
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
        .route("/db/topology/undo", post(topology_sidecar_routes::undo))
        .route(
            "/db/timesync/set_gm",
            post(crate::timesync_sidecar_routes::set_gm),
        )
        .route(
            "/db/timesync/set_params",
            post(crate::timesync_sidecar_routes::set_params),
        )
        .route(
            "/db/timesync/toggle_link",
            post(crate::timesync_sidecar_routes::toggle_link),
        )
        .route(
            "/db/timesync/inspect",
            post(crate::timesync_sidecar_routes::inspect),
        )
        .route(
            "/db/timesync/undo",
            post(crate::timesync_sidecar_routes::undo),
        )
        .route(
            "/db/flow/add_stream",
            post(crate::flow_sidecar_routes::add_stream),
        )
        .route(
            "/db/flow/inspect",
            post(crate::flow_sidecar_routes::inspect),
        )
        .route(
            "/db/flow/remove_stream",
            post(crate::flow_sidecar_routes::remove_stream),
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
        last_validated_ok: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
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
    let (listener, port) = bind_loopback().await.unwrap_or_else(|msg| panic!("{msg}"));
    let url = format!("http://127.0.0.1:{port}");
    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    let route_state = Arc::new(RouteState {
        pool,
        mutation_buffer,
        emit,
        last_validated_ok: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    });
    let router = build_router(token.clone(), route_state);

    tauri::async_runtime::spawn(async move {
        let serve =
            axum::serve(listener, router.into_make_service()).with_graceful_shutdown(async move {
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
    use sqlx::Row;
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
        assert!(
            exposed
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
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
        let formatted = format!("{t:?}");
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
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri("/healthz")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        });
    }

    #[test]
    fn router_rejects_wrong_bearer_with_401() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, _token) = build_test_router_with_pool(pool, buf).await;
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri("/healthz")
                        .header("Authorization", "Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxx")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        });
    }

    #[test]
    fn router_accepts_correct_bearer_and_returns_200_on_healthz() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri("/healthz")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
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
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/describe_templates")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 16_384).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["templateCount"], 2);
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
                "templateId": "hop-linear",
                "params": { "switchCount": 2, "dataRateMbps": 1000 }
            })
            .to_string();
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/initialize")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);

            let bytes = to_bytes(resp.into_body(), 16_384).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["mutationId"], 1);
            assert_eq!(parsed["summary"]["persisted"], true);
            assert_eq!(parsed["summary"]["sessionId"], "s1");
            // 不再返回 full topology（agent 用 inspect 查询切片）。
            assert!(parsed.get("full").is_none());

            // 2 交换机 + 2 端系统（两端）= 4 节点；1 条骨干 + 2 条接入 = 3 链路。
            let node_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let link_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(node_count, 4);
            assert_eq!(link_count, 3);

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
                serde_json::json!({ "switchCount": 4, "dataRateMbps": 1000 }),
                serde_json::json!({ "switchCount": 2, "dataRateMbps": 1000 }),
            ] {
                let body = serde_json::json!({
                    "sessionId": "s1",
                    "templateId": "hop-linear",
                    "params": params,
                })
                .to_string();
                let resp = router
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri("/db/topology/initialize")
                            .header("Authorization", format!("Bearer {}", token.expose()))
                            .header("Content-Type", "application/json")
                            .body(Body::from(body))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(resp.status(), StatusCode::OK);
            }

            // 第二次 initialize 整表重建为 hop-linear(2)。
            let node_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(node_count, 4);
            assert_eq!(buf.since("s1", 0).latest, 2);
        });
    }

    #[test]
    fn apply_operations_rejects_oversized_batch() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;

            let operations: Vec<serde_json::Value> = (0..33)
                .map(|i| {
                    serde_json::json!({
                        "op": "node_add", "mid": i.to_string(),
                        "x": 0.0, "y": 0.0, "insertOrder": i
                    })
                })
                .collect();
            let body =
                serde_json::json!({ "sessionId": "s1", "operations": operations }).to_string();
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/apply_operations")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
            let bytes = to_bytes(resp.into_body(), 8192).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], false);
            assert_eq!(parsed["code"], "LIMIT_EXCEEDED");
            assert_eq!(parsed["retryable"], false);
        });
    }

    #[test]
    fn apply_operations_rejects_empty_batch() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf.clone()).await;

            let (status, parsed) = apply_ops(router, &token, "s1", serde_json::json!([])).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(parsed["code"], "LIMIT_EXCEEDED");
            // 空批次不得 mint mutationId（幽灵 mutation 防护）。
            assert_eq!(buf.since("s1", 0).latest, 0);
        });
    }

    #[test]
    fn apply_operations_rejects_syntactically_invalid_json_with_envelope() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;

            // 语法级非法 JSON（extractor rejection 路径，区别于形状级 serde 失败）。
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/apply_operations")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from("{not valid json"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
            let bytes = to_bytes(resp.into_body(), 8192).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], false);
            assert_eq!(parsed["code"], "INVALID_OPERATION");
            assert!(parsed["message"].as_str().unwrap().contains("node_add"));
        });
    }

    #[test]
    fn apply_operations_rejects_malformed_op_with_invalid_operation_envelope() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;

            // 轮 3 真机错误输入：模型发明的 {"kind":"insert-switch"}。
            let body = serde_json::json!({
                "sessionId": "s1",
                "operations": [{ "kind": "insert-switch" }]
            })
            .to_string();
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/apply_operations")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
            let bytes = to_bytes(resp.into_body(), 8192).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], false);
            assert_eq!(parsed["code"], "INVALID_OPERATION");
            assert_eq!(parsed["retryable"], false);
            // 不再是裸 "Unprocessable Entity"：message 列出合法 op。
            let message = parsed["message"].as_str().unwrap();
            assert!(message.contains("node_add"), "message={message}");
            assert!(message.contains("link_delete"), "message={message}");
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
                    { "op": "node_add", "mid": "0", "x": 0.0, "y": 0.0, "insertOrder": 0 }
                ],
                "dryRun": false
            })
            .to_string();
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/apply_operations")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);

            let bytes = to_bytes(resp.into_body(), 8192).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["mutationId"], 1);

            // 验证行真的写到 db
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
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
                    { "op": "node_add", "mid": "0", "x": 0.0, "y": 0.0, "insertOrder": 0 }
                ],
                "dryRun": true
            })
            .to_string();
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/apply_operations")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 8192).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["summary"]["dryRun"], true);
            assert!(parsed["summary"]["mutationId"].is_null());

            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id='s1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
            assert_eq!(buf.since("s1", 0).mutations.len(), 0);
        });
    }

    /// 读该 session 的 undo pre-image blob（无则 None）。U3 写前快照断言用。
    async fn read_pre_image(pool: &sqlx::Pool<sqlx::Sqlite>, session_id: &str) -> Option<String> {
        sqlx::query_scalar(
            "SELECT blob_json FROM topology_undo_snapshots WHERE session_id = ? AND domain = 'topology'",
        )
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .unwrap()
    }

    /// 两表全图快照（节点/链路），用于断言 pre-image == 写前态。
    async fn dump_topology_tables(
        pool: &sqlx::Pool<sqlx::Sqlite>,
        session_id: &str,
    ) -> (Vec<(String, f64, f64)>, Vec<(i64, String, String)>) {
        let nodes = sqlx::query(
            "SELECT mid, x, y FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, mid",
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| {
            (
                r.get::<String, _>("mid"),
                r.get::<f64, _>("x"),
                r.get::<f64, _>("y"),
            )
        })
        .collect();
        let links = sqlx::query(
            "SELECT link_seq, src_node, dst_node FROM topology_links WHERE session_id = ? ORDER BY link_seq",
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| {
            (
                r.get::<i64, _>("link_seq"),
                r.get::<String, _>("src_node"),
                r.get::<String, _>("dst_node"),
            )
        })
        .collect();
        (nodes, links)
    }

    /// U3: 非 dry-run apply_operations 后，留下一份 pre-image，
    /// 内容等于 apply 前的三表态。
    #[test]
    fn apply_operations_leaves_pre_image_equal_to_pre_apply_state() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            // 写前态：一节点。
            sqlx::query("INSERT INTO topology_nodes (session_id, mid, x, y, node_type, insert_order) VALUES ('s1','0',1.0,2.0,'switch',0)")
                .execute(&pool).await.unwrap();
            let before = dump_topology_tables(&pool, "s1").await;

            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;
            let (status, parsed) = apply_ops(
                router,
                &token,
                "s1",
                serde_json::json!([
                    { "op": "node_add", "mid": "1", "x": 9.0, "y": 9.0, "insertOrder": 1 }
                ]),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);

            // pre-image 存在，且其序列化的三表态 == apply 前态。
            let blob = read_pre_image(&pool, "s1")
                .await
                .expect("非 dry-run 后留 pre-image");
            let pre: serde_json::Value = serde_json::from_str(&blob).unwrap();
            let pre_nodes: Vec<(String, f64, f64)> = pre["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| {
                    (
                        n["mid"].as_str().unwrap().to_string(),
                        n["x"].as_f64().unwrap(),
                        n["y"].as_f64().unwrap(),
                    )
                })
                .collect();
            assert_eq!(pre_nodes, before.0, "pre-image 节点 == 写前节点（含 x/y）");
            assert!(pre["links"].as_array().unwrap().is_empty());
        });
    }

    /// U3 关键（R4）：dry-run apply_operations（rollback）后不留 pre-image。
    #[test]
    fn apply_operations_dry_run_leaves_no_pre_image() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            let body = serde_json::json!({
                "sessionId": "s1",
                "operations": [
                    { "op": "node_add", "mid": "0", "x": 0.0, "y": 0.0, "insertOrder": 0 }
                ],
                "dryRun": true
            })
            .to_string();
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/apply_operations")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);

            // dry-run 的快照随事务 rollback 一并丢弃。
            assert!(
                read_pre_image(&pool, "s1").await.is_none(),
                "dry-run rollback 后不得留 pre-image（R4）"
            );
        });
    }

    /// U3: 一次结构变更只产生一份 pre-image（覆盖，不累积）。
    #[test]
    fn apply_operations_pre_image_is_overwrite_not_accumulate() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            apply_ops(
                router.clone(),
                &token,
                "s1",
                serde_json::json!([{ "op": "node_add", "mid": "0", "x": 0.0, "y": 0.0, "insertOrder": 0 }]),
            )
            .await;
            apply_ops(
                router,
                &token,
                "s1",
                serde_json::json!([{ "op": "node_add", "mid": "1", "x": 0.0, "y": 0.0, "insertOrder": 1 }]),
            )
            .await;

            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_undo_snapshots WHERE session_id = 's1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 1, "(session_id, domain) 主键只留一份 pre-image");

            // 第二份覆盖第一份：pre-image 含第一次 apply 落下的节点 0。
            let blob = read_pre_image(&pool, "s1").await.unwrap();
            let pre: serde_json::Value = serde_json::from_str(&blob).unwrap();
            let syncs: Vec<String> = pre["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n["mid"].as_str().unwrap().to_string())
                .collect();
            assert_eq!(
                syncs,
                vec!["0".to_string()],
                "pre-image == 第二次 apply 前态"
            );
        });
    }

    /// U3: initialize 后 pre-image == initialize 前整图态。
    #[test]
    fn initialize_leaves_pre_image_equal_to_pre_initialize_state() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            // 先 initialize 一次建出整图（switchCount=4）。
            initialize_hop_linear(router.clone(), &token, "s1", 4).await;
            let before = dump_topology_tables(&pool, "s1").await;
            assert!(!before.0.is_empty(), "首次 initialize 应已建出节点");

            // 第二次 initialize：pre-image 应等于第一次的整图态。
            initialize_hop_linear(router, &token, "s1", 2).await;

            let blob = read_pre_image(&pool, "s1")
                .await
                .expect("initialize 后留 pre-image");
            let pre: serde_json::Value = serde_json::from_str(&blob).unwrap();
            let pre_nodes: Vec<(String, f64, f64)> = pre["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| {
                    (
                        n["mid"].as_str().unwrap().to_string(),
                        n["x"].as_f64().unwrap(),
                        n["y"].as_f64().unwrap(),
                    )
                })
                .collect();
            let pre_links: Vec<(i64, String, String)> = pre["links"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| {
                    (
                        l["link_seq"].as_i64().unwrap(),
                        l["src_node"].as_str().unwrap().to_string(),
                        l["dst_node"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            assert_eq!(
                pre_nodes, before.0,
                "pre-image 节点 == initialize 前整图节点"
            );
            assert_eq!(
                pre_links, before.1,
                "pre-image 链路 == initialize 前整图链路"
            );
        });
    }

    /// U3: 首次 initialize（之前空）后 pre-image 为空三表。
    #[test]
    fn first_initialize_leaves_empty_tables_pre_image() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf).await;

            initialize_hop_linear(router, &token, "s1", 2).await;

            let blob = read_pre_image(&pool, "s1")
                .await
                .expect("首次 initialize 也留 pre-image");
            let pre: serde_json::Value = serde_json::from_str(&blob).unwrap();
            assert!(
                pre["nodes"].as_array().unwrap().is_empty(),
                "首次 initialize pre-image 节点为空"
            );
            assert!(
                pre["links"].as_array().unwrap().is_empty(),
                "首次 initialize pre-image 链路为空"
            );
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
            })
            .to_string();
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/apply_operations")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
        });
    }

    /// inspect 路由的 oneshot helper：POST {sessionId} 并解析响应体。
    /// 全量 rows 响应体超过既有 4096 惯用上限，统一用 65536（U1/U6 共用）。
    async fn inspect_session(
        router: axum::Router,
        token: &SecretToken,
        session_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        let body = serde_json::json!({ "sessionId": session_id }).to_string();
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/db/topology/inspect")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 65_536).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn inspect_returns_full_rows_for_session() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            // 故意乱序插入，断言响应按 insert_order / link_seq 排序。
            sqlx::query(r#"INSERT INTO topology_nodes (session_id, mid, x, y, node_type, insert_order) VALUES
                ('s1', '2', 200.0, 80.0, 'endSystem', 2),
                ('s1', '0', 0.0, 0.0, 'switch', 0),
                ('s1', '1', 100.0, 0.0, 'switch', 1)"#)
                .execute(&pool).await.unwrap();
            sqlx::query(r#"INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, styles_json) VALUES
                ('s1', 1, 'l-acc', '1', '2', '{"leftLabel":"P2","rightLabel":"P1","speed":100}'),
                ('s1', 0, 'l-bb', '0', '1', '{"leftLabel":"P1","rightLabel":"P1","speed":1000}')"#)
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;

            let (status, parsed) = inspect_session(router, &token, "s1").await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            let summary = &parsed["summary"];
            assert_eq!(summary["sessionId"], "s1");
            assert_eq!(summary["nodeCount"], 3);
            assert_eq!(summary["linkCount"], 2);

            // nodes 按 insert_order 排序，字段 camelCase。
            let nodes = summary["nodes"].as_array().unwrap();
            assert_eq!(nodes.len(), 3);
            assert_eq!(nodes[0]["mid"], "0");
            assert_eq!(nodes[0]["nodeType"], "switch");
            assert_eq!(nodes[0]["x"], 0.0);
            assert_eq!(nodes[0]["insertOrder"], 0);
            assert_eq!(nodes[2]["mid"], "2");
            assert_eq!(nodes[2]["nodeType"], "endSystem");

            // links 按 link_seq 排序，stylesJson 原文。
            let links = summary["links"].as_array().unwrap();
            assert_eq!(links.len(), 2);
            assert_eq!(links[0]["linkSeq"], 0);
            assert_eq!(links[0]["name"], "l-bb");
            assert_eq!(links[0]["srcNode"], "0");
            assert_eq!(links[0]["dstNode"], "1");
            assert_eq!(
                links[0]["stylesJson"],
                r#"{"leftLabel":"P1","rightLabel":"P1","speed":1000}"#
            );
            assert_eq!(links[1]["linkSeq"], 1);
        });
    }

    #[test]
    fn inspect_returns_empty_arrays_for_empty_topology() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;

            let (status, parsed) = inspect_session(router, &token, "s1").await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["summary"]["nodeCount"], 0);
            assert_eq!(parsed["summary"]["nodes"].as_array().unwrap().len(), 0);
            assert_eq!(parsed["summary"]["links"].as_array().unwrap().len(), 0);
        });
    }

    #[test]
    fn inspect_rejects_unknown_session() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            let (router, token) = build_test_router_with_pool(pool, buf).await;

            let (status, parsed) = inspect_session(router, &token, "ghost").await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(parsed["ok"], false);
            assert_eq!(parsed["code"], "FORBIDDEN_OPERATION");
        });
    }

    /// apply_operations 路由的 oneshot helper。
    async fn apply_ops(
        router: axum::Router,
        token: &SecretToken,
        session_id: &str,
        operations: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let body =
            serde_json::json!({ "sessionId": session_id, "operations": operations }).to_string();
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/db/topology/apply_operations")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 65_536).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    /// undo 路由的 oneshot helper：POST {sessionId} 并解析响应体。
    async fn undo_session(
        router: axum::Router,
        token: &SecretToken,
        session_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        let body = serde_json::json!({ "sessionId": session_id }).to_string();
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/db/topology/undo")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 65_536).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    /// U4: 有 pre-image 时 undo 盖回三表 + push 一条 mutation；响应 undone=true，
    /// 且盖回后 inspect 返回的拓扑 == 撤销前快照态。
    #[test]
    fn undo_restores_topology_and_pushes_mutation_when_pre_image_present() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool.clone(), buf.clone()).await;

            // 写前态：apply 一笔结构变更，留 pre-image（节点 0）。
            apply_ops(
                router.clone(),
                &token,
                "s1",
                serde_json::json!([
                    { "op": "node_add", "mid": "0", "x": 1.0, "y": 2.0, "insertOrder": 0 }
                ]),
            )
            .await;
            let before = dump_topology_tables(&pool, "s1").await;
            assert_eq!(before.0.len(), 1, "撤销前应有一个节点");

            // 第二笔结构变更：再加一个节点（覆盖式 pre-image = 第一笔后的态）。
            apply_ops(
                router.clone(),
                &token,
                "s1",
                serde_json::json!([
                    { "op": "node_add", "mid": "1", "x": 3.0, "y": 4.0, "insertOrder": 1 }
                ]),
            )
            .await;
            let snapshot_state = dump_topology_tables(&pool, "s1").await;
            assert_eq!(snapshot_state.0.len(), 2, "第二笔后应有两个节点");
            // 第二笔 apply = mutationId 2；undo 应推到 3。
            assert_eq!(buf.since("s1", 0).latest, 2);

            let (status, parsed) = undo_session(router.clone(), &token, "s1").await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["undone"], true);
            assert_eq!(parsed["summary"]["mutationId"], 3);

            // undo push 了一条 mutation。
            assert_eq!(buf.since("s1", 0).latest, 3);

            // 盖回后三表 == 第二笔 apply 前态（即 before：节点 0）。
            let after = dump_topology_tables(&pool, "s1").await;
            assert_eq!(after, before, "undo 盖回到第二笔结构变更前的态");

            // inspect 也反映回退态（一个节点）。
            let (_, inspected) = inspect_session(router, &token, "s1").await;
            assert_eq!(inspected["summary"]["nodeCount"], 1);
        });
    }

    /// U4: 无 pre-image 时 undo 返回 undone=false，且不 push mutation。
    #[test]
    fn undo_returns_undone_false_and_does_not_push_when_no_pre_image() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf.clone()).await;

            let (status, parsed) = undo_session(router, &token, "s1").await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            assert_eq!(parsed["undone"], false);
            // 不 push mutation。
            assert_eq!(buf.since("s1", 0).latest, 0);
        });
    }

    /// U4 (R11): 撤销后 pre-image 已清除，再次 undo 返回 undone=false、不 push。
    #[test]
    fn second_undo_returns_undone_false() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf.clone()).await;

            apply_ops(
                router.clone(),
                &token,
                "s1",
                serde_json::json!([
                    { "op": "node_add", "mid": "0", "x": 0.0, "y": 0.0, "insertOrder": 0 }
                ]),
            )
            .await;

            let (_, first) = undo_session(router.clone(), &token, "s1").await;
            assert_eq!(first["undone"], true);
            let after_first = buf.since("s1", 0).latest;

            let (_, second) = undo_session(router, &token, "s1").await;
            assert_eq!(second["undone"], false, "撤销后无可再撤（R11）");
            // 第二次不 push。
            assert_eq!(buf.since("s1", 0).latest, after_first);
        });
    }

    /// initialize 路由的 oneshot helper（hop-linear，switchCount 跳）。
    async fn initialize_hop_linear(
        router: axum::Router,
        token: &SecretToken,
        session_id: &str,
        switch_count: i64,
    ) {
        let body = serde_json::json!({
            "sessionId": session_id,
            "templateId": "hop-linear",
            "params": { "switchCount": switch_count, "dataRateMbps": 1000 }
        })
        .to_string();
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/db/topology/initialize")
                    .header("Authorization", format!("Bearer {}", token.expose()))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    /// 模拟模型读 inspect rows：定位第一条骨干链路（两端皆 switch）与建新行参照。
    /// 返回 (backbone_seq, sw1_mid, sw2_mid, styles_json,
    ///        next_mid, next_link_seq, next_insert_order)。
    fn locate_insert_site(
        summary: &serde_json::Value,
    ) -> (i64, String, String, String, String, i64, i64) {
        let nodes = summary["nodes"].as_array().unwrap();
        let links = summary["links"].as_array().unwrap();
        let switch_syncs: std::collections::HashSet<String> = nodes
            .iter()
            .filter(|n| n["nodeType"] == "switch")
            .map(|n| n["mid"].as_str().unwrap().to_string())
            .collect();
        let backbone = links
            .iter()
            .find(|l| {
                switch_syncs.contains(l["srcNode"].as_str().unwrap())
                    && switch_syncs.contains(l["dstNode"].as_str().unwrap())
            })
            .expect("hop-linear must have a switch-switch backbone link");
        let next_sync = nodes
            .iter()
            .map(|n| n["mid"].as_str().unwrap().parse::<i64>().unwrap())
            .max()
            .unwrap()
            + 1;
        (
            backbone["linkSeq"].as_i64().unwrap(),
            backbone["srcNode"].as_str().unwrap().to_string(),
            backbone["dstNode"].as_str().unwrap().to_string(),
            backbone["stylesJson"].as_str().unwrap().to_string(),
            next_sync.to_string(),
            links
                .iter()
                .map(|l| l["linkSeq"].as_i64().unwrap())
                .max()
                .unwrap()
                + 1,
            nodes
                .iter()
                .map(|n| n["insertOrder"].as_i64().unwrap())
                .max()
                .unwrap()
                + 1,
        )
    }

    /// 轮 3 真机失败场景的回归（plan 2026-06-05-001 U6）：「SW-1/SW-2 之间插一台
    /// 交换机」经 inspect → 构造原子 ops → apply 全程可走通，且原节点身份保持
    /// 不变 —— 这正是轮 5 退化为 initialize 整表重建时破坏的性质。
    /// 边界声明：本测试证明机制（apply 路径保持节点身份）；「agent 实际选择
    /// apply 而非 initialize」由 U5 prompt 规则 + ship 后真机重放覆盖。
    #[test]
    fn insert_switch_via_inspect_then_apply_round_trip() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;

            // initialize hop-linear(4) → 6 节点 5 链路（mutationId=1）。
            initialize_hop_linear(router.clone(), &token, "s1", 4).await;

            // inspect 全量 → 程序化定位 sw1-sw2 骨干与新行参照（模拟模型行为）。
            let (status, parsed) = inspect_session(router.clone(), &token, "s1").await;
            assert_eq!(status, StatusCode::OK);
            let before = parsed["summary"].clone();
            assert_eq!(before["nodeCount"], 6);
            assert_eq!(before["linkCount"], 5);
            let original_identity: Vec<String> = before["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n["mid"].as_str().unwrap().to_string())
                .collect();

            let (backbone_seq, sw1, sw2, styles, new_sync, new_seq, new_order) =
                locate_insert_site(&before);

            // 构造 [link_delete, node_add, link_add×2]（stylesJson 复制原文）。
            let batch = serde_json::json!([
                { "op": "link_delete", "linkSeq": backbone_seq },
                { "op": "node_add", "mid": new_sync,
                  "x": 150.0, "y": 40.0, "nodeType": "switch",
                  "insertOrder": new_order },
                { "op": "link_add", "linkSeq": new_seq, "srcNode": sw1, "dstNode": new_sync,
                  "srcPort": 9, "dstPort": 0, "stylesJson": styles },
                { "op": "link_add", "linkSeq": new_seq + 1, "srcNode": new_sync, "dstNode": sw2,
                  "srcPort": 1, "dstPort": 9, "stylesJson": styles },
            ]);
            let (status, parsed) = apply_ops(router.clone(), &token, "s1", batch).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);
            // mutationId 递增：initialize=1 → apply=2。
            assert_eq!(parsed["summary"]["mutationId"], 2);

            // 再次 inspect：7 节点 6 链路，新交换机与两条新链路在 rows 中。
            let (_, parsed) = inspect_session(router.clone(), &token, "s1").await;
            let after = &parsed["summary"];
            assert_eq!(after["nodeCount"], 7);
            assert_eq!(after["linkCount"], 6);
            let after_nodes = after["nodes"].as_array().unwrap();
            assert!(
                after_nodes
                    .iter()
                    .any(|n| n["mid"].as_str() == Some(new_sync.as_str()))
            );
            let after_links = after["links"].as_array().unwrap();
            assert!(
                after_links
                    .iter()
                    .any(|l| l["linkSeq"].as_i64() == Some(new_seq))
            );
            assert!(
                after_links
                    .iter()
                    .any(|l| l["linkSeq"].as_i64() == Some(new_seq + 1))
            );
            assert!(
                !after_links
                    .iter()
                    .any(|l| l["linkSeq"].as_i64() == Some(backbone_seq))
            );

            // 原有 6 节点的 mid 逐一保持不变（轮 5 整表重建破坏的性质）。
            for mid in &original_identity {
                let preserved = after_nodes.iter().any(|n| n["mid"].as_str() == Some(mid));
                assert!(preserved, "node mid={mid} lost identity");
            }

            // Error path：已占用 mid + 异值 → MID_TAKEN，message 含 node_update
            // 指引，原节点不变（三态防护在路由层可见）。
            let collision = serde_json::json!([
                { "op": "node_add", "mid": sw1, "x": 9.0, "y": 9.0,
                  "nodeType": "switch", "insertOrder": 99 },
            ]);
            let (status, parsed) = apply_ops(router.clone(), &token, "s1", collision).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(parsed["code"], "MID_TAKEN");
            assert!(parsed["message"].as_str().unwrap().contains("node_update"));
            let (_, parsed) = inspect_session(router, &token, "s1").await;
            let sw1_row = parsed["summary"]["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["mid"].as_str() == Some(sw1.as_str()))
                .unwrap()
                .clone();
            assert_ne!(sw1_row["x"], 9.0, "碰撞不得覆盖原节点坐标");
        });
    }

    /// Known-boundary 负向测试（plan 2026-06-05-001 U6 / KTD 三态边界）：三态
    /// 写入只防同 key 碰撞 —— 重放 insert-switch batch 时若 link_add 重新分配
    /// linkSeq（全新主键），整批成功并产生平行链路。数据库视角这是合法形态
    /// （TSN dual-plane 同端点对平行链路合法，不能全局拦截）；此即 U5 prompt
    /// 规则 8「重试必须逐字节复用上一次的同一 batch」存在的原因。
    #[test]
    fn replayed_batch_with_fresh_link_seqs_creates_parallel_links() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;

            initialize_hop_linear(router.clone(), &token, "s1", 2).await;
            let (_, parsed) = inspect_session(router.clone(), &token, "s1").await;
            let (backbone_seq, sw1, sw2, styles, new_sync, new_seq, new_order) =
                locate_insert_site(&parsed["summary"]);

            let batch_with_seqs = |seq_a: i64, seq_b: i64| {
                serde_json::json!([
                    { "op": "link_delete", "linkSeq": backbone_seq },
                    { "op": "node_add", "mid": new_sync,
                      "x": 150.0, "y": 40.0, "nodeType": "switch",
                      "insertOrder": new_order },
                    { "op": "link_add", "linkSeq": seq_a, "srcNode": sw1, "dstNode": new_sync,
                      "srcPort": 9, "dstPort": 0, "stylesJson": styles },
                    { "op": "link_add", "linkSeq": seq_b, "srcNode": new_sync, "dstNode": sw2,
                      "srcPort": 1, "dstPort": 9, "stylesJson": styles },
                ])
            };

            let (status, _) = apply_ops(
                router.clone(),
                &token,
                "s1",
                batch_with_seqs(new_seq, new_seq + 1),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let (_, parsed) = inspect_session(router.clone(), &token, "s1").await;
            let link_count_first = parsed["summary"]["linkCount"].as_i64().unwrap();

            // 「重试」时重新分配 linkSeq：node_add 同值 no-op，link_delete no-op，
            // 两条 link_add 是全新 key → 静默成功，平行链路 +2。
            let (status, parsed) = apply_ops(
                router.clone(),
                &token,
                "s1",
                batch_with_seqs(new_seq + 2, new_seq + 3),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(parsed["ok"], true);

            let (_, parsed) = inspect_session(router, &token, "s1").await;
            assert_eq!(
                parsed["summary"]["linkCount"].as_i64().unwrap(),
                link_count_first + 2
            );
        });
    }

    #[test]
    fn validate_detects_dangling_link_references() {
        tauri::async_runtime::block_on(async {
            let (pool, buf) = test_state().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','now','now','{}')")
                .execute(&pool).await.unwrap();
            // Insert link pointing at non-existent nodes
            sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_node, dst_node, styles_json) VALUES ('s1', 0, '99', '100', '{}')")
                .execute(&pool).await.unwrap();
            let (router, token) = build_test_router_with_pool(pool, buf).await;
            let body = serde_json::json!({ "sessionId": "s1" }).to_string();
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/validate")
                        .header("Authorization", format!("Bearer {}", token.expose()))
                        .header("Content-Type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(parsed["ok"], false);
            assert!(!parsed["summary"]["errors"].as_array().unwrap().is_empty());
        });
    }
}
