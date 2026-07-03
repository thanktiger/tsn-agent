//! INET 软仿 HTTP 路径（2026-06-27，plan U6）：`HttpRunner` 实现 `RemoteRunner`，内部
//! POST bundle → 轮询 status → 取 result，映射成与 SSH 路径同样的 `SimRunOutcome`。
//!
//! 这样 `run_timesync_sim_inner` 下游（classify_and_compute / CSV 解析 / GM 对齐）全复用、
//! 前端零改。软仿单路径：`run_timesync_sim` 始终用 HttpRunner（SSH 路径已移除，KTD4）。
//!
//! reqwest 是 async（仓库未启 blocking feature），而 RemoteRunner 是 sync：每次 HTTP 在一个
//! 临时 current-thread runtime（独立线程，scope 借用）里跑，不依赖 ambient runtime 形态。
//! HTTP 客户端经 `InetSimHttpClient` trait 抽象（真实现 reqwest + 测试 Fake）。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::inet_remote::{InetBundle, RemoteError, RemoteRunner, SimRunOutcome};

const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// 轮询总上限（opp_env 首跑编译数分钟，给足；服务端单条命令另有 CMD_TIMEOUT 兜底）。
const DEFAULT_POLL_TIMEOUT: Duration = Duration::from_secs(1800);

/// 服务 result 端点回的结果（snake_case 与服务端一致，直接 deser）。
#[derive(Debug, Clone, Deserialize)]
pub struct HttpSimResult {
    pub exit_code: i32,
    pub output_tail: String,
    pub csv: Option<String>,
    pub scavetool_failed: bool,
}

/// 软仿 HTTP 客户端：submit/status/result 三步。sync（runner 也 sync），便于注入 Fake 单测。
pub trait InetSimHttpClient {
    /// 提交 bundle + filter，返回 job_id。
    fn submit(&self, base_url: &str, bundle: &InetBundle, filter: &str) -> Result<String, String>;
    /// 查状态：queued | running | done | failed。
    fn status(&self, base_url: &str, job_id: &str) -> Result<String, String>;
    /// 取结果（done 才有）。
    fn result(&self, base_url: &str, job_id: &str) -> Result<HttpSimResult, String>;
}

/// 规划（Z3 综合）result：exit + 日志尾 + `.sca` 里 param-recording 出的 transmissionGate
/// 门参数文本（U1/U6 spike：跑 inet 带 `--**.param-recording=true`、grep .sca 门行）。
#[derive(Debug, Clone, Deserialize)]
pub struct HttpPlanResult {
    pub exit_code: i32,
    pub output_tail: String,
    pub sca_gcl: Option<String>,
    /// 求解器出处（R8）：服务端跑 Z3 成功记 "Z3"，退 Eager 记 "Eager"。缺省视为 Z3。
    #[serde(default)]
    pub solver: Option<String>,
}

/// 规划路径 HTTP 客户端（KTD1：与验证路径的 `RemoteRunner` 分开——plan 回 GCL 文本不是 CSV，
/// 不扩 `RemoteRunner` 以免逼 `MockRunner` 也改）。`plan_gcl` 阻塞至 job 完成，回 GCL 文本。
/// U7 单测用 `MockPlanClient` 注入（绕过 HTTP）。
pub trait InetSimPlanClient {
    fn plan_gcl(&self, base_url: &str, bundle: &InetBundle) -> Result<HttpPlanResult, String>;
}

// ---------- 真实现：ReqwestInetSimClient ----------

#[derive(Serialize)]
struct RunBody<'a> {
    network_ned: &'a str,
    omnetpp_ini: &'a str,
    manifest_json: &'a str,
    scavetool_filter: &'a str,
}

#[derive(Deserialize)]
struct JobResp {
    job_id: String,
}

#[derive(Deserialize)]
struct StatusResp {
    status: String,
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}/sim/{}", base_url.trim_end_matches('/'), path)
}

