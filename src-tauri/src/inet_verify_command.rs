//! 第二批 U3：`verify_inet` 编排命令——读库 → U1 序列化 → U2 远端跑 → 判定 → `VerifyResult`。
//!
//! **当前未接前端**：INET 验证已从拓扑阶段撤出、挪到后续流量规划阶段（见 plan 2026-06-17-003 范围调整）。
//! 本命令连同 `inet_bundle`/`inet_remote` 作为流量规划阶段的现成基础保留，暂无 UI/agent 触发——勿当死代码删。
//! 复审触发：若未随流量规划 Phase B 启用，2026-09 重审这三个模块（verify_command/bundle/remote）是否归档至 `docs/deferred/`。
//!
//! 判定区分两类不过关（错误码不同，供 U4/U5 分文案）：
//! - 远端不可达/超时/SSH 失败 → `inet_unreachable`（环境问题，「校验暂时无法运行」）。
//! - inet 退出码非 0（NED/INI 真跑不起来）→ `inet_load_failed`（「拓扑跑不起来」+ 输出尾部）。
//! - 类型映射不出 → U1 的 `unmappable_node_type`（发 INET 前就报，AE8）。
//!
//! 编排逻辑 `run_inet_verification` 收 `&dyn RemoteRunner` 便于单测注入 mock；命令传 `SshRunner`。

use sqlx::Row;

use crate::inet_bundle::build_inet_bundle;
use crate::inet_remote::{RemoteConfig, RemoteError, RemoteRunner, SshRunner};
use crate::session_store::SessionStore;
use crate::topology_verify::{
    CALIBER_LOADABILITY_ONLY, VerifyError, VerifyLink, VerifyNode, VerifyResult,
};

/// 纯编排：序列化 → 远端跑 → 判定。不读库、不碰 Tauri，便于注入 runner 单测。
pub fn run_inet_verification(
    nodes: &[VerifyNode],
    links: &[VerifyLink],
    session_id: &str,
    source_mutation_id: i64,
    runner: &dyn RemoteRunner,
    cfg: &RemoteConfig,
) -> VerifyResult {
    let bundle = match build_inet_bundle(nodes, links, session_id, source_mutation_id) {
        Ok(b) => b,
        // 类型映射不出 → 发 INET 前就报，runner 不被调用（AE8）。
        Err(errors) => {
            return VerifyResult {
                ok: false,
                caliber: CALIBER_LOADABILITY_ONLY,
                errors,
            };
        }
    };

    match runner.run_bundle(&bundle, cfg) {
        Err(RemoteError::Unreachable(msg)) => VerifyResult {
            ok: false,
            caliber: CALIBER_LOADABILITY_ONLY,
            errors: vec![VerifyError {
                code: "inet_unreachable".to_string(),
                message_zh: format!(
                    "校验暂时无法运行：连不上远端 INET，右侧工程保持原状态，未推进。（{msg}）"
                ),
                node_ref: None,
            }],
        },
        Ok(outcome) => match outcome.exit_code {
            Some(0) => VerifyResult {
                ok: true,
                caliber: CALIBER_LOADABILITY_ONLY,
                errors: vec![],
            },
            // 拿不到退出码（进程被杀等）→ 当环境问题，不诬陷拓扑（SshRunner 通常已把 255/None 归不可达）。
            None => VerifyResult {
                ok: false,
                caliber: CALIBER_LOADABILITY_ONLY,
                errors: vec![VerifyError {
                    code: "inet_unreachable".to_string(),
                    message_zh:
                        "校验暂时无法运行：远端 INET 未返回退出码，右侧工程保持原状态，未推进。"
                            .to_string(),
                    node_ref: None,
                }],
            },
            Some(code) => VerifyResult {
                ok: false,
                caliber: CALIBER_LOADABILITY_ONLY,
                errors: vec![VerifyError {
                    code: "inet_load_failed".to_string(),
                    message_zh: format!(
                        "拓扑在 INET 上跑不起来（退出码 {code}）。{}",
                        outcome.output_tail
                    ),
                    node_ref: None,
                }],
            },
        },
    }
}