/// 在独立线程的临时 current-thread runtime 里跑 async（不依赖调用处的 ambient runtime 形态）。
fn run_async<T: Send>(fut: impl std::future::Future<Output = T> + Send) -> T {
    std::thread::scope(|s| {
        s.spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("构建临时 runtime 失败")
                .block_on(fut)
        })
        .join()
        .expect("HTTP 线程 panic")
    })
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .expect("构建 reqwest client 失败")
}

pub struct ReqwestInetSimClient;

impl InetSimHttpClient for ReqwestInetSimClient {
    fn submit(&self, base_url: &str, bundle: &InetBundle, filter: &str) -> Result<String, String> {
        let url = endpoint(base_url, "run");
        let body = RunBody {
            network_ned: &bundle.network_ned,
            omnetpp_ini: &bundle.omnetpp_ini,
            manifest_json: &bundle.manifest_json,
            scavetool_filter: filter,
        };
        let payload = serde_json::to_vec(&body).map_err(|e| format!("序列化 bundle 失败：{e}"))?;
        run_async(async move {
            let resp = http_client()
                .post(&url)
                .header("Content-Type", "application/json")
                .body(payload)
                .send()
                .await
                .map_err(|e| format!("提交软仿失败：{e}"))?;
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            if status.as_u16() == 409 {
                return Err("软仿服务忙（已有任务在运行）".to_string());
            }
            if !status.is_success() {
                return Err(format!(
                    "提交软仿失败（HTTP {status}）：{}",
                    body_text(&bytes)
                ));
            }
            serde_json::from_slice::<JobResp>(&bytes)
                .map(|j| j.job_id)
                .map_err(|e| format!("解析 job_id 失败：{e}"))
        })
    }

    fn status(&self, base_url: &str, job_id: &str) -> Result<String, String> {
        let url = endpoint(base_url, &format!("run/{job_id}/status"));
        run_async(async move {
            let resp = http_client()
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("查状态失败：{e}"))?;
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!(
                    "查状态失败（HTTP {status}）：{}",
                    body_text(&bytes)
                ));
            }
            serde_json::from_slice::<StatusResp>(&bytes)
                .map(|s| s.status)
                .map_err(|e| format!("解析状态失败：{e}"))
        })
    }

    fn result(&self, base_url: &str, job_id: &str) -> Result<HttpSimResult, String> {
        let url = endpoint(base_url, &format!("run/{job_id}/result"));
        run_async(async move {
            let resp = http_client()
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("取结果失败：{e}"))?;
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!(
                    "取结果失败（HTTP {status}）：{}",
                    body_text(&bytes)
                ));
            }
            serde_json::from_slice::<HttpSimResult>(&bytes)
                .map_err(|e| format!("解析结果失败：{e}"))
        })
    }
}

#[derive(Serialize)]
struct PlanBody<'a> {
    network_ned: &'a str,
    omnetpp_ini: &'a str,
    manifest_json: &'a str,
}

#[derive(Deserialize)]
struct PlanStatusResp {
    status: String,
}

/// 规划路径复用 submit→poll→result 三步，但走 `/sim/plan*` 端点、result 回 GCL 文本。
/// 内部自轮询（阻塞）；poll 逻辑不单测（真机验证），与 submit/status/result 的 reqwest 实现同口径。
impl InetSimPlanClient for ReqwestInetSimClient {
    fn plan_gcl(&self, base_url: &str, bundle: &InetBundle) -> Result<HttpPlanResult, String> {
        let submit_url = endpoint(base_url, "plan");
        let body = PlanBody {
            network_ned: &bundle.network_ned,
            omnetpp_ini: &bundle.omnetpp_ini,
            manifest_json: &bundle.manifest_json,
        };
        let payload = serde_json::to_vec(&body).map_err(|e| format!("序列化 bundle 失败：{e}"))?;
        let job_id = run_async(async move {
            let resp = http_client()
                .post(&submit_url)
                .header("Content-Type", "application/json")
                .body(payload)
                .send()
                .await
                .map_err(|e| format!("提交规划失败：{e}"))?;
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            if status.as_u16() == 409 {
                return Err("软仿服务忙（已有任务在运行）".to_string());
            }
            if !status.is_success() {
                return Err(format!(
                    "提交规划失败（HTTP {status}）：{}",
                    body_text(&bytes)
                ));
            }
            serde_json::from_slice::<JobResp>(&bytes)
                .map(|j| j.job_id)
                .map_err(|e| format!("解析 job_id 失败：{e}"))
        })?;

        let start = Instant::now();
        loop {
            let status_url = endpoint(base_url, &format!("plan/{job_id}/status"));
            let st = run_async(async move {
                let resp = http_client()
                    .get(&status_url)
                    .send()
                    .await
                    .map_err(|e| format!("查规划状态失败：{e}"))?;
                let code = resp.status();
                let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
                if !code.is_success() {
                    return Err(format!(
                        "查规划状态失败（HTTP {code}）：{}",
                        body_text(&bytes)
                    ));
                }
                serde_json::from_slice::<PlanStatusResp>(&bytes)
                    .map(|s| s.status)
                    .map_err(|e| format!("解析规划状态失败：{e}"))
            })?;
            match st.as_str() {
                "done" => break,
                "failed" => return Err("规划执行失败（服务端 job failed）".to_string()),
                _ => {}
            }
            if start.elapsed() > DEFAULT_POLL_TIMEOUT {
                return Err("规划轮询超时".to_string());
            }
            std::thread::sleep(DEFAULT_POLL_INTERVAL);
        }

        let result_url = endpoint(base_url, &format!("plan/{job_id}/result"));
        run_async(async move {
            let resp = http_client()
                .get(&result_url)
                .send()
                .await
                .map_err(|e| format!("取规划结果失败：{e}"))?;
            let code = resp.status();
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            if !code.is_success() {
                return Err(format!(
                    "取规划结果失败（HTTP {code}）：{}",
                    body_text(&bytes)
                ));
            }
            serde_json::from_slice::<HttpPlanResult>(&bytes)
                .map_err(|e| format!("解析规划结果失败：{e}"))
        })
    }
}

fn body_text(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    if s.chars().count() > 500 {
        let truncated: String = s.chars().take(500).collect();
        format!("{truncated}…")
    } else {
        s.into_owned()
    }
}

// ---------- HttpRunner：RemoteRunner 实现 ----------

pub struct HttpRunner<C: InetSimHttpClient> {
    pub client: C,
    pub base_url: String,
    pub poll_interval: Duration,
    pub poll_timeout: Duration,
}

impl<C: InetSimHttpClient> HttpRunner<C> {
    pub fn new(client: C, base_url: String) -> Self {
        Self {
            client,
            base_url,
            poll_interval: DEFAULT_POLL_INTERVAL,
            poll_timeout: DEFAULT_POLL_TIMEOUT,
        }
    }
}