async fn load_topology_rows(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<(Vec<VerifyNode>, Vec<VerifyLink>), String> {
    let node_rows = sqlx::query(
        "SELECT sync_name, name, node_type FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, sync_name",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询节点失败：{e}"))?;
    let link_rows = sqlx::query(
        "SELECT link_seq, src_sync_name, dst_sync_name, styles_json FROM topology_links WHERE session_id = ? ORDER BY link_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询链路失败：{e}"))?;

    let nodes = node_rows
        .into_iter()
        .map(|r| VerifyNode {
            sync_name: r.get("sync_name"),
            name: r.get("name"),
            node_type: r.get("node_type"),
        })
        .collect();
    let links = link_rows
        .into_iter()
        .map(|r| VerifyLink {
            link_seq: r.get("link_seq"),
            src_sync_name: r.get("src_sync_name"),
            dst_sync_name: r.get("dst_sync_name"),
            styles_json: r.get("styles_json"),
        })
        .collect();
    Ok((nodes, links))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyInetRequest {
    session_id: String,
}

/// 串行过关闸第二道：读库内拓扑序列化成 inet-bundle、发远端 INET 跑加载冒烟，返回 VerifyResult。
/// 阶段无关入参（只 sessionId）；本期固定远端主机（RemoteConfig::dev_default）。
#[tauri::command]
pub async fn verify_inet(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: VerifyInetRequest,
) -> Result<VerifyResult, String> {
    let pool = store.pool(&app).await?;
    let (nodes, links) = load_topology_rows(pool, &request.session_id).await?;
    let cfg = RemoteConfig::dev_default();
    // TODO（执行期）：sourceMutationId 接库内当前 mutationId；本期占位 0（不影响加载冒烟）。
    Ok(run_inet_verification(
        &nodes,
        &links,
        &request.session_id,
        0,
        &SshRunner,
        &cfg,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inet_bundle::InetBundle;
    use crate::inet_remote::RemoteRunOutcome;
    use std::cell::Cell;
    use std::time::Duration;

    fn node(sync: &str, ty: &str) -> VerifyNode {
        VerifyNode {
            sync_name: sync.into(),
            name: None,
            node_type: Some(ty.into()),
        }
    }
    fn link(seq: i64, src: &str, dst: &str) -> VerifyLink {
        VerifyLink {
            link_seq: seq,
            src_sync_name: src.into(),
            dst_sync_name: dst.into(),
            styles_json: r#"{"speed":1000}"#.into(),
        }
    }
    fn cfg() -> RemoteConfig {
        RemoteConfig {
            host: "h".into(),
            user: "u".into(),
            remote_base_dir: "/b".into(),
            inet_path: "/i".into(),
            timeout: Duration::from_secs(1),
        }
    }

    /// runner 桩：记调用次数 + 返回预设结果。
    struct StubRunner {
        calls: Cell<u32>,
        outcome: Result<RemoteRunOutcome, RemoteError>,
    }
    impl StubRunner {
        fn ok(exit: i32) -> Self {
            Self {
                calls: Cell::new(0),
                outcome: Ok(RemoteRunOutcome {
                    exit_code: Some(exit),
                    output_tail: "tail".into(),
                }),
            }
        }
        fn unreachable() -> Self {
            Self {
                calls: Cell::new(0),
                outcome: Err(RemoteError::Unreachable("connect timeout".into())),
            }
        }
        fn no_exit_code() -> Self {
            Self {
                calls: Cell::new(0),
                outcome: Ok(RemoteRunOutcome {
                    exit_code: None,
                    output_tail: "".into(),
                }),
            }
        }
    }
    impl RemoteRunner for StubRunner {
        fn run_bundle(
            &self,
            _b: &InetBundle,
            _c: &RemoteConfig,
        ) -> Result<RemoteRunOutcome, RemoteError> {
            self.calls.set(self.calls.get() + 1);
            match &self.outcome {
                Ok(o) => Ok(o.clone()),
                Err(RemoteError::Unreachable(m)) => Err(RemoteError::Unreachable(m.clone())),
            }
        }
    }

    #[test]
    fn unmappable_type_blocks_before_remote_call() {
        let nodes = vec![
            node("0", "switch"),
            VerifyNode {
                sync_name: "1".into(),
                name: None,
                node_type: None,
            },
        ];
        let links = vec![link(0, "0", "1")];
        let runner = StubRunner::ok(0);
        let r = run_inet_verification(&nodes, &links, "s", 0, &runner, &cfg());
        assert!(!r.ok);
        assert!(r.errors.iter().any(|e| e.code == "unmappable_node_type"));
        assert_eq!(runner.calls.get(), 0, "类型映射失败不应发起远端调用");
    }

    #[test]
    fn exit_zero_passes_loadability() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let links = vec![link(0, "0", "1")];
        let runner = StubRunner::ok(0);
        let r = run_inet_verification(&nodes, &links, "s", 0, &runner, &cfg());
        assert!(r.ok);
        assert_eq!(r.caliber, "loadability_only");
        assert!(r.errors.is_empty());
        assert_eq!(runner.calls.get(), 1);
    }

    #[test]
    fn nonzero_exit_is_load_failed() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let links = vec![link(0, "0", "1")];
        let runner = StubRunner::ok(1);
        let r = run_inet_verification(&nodes, &links, "s", 0, &runner, &cfg());
        assert!(!r.ok);
        assert_eq!(r.caliber, "loadability_only");
        assert!(r.errors.iter().any(|e| e.code == "inet_load_failed"));
    }

    #[test]
    fn unreachable_is_distinct_code() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let links = vec![link(0, "0", "1")];
        let runner = StubRunner::unreachable();
        let r = run_inet_verification(&nodes, &links, "s", 0, &runner, &cfg());
        assert!(!r.ok);
        assert!(r.errors.iter().any(|e| e.code == "inet_unreachable"));
        // 不可达文案不说拓扑错。
        assert!(r.errors[0].message_zh.contains("校验暂时无法运行"));
    }

    #[test]
    fn missing_exit_code_is_unreachable_not_load_failed() {
        let nodes = vec![node("0", "switch"), node("1", "endSystem")];
        let links = vec![link(0, "0", "1")];
        let runner = StubRunner::no_exit_code();
        let r = run_inet_verification(&nodes, &links, "s", 0, &runner, &cfg());
        assert!(!r.ok);
        // 拿不到退出码当环境问题，不诬陷拓扑。
        assert!(r.errors.iter().any(|e| e.code == "inet_unreachable"));
        assert!(!r.errors.iter().any(|e| e.code == "inet_load_failed"));
    }

    /// 真机验收（默认 #[ignore]：需本机到远端 INET 免密 + 网络）。用我们代码生成的 bundle
    /// 真连远端 INET（RemoteConfig::dev_default）跑加载冒烟，断言合法拓扑 EXIT=0 → ok=true。
    /// 跑：`cargo test --manifest-path src-tauri/Cargo.toml real_inet -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_inet_legal_topology_loads() {
        let nodes = vec![
            node("0", "switch"),
            node("1", "switch"),
            node("2", "endSystem"),
            node("3", "endSystem"),
            node("4", "endSystem"),
        ];
        let links = vec![
            link(0, "0", "1"),
            link(1, "0", "2"),
            link(2, "0", "3"),
            link(3, "1", "4"),
        ];
        let cfg = RemoteConfig::dev_default();
        let r = run_inet_verification(&nodes, &links, "real-acceptance", 0, &SshRunner, &cfg);
        assert!(r.ok, "expected INET load OK, got: {:?}", r.errors);
        assert_eq!(r.caliber, "loadability_only");
    }
}