impl<C: InetSimHttpClient> RemoteRunner for HttpRunner<C> {
    fn run_sim_fetch_csv(
        &self,
        bundle: &InetBundle,
        scavetool_filter: &str,
    ) -> Result<SimRunOutcome, RemoteError> {
        let job_id = self
            .client
            .submit(&self.base_url, bundle, scavetool_filter)
            .map_err(RemoteError::Unreachable)?;

        let start = Instant::now();
        loop {
            let st = self
                .client
                .status(&self.base_url, &job_id)
                .map_err(RemoteError::Unreachable)?;
            match st.as_str() {
                "done" => break,
                "failed" => {
                    // 服务端内部失败（如命令超时）→ result 端点 500 带原因；映射成 unreachable。
                    let reason = self
                        .client
                        .result(&self.base_url, &job_id)
                        .err()
                        .unwrap_or_else(|| "软仿执行失败".to_string());
                    return Err(RemoteError::Unreachable(reason));
                }
                _ => {}
            }
            if start.elapsed() > self.poll_timeout {
                return Err(RemoteError::Unreachable("软仿轮询超时".to_string()));
            }
            std::thread::sleep(self.poll_interval);
        }

        let r = self
            .client
            .result(&self.base_url, &job_id)
            .map_err(RemoteError::Unreachable)?;
        // exit≠0 / scavetool_failed / csv 空 全部交给下游 classify_and_compute（与 SSH 同路径）。
        Ok(SimRunOutcome {
            exit_code: Some(r.exit_code),
            output_tail: r.output_tail,
            csv: r.csv,
            scavetool_failed: r.scavetool_failed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn bundle() -> InetBundle {
        InetBundle {
            network_ned: "n".into(),
            omnetpp_ini: "i".into(),
            manifest_json: "{}".into(),
        }
    }

    /// Fake：scripted status 序列 + canned result，捕获 submit 入参。
    struct FakeClient {
        statuses: RefCell<Vec<&'static str>>,
        result: Result<HttpSimResult, String>,
        submitted_filter: RefCell<Option<String>>,
        submit_err: Option<String>,
    }

    impl FakeClient {
        fn done_with(result: HttpSimResult) -> Self {
            Self {
                statuses: RefCell::new(vec!["running", "done"]),
                result: Ok(result),
                submitted_filter: RefCell::new(None),
                submit_err: None,
            }
        }
    }

    impl InetSimHttpClient for FakeClient {
        fn submit(&self, _base: &str, _b: &InetBundle, filter: &str) -> Result<String, String> {
            if let Some(e) = &self.submit_err {
                return Err(e.clone());
            }
            *self.submitted_filter.borrow_mut() = Some(filter.to_string());
            Ok("run-fake".into())
        }
        fn status(&self, _base: &str, _job: &str) -> Result<String, String> {
            let mut q = self.statuses.borrow_mut();
            // 取出下一个；用尽则停在最后一个。
            if q.len() > 1 {
                Ok(q.remove(0).to_string())
            } else {
                Ok(q[0].to_string())
            }
        }
        fn result(&self, _base: &str, _job: &str) -> Result<HttpSimResult, String> {
            self.result.clone()
        }
    }

    fn fast_runner<C: InetSimHttpClient>(client: C) -> HttpRunner<C> {
        HttpRunner {
            client,
            base_url: "http://x".into(),
            poll_interval: Duration::from_millis(1),
            poll_timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn polls_until_done_then_maps_result_to_outcome() {
        let client = FakeClient::done_with(HttpSimResult {
            exit_code: 0,
            output_tail: "ok".into(),
            csv: Some("module,name,vectime,vecvalue\n".into()),
            scavetool_failed: false,
        });
        let runner = fast_runner(client);
        let out = runner.run_sim_fetch_csv(&bundle(), "filt").unwrap();
        assert_eq!(out.exit_code, Some(0));
        assert_eq!(out.csv.as_deref(), Some("module,name,vectime,vecvalue\n"));
        assert!(!out.scavetool_failed);
        // submit 收到的 filter 透传正确。
        assert_eq!(
            runner.client.submitted_filter.borrow().as_deref(),
            Some("filt")
        );
    }

    #[test]
    fn nonzero_exit_passes_through_for_downstream_classify() {
        let client = FakeClient::done_with(HttpSimResult {
            exit_code: 1,
            output_tail: "boom".into(),
            csv: None,
            scavetool_failed: false,
        });
        let out = fast_runner(client)
            .run_sim_fetch_csv(&bundle(), "f")
            .unwrap();
        assert_eq!(out.exit_code, Some(1));
        assert!(out.csv.is_none());
    }

    #[test]
    fn failed_status_maps_to_unreachable() {
        let mut client = FakeClient::done_with(HttpSimResult {
            exit_code: 0,
            output_tail: String::new(),
            csv: None,
            scavetool_failed: false,
        });
        client.statuses = RefCell::new(vec!["failed"]);
        client.result = Err("命令超时".into());
        let err = fast_runner(client).run_sim_fetch_csv(&bundle(), "f");
        assert!(matches!(err, Err(RemoteError::Unreachable(m)) if m.contains("命令超时")));
    }

    #[test]
    fn submit_error_maps_to_unreachable() {
        let client = FakeClient {
            statuses: RefCell::new(vec!["done"]),
            result: Err("x".into()),
            submitted_filter: RefCell::new(None),
            submit_err: Some("服务忙".into()),
        };
        let err = fast_runner(client).run_sim_fetch_csv(&bundle(), "f");
        assert!(matches!(err, Err(RemoteError::Unreachable(m)) if m.contains("服务忙")));
    }
}
