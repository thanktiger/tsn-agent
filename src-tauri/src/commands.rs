use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, path::BaseDirectory};

const MAX_PROMPT_CHARS: usize = 4_000;
const MAX_CONTEXT_CHARS: usize = 12_000;
const CLAUDE_BRIDGE_SYNC_TIMEOUT: Duration = Duration::from_secs(300);
static CLAUDE_AGENT_RUNNING: AtomicBool = AtomicBool::new(false);

/// 正在运行的 worker 句柄：cancel 命令按 runId 比对后据此定位进程组强杀。
/// 单例锁 `ClaudeAgentRunGuard` 保证同时至多一个 run，故用 `Option` 而非 map。
#[derive(Debug, Clone)]
pub struct ActiveWorker {
    pub run_id: String,
    #[cfg(unix)]
    pub pgid: i32,
    #[cfg(windows)]
    pub pid: u32,
}

/// Tauri managed state：`Mutex<Option<ActiveWorker>>`。注册时机与去注册见
/// `run_claude_agent_blocking`（注册紧贴 spawn、去注册紧贴 reap，压缩误杀窗口）。
#[derive(Debug, Default)]
pub struct AgentWorkerRegistry(Mutex<Option<ActiveWorker>>);

/// cancel 命令返回给前端的结果：`killed` 是「真终止」与「没杀到」的唯一闸门。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOutcome {
    pub killed: bool,
}

/// 进程组强杀的单一事实源——超时分支与 cancel 命令共用，杜绝双轨复制。
/// Unix 先 `kill(-pgid, 0)` 探活，pgid 已不存在（返回 -1）则不发 SIGKILL，
/// 防 reap 后 pgid 复用误杀第三方进程组。
fn kill_worker_process_group(worker: &ActiveWorker) {
    #[cfg(unix)]
    {
        // signal 0 探活：0 = 进程组存在且有权限；-1 = 不存在（ESRCH），跳过强杀。
        if unsafe { libc::kill(-worker.pgid, 0) } == -1 {
            return;
        }
        unsafe {
            libc::kill(-worker.pgid, libc::SIGKILL);
        }
    }
    // Windows 无 pgid：taskkill /T 按进程树端掉 worker + MCP child（/F 强制）。
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .arg("/F")
            .arg("/T")
            .arg("/PID")
            .arg(worker.pid.to_string())
            .output();
    }
}

/// 拿到 worker 句柄后立即注册并构造此 guard；函数任意返回路径（成功/超时/失败）
/// Drop 时兜底清空 registry（去注册紧贴 reap 已先清的话此处 take None → no-op）。
struct AgentWorkerRegistration<'a> {
    registry: &'a AgentWorkerRegistry,
}

impl AgentWorkerRegistration<'_> {
    fn new(registry: &AgentWorkerRegistry, worker: ActiveWorker) -> AgentWorkerRegistration<'_> {
        registry.0.lock().expect("registry mutex").replace(worker);
        AgentWorkerRegistration { registry }
    }
}

impl Drop for AgentWorkerRegistration<'_> {
    fn drop(&mut self) {
        let _ = self.registry.0.lock().expect("registry mutex").take();
    }
}

/// cancel 命令内核：按 runId 比对，命中则在锁内 `take()` 取出 worker、**释锁后**再强杀，
/// 避免持 registry 锁跨 Windows `taskkill` 的阻塞 `.output()` 调用而阻塞 spawn/去注册。
/// 命中返回 true，否则 false（幂等）。命令与单测共用此内核，避免测试复刻锁逻辑。
fn do_cancel(registry: &AgentWorkerRegistry, run_id: &str) -> bool {
    let worker = {
        let mut slot = registry.0.lock().expect("registry mutex");
        match slot.as_ref() {
            Some(w) if w.run_id == run_id => slot.take(),
            _ => None,
        }
    };
    match worker {
        Some(worker) => {
            kill_worker_process_group(&worker);
            true
        }
        None => false,
    }
}

/// 按 runId 终止当前正在跑的 worker：匹配则强杀进程组并去注册，返回 `killed:true`；
/// 无运行 / runId 不匹配 / run 已自然收尾 → `killed:false`（幂等、非错误）。
/// 只发信号不 `wait()`（KTD2，zombie 回收由阻塞循环负责）。
#[tauri::command]
pub async fn cancel_claude_agent(
    registry: tauri::State<'_, AgentWorkerRegistry>,
    run_id: String,
) -> Result<CancelOutcome, String> {
    Ok(CancelOutcome {
        killed: do_cancel(&registry, &run_id),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAgentRequest {
    prompt: String,
    run_id: Option<String>,
    app_session_id: Option<String>,
    resume_session_id: Option<String>,
    conversation_context: Option<String>,
    stage_runner_input: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAgentResponse {
    assistant_text: String,
    session_id: Option<String>,
    stage_results: Vec<serde_json::Value>,
    // Plan 2026-06-09-003：结构化工具调用记录，前端富化成卡片。与 stage_results 同构透传。
    tool_calls: Vec<serde_json::Value>,
    audit_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeWorkerResponse {
    assistant_text: String,
    session_id: Option<String>,
    #[serde(default)]
    stage_results: Vec<serde_json::Value>,
    #[serde(default)]
    tool_calls: Vec<serde_json::Value>,
    audit_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeWorkerEvent {
    event: String,
    run_id: Option<String>,
    text: Option<String>,
    session_id: Option<String>,
    assistant_text: Option<String>,
    #[serde(default)]
    stage_results: Vec<serde_json::Value>,
    #[serde(default)]
    tool_calls: Vec<serde_json::Value>,
    // Plan 2026-06-10-001 U2：流式工具事件整体透传，Rust 不拆字段（契约客户端无关）。
    #[serde(default)]
    tool_call: Option<serde_json::Value>,
    audit_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAgentEventPayload {
    run_id: String,
    kind: String,
    text: Option<String>,
    session_id: Option<String>,
    tool_call: Option<serde_json::Value>,
}

/// 暴露拓扑模板参数合法域（类型/上下限/枚举）给前端只读展示。
/// 数据源为 `topology_compute::describe_templates_catalog`，与 MCP `describe_templates` 同一事实源。
#[tauri::command]
pub fn describe_topology_templates() -> serde_json::Value {
    crate::topology_compute::describe_templates_catalog()
}

#[tauri::command]
pub async fn run_claude_agent(
    app: tauri::AppHandle,
    request: ClaudeAgentRequest,
) -> Result<ClaudeAgentResponse, String> {
    tauri::async_runtime::spawn_blocking(move || run_claude_agent_blocking(app, request))
        .await
        .map_err(|error| format!("智能助手任务失败：{error}"))?
}

fn run_claude_agent_blocking(
    app: tauri::AppHandle,
    request: ClaudeAgentRequest,
) -> Result<ClaudeAgentResponse, String> {
    validate_prompt(&request.prompt)?;
    validate_context(request.conversation_context.as_deref())?;

    let _guard = ClaudeAgentRunGuard::acquire()?;
    // Windows：Tauri resource resolve 返回 `\\?\` verbatim 路径，node 起不来——去前缀。
    let worker_path = strip_verbatim_prefix(find_worker_path(Some(&app))?);
    let cwd = repo_root_from_worker(&worker_path);
    let run_id = request.run_id.clone().unwrap_or_else(create_run_id);
    let app_session_id = request.app_session_id.clone();
    let audit_dir = agent_audit_dir(&app).map(strip_verbatim_prefix);
    // 打包态：随 app 分发的 claude binary 路径（dev 态 None → SDK 默认用 node_modules 平台包）。
    let claude_binary_path = find_claude_binary(Some(&app));
    // 同源（R2）：worker 与编辑器消费同一有效 skill 根决策（含 app-data 懒播种）。
    let (skill_root, skill_root_reason) = {
        let effective = crate::skill_files::effective_skill_root(&app);
        let reason = effective.diagnostics_reason().map(str::to_string);
        // 混合态守卫：根可用但 worker 消费的 SKILL.md 缺失（个别目录播种失败）时
        // 视同不可用——走 cwd 兜底（打包态=内置工厂副本），与编辑器 per-id 回退
        // 显示的内容对齐，避免「界面看得到指引、agent 只注入骨架」的反向不同源。
        let path = effective
            .into_usable_path()
            .map(strip_verbatim_prefix)
            .filter(|root| root.join("tsn-topology").join("SKILL.md").exists());
        (path, reason)
    };
    let prompt_chars = request.prompt.chars().count();
    let context_chars = request
        .conversation_context
        .as_deref()
        .map(|value| value.chars().count())
        .unwrap_or_default();

    log_worker_event(
        &app,
        app_session_id.as_deref(),
        &run_id,
        "info",
        "Agent worker 准备启动",
        None,
        serde_json::json!({
            "hasResumeSession": request.resume_session_id.is_some(),
            "promptChars": prompt_chars,
            "contextChars": context_chars,
            "auditDir": audit_dir.as_ref().map(|path| path.display().to_string()),
            "skillRoot": skill_root.as_ref().map(|path| path.display().to_string()),
        }),
    );
    if skill_root.is_none() {
        // skill 根不可用（或可用但缺 SKILL.md）时 payload 携带 skillRoot:null，
        // worker 端 typeof 守卫视同缺省走 cwd 兜底。注意该兜底在打包态会成功读到
        // 内置工厂副本、不触发 skill_guidance_unavailable——界面编辑与 agent 消费
        // 可能不同源，必须留 warn 痕迹供排查。
        log_worker_event(
            &app,
            app_session_id.as_deref(),
            &run_id,
            "warn",
            "skill 根解析不可用，本次运行回退 worker cwd 兜底（打包态等价于内置工厂副本）",
            None,
            serde_json::json!({ "reason": skill_root_reason }),
        );
    }
    // Plan v3 U3+U4b：注入 sidecar url + token + session_id 给 worker，
    // worker 再透传给 MCP child 的 `env`（避免 SDK env passthrough bug，见 Spike B）。
    let (sidecar_url, sidecar_token, app_session_id_for_env) = {
        use tauri::Manager;
        let handle = app
            .try_state::<crate::topology_sidecar::SidecarHandle>()
            .ok_or_else(|| "拓扑 sidecar 未启动；应用初始化异常".to_string())?;
        (
            handle.url.clone(),
            handle.token.expose().to_string(),
            request.app_session_id.clone().unwrap_or_default(),
        )
    };

    let payload = serde_json::json!({
        "prompt": request.prompt,
        "cwd": cwd,
        "runId": run_id,
        "appSessionId": request.app_session_id,
        "auditDir": audit_dir,
        "skillRoot": skill_root,
        "claudeBinaryPath": claude_binary_path,
        "resumeSessionId": request.resume_session_id,
        "conversationContext": request.conversation_context,
        "stageRunnerInput": request.stage_runner_input,
        "sidecar": {
            "url": sidecar_url.clone(),
            // 不在 payload 内 echo token（避免被 worker 端 audit log 序列化）；
            // token 通过 env 注入。
        },
    })
    .to_string();

    // GUI app（Finder/Dock 启动）不继承 shell PATH，须显式定位 node 绝对路径。
    let node_cmd = resolve_node_command();
    let mut command = Command::new(&node_cmd);
    command
        .arg(&worker_path)
        .arg(payload)
        .current_dir(cwd)
        // 注入 sidecar url + token + session_id 到 worker 进程 env；
        // worker.mjs 再通过 mcpServers.tsn_topology.env 显式声明透传到 MCP child。
        .env("TSN_AGENT_DB_RPC_URL", &sidecar_url)
        .env("TSN_AGENT_DB_RPC_TOKEN", &sidecar_token)
        .env("TSN_AGENT_SESSION_ID", &app_session_id_for_env)
        // CLAUDECODE=1 在 Claude Code 进程下会被 SDK 拒绝（Spike B + plan v3 KTD）。
        .env_remove("CLAUDECODE")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // 审计 P1#3：worker 独立进程组（pgid = worker pid），超时可 kill(-pgid)
    // 连根端掉 SDK 拉起的 MCP child，避免孤儿进程继续持有 DB_RPC_TOKEN。
    // Windows 无进程组语义：超时改用 taskkill /T 按 PID 树端掉（见 try_wait 超时分支）。
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        log_worker_event(
            &app,
            app_session_id.as_deref(),
            &run_id,
            "error",
            "Agent worker 启动失败",
            None,
            serde_json::json!({ "error": redact_error(&error.to_string()) }),
        );
        format!(
            "无法启动智能助手运行时。请确认 Node.js 可用。{}",
            redact_error(&error.to_string())
        )
    })?;
    log_worker_event(
        &app,
        app_session_id.as_deref(),
        &run_id,
        "info",
        "Agent worker 已启动",
        None,
        serde_json::json!({ "workerPath": worker_path.display().to_string() }),
    );
    // process_group(0) 后 worker 是组长，pgid 等于其 pid（仅 Unix 用于 kill(-pgid)）。
    #[cfg(unix)]
    let worker_pgid = child.id() as i32;
    let started_at = Instant::now();
    // 注册时机（硬约束）：拿到句柄后立即注册 + 构造去注册 guard，必须早于下面
    // stdout/stderr 的 `?` 早返回——否则 take 失败会留下「已 spawn 但未注册」的孤儿 worker。
    let registry = app
        .try_state::<AgentWorkerRegistry>()
        .ok_or_else(|| "worker 注册表未初始化；应用初始化异常".to_string())?;
    let active_worker = ActiveWorker {
        run_id: run_id.clone(),
        #[cfg(unix)]
        pgid: worker_pgid,
        #[cfg(windows)]
        pid: child.id(),
    };
    let _registration = AgentWorkerRegistration::new(&registry, active_worker);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "智能助手运行时 stdout 不可用。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "智能助手运行时 stderr 不可用。".to_string())?;
    let (stdout_rx, stdout_thread) = spawn_line_reader(stdout, "stdout");
    let (stderr_rx, stderr_thread) = spawn_line_reader(stderr, "stderr");
    let mut stdout_lines = Vec::new();
    let mut stderr_lines = Vec::new();
    let mut response: Option<ClaudeAgentResponse> = None;

    loop {
        drain_stdout_lines(
            &stdout_rx,
            &mut stdout_lines,
            &app,
            &run_id,
            app_session_id.as_deref(),
            &mut response,
        )?;
        drain_plain_lines(&stderr_rx, &mut stderr_lines)?;

        match child.try_wait() {
            Ok(Some(_status)) => {
                // 去注册紧贴 reap：进程已退出、zombie 已收割，立即在锁下 take 去注册，
                // 把「已 reap 但未去注册」窗口压到几条指令内（防 pgid/pid 复用误杀）。
                let _ = registry.0.lock().expect("registry mutex").take();
                break;
            }
            Ok(None) if started_at.elapsed() > CLAUDE_BRIDGE_SYNC_TIMEOUT => {
                // 超时强杀：先在锁下 take 去注册（与 reap 分支对称），避免 child.wait()
                // 期间同 runId 的 cancel 命中残留死 pgid 而返回 spurious killed:true；
                // 再用取出的句柄复用单一强杀 helper（worker + MCP child 一并端掉，
                // 避免孤儿进程继续持有 sidecar 的 DB_RPC_TOKEN，审计 P1#3）。
                let timed_out_worker = registry.0.lock().expect("registry mutex").take();
                if let Some(worker) = timed_out_worker.as_ref() {
                    kill_worker_process_group(worker);
                }
                let _ = child.wait();
                // SIGKILL 关闭管道 FD → reader 线程很快 EOF 退出；join 回收（与正常退出
                // 路径对称），避免与下一轮 spawn 的 reader 线程并存。
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                log_worker_event(
                    &app,
                    app_session_id.as_deref(),
                    &run_id,
                    "error",
                    "Agent worker 执行超时",
                    Some(started_at.elapsed().as_millis() as i64),
                    serde_json::json!({ "timeoutMs": CLAUDE_BRIDGE_SYNC_TIMEOUT.as_millis() }),
                );
                return Err("智能助手运行时执行超时，已取消本次请求。".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                return Err(format!(
                    "智能助手运行时状态检查失败：{}",
                    redact_error(&error.to_string())
                ));
            }
        }
    }

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    drain_stdout_lines(
        &stdout_rx,
        &mut stdout_lines,
        &app,
        &run_id,
        app_session_id.as_deref(),
        &mut response,
    )?;
    drain_plain_lines(&stderr_rx, &mut stderr_lines)?;
    let output = child
        .try_wait()
        .map_err(|error| {
            format!(
                "智能助手运行时输出读取失败：{}",
                redact_error(&error.to_string())
            )
        })?
        .ok_or_else(|| "智能助手运行时状态读取失败。".to_string())?;
    let stderr = stderr_lines.join("\n");
    let stdout = stdout_lines.join("\n");

    if !output.success() {
        let error_summary =
            redact_error(first_non_empty(&stderr, "智能助手运行时未返回最终结果。"));
        log_worker_event(
            &app,
            app_session_id.as_deref(),
            &run_id,
            "error",
            "Agent worker 执行失败",
            Some(started_at.elapsed().as_millis() as i64),
            serde_json::json!({
                "status": output.code(),
                "error": error_summary.clone(),
            }),
        );
        return Err(format!("智能助手运行时执行失败：{error_summary}"));
    }

    let final_response = response
        .or_else(|| parse_worker_output(&stdout).ok())
        .ok_or_else(|| format!("智能助手运行时没有返回最终结果：{}", redact_error(&stdout)))?;

    log_worker_event(
        &app,
        app_session_id.as_deref(),
        &run_id,
        "info",
        "Agent worker 执行完成",
        Some(started_at.elapsed().as_millis() as i64),
        serde_json::json!({
            "claudeSessionId": final_response.session_id,
            "assistantChars": final_response.assistant_text.chars().count(),
            "stdoutLines": stdout_lines.len(),
            "stderrLines": stderr_lines.len(),
            "auditPath": final_response.audit_path,
        }),
    );

    Ok(final_response)
}

fn parse_worker_output(stdout: &str) -> Result<ClaudeAgentResponse, String> {
    let final_line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(stdout.trim());
    let parsed: ClaudeWorkerResponse = serde_json::from_str(final_line.trim())
        .map_err(|_| format!("智能助手运行时返回了非 JSON 输出：{}", redact_error(stdout)))?;
    let assistant_text = parsed.assistant_text.trim().to_string();

    if assistant_text.is_empty() {
        return Err("智能助手运行时没有返回可展示内容。".to_string());
    }

    Ok(ClaudeAgentResponse {
        assistant_text,
        session_id: parsed.session_id,
        stage_results: parsed.stage_results,
        tool_calls: parsed.tool_calls,
        audit_path: parsed.audit_path,
    })
}

fn spawn_line_reader<R>(
    pipe: R,
    stream_name: &'static str,
) -> (
    Receiver<Result<String, String>>,
    std::thread::JoinHandle<()>,
)
where
    R: std::io::Read + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let reader = BufReader::new(pipe);

        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(Ok(line)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(format!(
                        "智能助手运行时 {stream_name} 读取失败：{}",
                        redact_error(&error.to_string())
                    )));
                    break;
                }
            }
        }
    });

    (rx, handle)
}

fn drain_plain_lines(
    rx: &Receiver<Result<String, String>>,
    lines: &mut Vec<String>,
) -> Result<(), String> {
    loop {
        match rx.try_recv() {
            Ok(Ok(line)) => {
                if !line.trim().is_empty() {
                    lines.push(line);
                }
            }
            Ok(Err(error)) => return Err(error),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => break,
        }
    }

    Ok(())
}

fn drain_stdout_lines(
    stdout_rx: &Receiver<Result<String, String>>,
    stdout_lines: &mut Vec<String>,
    app: &tauri::AppHandle,
    fallback_run_id: &str,
    app_session_id: Option<&str>,
    response: &mut Option<ClaudeAgentResponse>,
) -> Result<(), String> {
    loop {
        let line = match stdout_rx.try_recv() {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => return Err(error),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => break,
        };
        let trimmed = line.trim().to_string();

        if trimmed.is_empty() {
            continue;
        }

        handle_worker_line(&trimmed, app, fallback_run_id, app_session_id, response)?;
        // tool_call 行携带原始工具入参/出参，不进 stdout 缓冲——无 done 兜底错误
        // 会把该缓冲经弱红 action（redact_error）嵌入用户可见错误与诊断。
        if !trimmed.contains("\"event\":\"tool_call\"") {
            stdout_lines.push(trimmed);
        }
    }

    Ok(())
}

fn handle_worker_line(
    line: &str,
    app: &tauri::AppHandle,
    fallback_run_id: &str,
    app_session_id: Option<&str>,
    response: &mut Option<ClaudeAgentResponse>,
) -> Result<(), String> {
    let parsed: ClaudeWorkerEvent = serde_json::from_str(line)
        .map_err(|_| format!("智能助手运行时返回了非 JSON 输出：{}", redact_error(line)))?;
    let run_id = parsed.run_id.unwrap_or_else(|| fallback_run_id.to_string());

    match parsed.event.as_str() {
        "chunk" => {
            let text = parsed.text.unwrap_or_default();
            if !text.is_empty() {
                emit_claude_event(app, &run_id, "chunk", Some(text), None, None);
            }
        }
        "session" => {
            log_worker_event(
                app,
                app_session_id,
                &run_id,
                "info",
                "Agent worker 返回 session id",
                None,
                serde_json::json!({ "claudeSessionId": parsed.session_id }),
            );
            emit_claude_event(app, &run_id, "session", None, parsed.session_id, None);
        }
        "tool_call" => {
            if let Some(tool_call) = parsed.tool_call {
                emit_claude_event(app, &run_id, "tool_call", None, None, Some(tool_call));
            }
        }
        "done" => {
            let assistant_text = parsed.assistant_text.unwrap_or_default().trim().to_string();

            if assistant_text.is_empty() {
                return Err("智能助手运行时没有返回可展示内容。".to_string());
            }

            *response = Some(ClaudeAgentResponse {
                assistant_text,
                session_id: parsed.session_id,
                stage_results: parsed.stage_results,
                tool_calls: parsed.tool_calls,
                audit_path: parsed.audit_path,
            });
        }
        _ => {}
    }

    Ok(())
}

fn agent_audit_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|path| path.join("agent-runs"))
}

fn log_worker_event(
    app: &tauri::AppHandle,
    session_id: Option<&str>,
    run_id: &str,
    level: &str,
    message: &str,
    duration_ms: Option<i64>,
    details: serde_json::Value,
) {
    let Some(session_id) = session_id else {
        return;
    };
    let entry = crate::diagnostic_store::DiagnosticLogEntry {
        id: create_log_id(),
        session_id: session_id.to_string(),
        category: "agent".to_string(),
        level: level.to_string(),
        message: message.to_string(),
        created_at: iso_now(),
        run_id: Some(run_id.to_string()),
        duration_ms,
        details: Some(details),
    };

    // U_R5：诊断日志改写 jsonl 文件。LogFileWriter 是 async + 串行 Mutex，
    // 这里在 worker stderr 同步处理路径上以 block_on 桥接。
    use tauri::Manager;
    if let Some(store) = app.try_state::<crate::diagnostic_store::DiagnosticStore>() {
        let _ = tauri::async_runtime::block_on(store.writer().append(app, entry));
    }
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    format!("{millis}")
}

fn create_log_id() -> String {
    format!(
        "diagnostic-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    )
}

fn emit_claude_event(
    app: &tauri::AppHandle,
    run_id: &str,
    kind: &str,
    text: Option<String>,
    session_id: Option<String>,
    tool_call: Option<serde_json::Value>,
) {
    let _ = app.emit(
        "claude-agent-event",
        ClaudeAgentEventPayload {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            text,
            session_id,
            tool_call,
        },
    );
}

/// Tauri 的 `PathResolver::resolve(BaseDirectory::Resource)` 在 Windows 经
/// `resource_dir` 的裸 `std::fs::canonicalize` 返回 `\\?\` verbatim（扩展长度）路径，
/// 且 Rust 侧 `resolve_path` 未做 `dunce::simplified`（只有前端 JS 的 resolve_path
/// command 做了）。Node 解析主模块时无法处理 verbatim 前缀（逐段解析时对盘符 `lstat`
/// 报 EISDIR），故凡是要交给 node 进程的路径都必须先去掉前缀。
#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

fn find_worker_path(app: Option<&tauri::AppHandle>) -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .ok_or_else(|| "无法定位项目根目录。".to_string())?;
    let development_worker_path = repo_root.join("src-node/dist/claude-agent-worker.mjs");

    if cfg!(debug_assertions) && development_worker_path.exists() {
        return Ok(development_worker_path);
    }

    if let Some(app) = app
        && let Ok(resource_path) = app
            .path()
            .resolve("src-node/claude-agent-worker.mjs", BaseDirectory::Resource)
        && resource_path.exists()
    {
        return Ok(resource_path);
    }

    if development_worker_path.exists() {
        return Ok(development_worker_path);
    }

    Err(format!(
        "未找到智能助手运行时 worker：{}。请先运行 npm run build:worker。",
        development_worker_path.display()
    ))
}

/// 打包态：随 app 分发的 Claude Code native binary（build:worker 复制到 claude-runtime/）。
/// SDK 默认从 node_modules 平台包（@anthropic-ai/claude-agent-sdk-{platform}）找 claude，
/// bundle 后不存在，故打包态必须显式提供给 worker 的 pathToClaudeCodeExecutable。
/// dev 态返回 None —— node_modules 平台包里有 binary，SDK 默认能找到。
fn find_claude_binary(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    let exe = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let resource_path = app?
        .path()
        .resolve(format!("claude-runtime/{exe}"), BaseDirectory::Resource)
        .ok()?;
    let resource_path = strip_verbatim_prefix(resource_path);
    resource_path.exists().then_some(resource_path)
}

/// 定位 node 可执行的绝对路径。macOS/Linux 的 GUI app（从 Finder/Dock 启动）继承的
/// PATH 不含用户 shell 里的 nvm/homebrew node 路径，裸 `Command::new("node")` 会 ENOENT
/// （os error 2）。探测常见安装位置；都未命中再回退裸命令名（dev / 命令行启动时 PATH
/// 可用）。可用 TSN_AGENT_NODE_PATH 显式覆盖。
fn resolve_node_command() -> std::ffi::OsString {
    use std::ffi::OsString;
    if let Some(p) = std::env::var_os("TSN_AGENT_NODE_PATH")
        && !p.is_empty()
        && Path::new(&p).exists()
    {
        return p;
    }
    #[cfg(unix)]
    {
        // homebrew（apple silicon / intel）/ 官方 pkg / system
        for c in [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ] {
            if Path::new(c).exists() {
                return OsString::from(c);
            }
        }
        // nvm: ~/.nvm/versions/node/<ver>/bin/node —— 取存在的最新版本（字典序近似）。
        if let Some(home) = std::env::var_os("HOME") {
            let nvm = PathBuf::from(&home).join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm) {
                let mut bins: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok().map(|e| e.path().join("bin/node")))
                    .filter(|p| p.exists())
                    .collect();
                bins.sort();
                if let Some(latest) = bins.pop() {
                    return latest.into_os_string();
                }
            }
        }
    }
    #[cfg(windows)]
    {
        for c in [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ] {
            if Path::new(c).exists() {
                return OsString::from(c);
            }
        }
    }
    OsString::from(if cfg!(windows) { "node.exe" } else { "node" })
}

fn repo_root_from_worker(worker_path: &Path) -> PathBuf {
    if worker_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        == Some("dist")
        && let Some(repo_root) = worker_path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
    {
        return repo_root.to_path_buf();
    }

    worker_path
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn first_non_empty<'a>(left: &'a str, right: &'a str) -> &'a str {
    if left.trim().is_empty() { right } else { left }
}

// `redact_error` / `redact_token_like_word` 实现 plan v3 U2b 已统一到
// `crate::redaction`；本文件继续通过 re-export 引用原名以避免大面积改 call site。
use crate::redaction::redact_error;

fn validate_prompt(prompt: &str) -> Result<(), String> {
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "输入过长，请控制在 {MAX_PROMPT_CHARS} 个字符以内。"
        ));
    }

    Ok(())
}

fn validate_context(context: Option<&str>) -> Result<(), String> {
    if context
        .map(|value| value.chars().count())
        .unwrap_or_default()
        > MAX_CONTEXT_CHARS
    {
        return Err(format!(
            "上下文过长，请控制在 {MAX_CONTEXT_CHARS} 个字符以内。"
        ));
    }

    Ok(())
}

fn create_run_id() -> String {
    format!(
        "agent-run-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    )
}

struct ClaudeAgentRunGuard;

impl ClaudeAgentRunGuard {
    fn acquire() -> Result<Self, String> {
        if CLAUDE_AGENT_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("智能助手正在处理上一条请求，请稍后再试。".to_string());
        }

        Ok(Self)
    }
}

impl Drop for ClaudeAgentRunGuard {
    fn drop(&mut self) {
        CLAUDE_AGENT_RUNNING.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worker_json_output() {
        let output = r#"{"assistantText":" 已生成规划说明 ","sessionId":"abc","stageResults":[{"stage":"topology"}]}"#;

        let parsed = parse_worker_output(output).expect("valid response");

        assert_eq!(parsed.assistant_text, "已生成规划说明");
        assert_eq!(parsed.session_id.as_deref(), Some("abc"));
        assert_eq!(parsed.stage_results.len(), 1);
        assert_eq!(parsed.stage_results[0]["stage"], "topology");
    }

    #[test]
    fn rejects_non_json_output() {
        let error = parse_worker_output("api_key=secret").expect_err("invalid output should fail");

        assert!(error.contains("非 JSON"));
        assert!(!error.contains("secret"));
    }

    #[test]
    fn parses_tool_call_worker_event_line() {
        let line = r#"{"event":"tool_call","runId":"run-1","toolCall":{"id":"toolu-1","name":"Bash","args":{"command":"ls"},"phase":"start"}}"#;

        let parsed: ClaudeWorkerEvent = serde_json::from_str(line).expect("valid event");

        assert_eq!(parsed.event, "tool_call");
        assert_eq!(parsed.run_id.as_deref(), Some("run-1"));
        let tool_call = parsed.tool_call.expect("tool_call present");
        assert_eq!(tool_call["id"], "toolu-1");
        assert_eq!(tool_call["phase"], "start");
    }

    #[test]
    fn existing_event_lines_parse_without_tool_call() {
        let chunk: ClaudeWorkerEvent =
            serde_json::from_str(r#"{"event":"chunk","runId":"run-1","text":"hi"}"#)
                .expect("chunk parses");
        assert!(chunk.tool_call.is_none());

        let done: ClaudeWorkerEvent = serde_json::from_str(
            r#"{"event":"done","runId":"run-1","assistantText":"ok","toolCalls":[{"id":"toolu-1"}]}"#,
        )
        .expect("done parses");
        assert!(done.tool_call.is_none());
        assert_eq!(done.tool_calls.len(), 1);
    }

    #[test]
    fn locates_development_worker() {
        let worker_path = find_worker_path(None).expect("worker exists in source tree");

        assert!(worker_path.ends_with("src-node/dist/claude-agent-worker.mjs"));
    }

    #[test]
    fn resolves_repo_root_for_development_dist_worker() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir.parent().expect("repo root");
        let worker_path = repo_root.join("src-node/dist/claude-agent-worker.mjs");

        assert_eq!(repo_root_from_worker(&worker_path), repo_root);
    }

    #[test]
    fn tauri_bundle_includes_all_stage_skill_resources() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir.parent().expect("repo root");
        let tauri_config_path = manifest_dir.join("tauri.conf.json");
        let tauri_config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(tauri_config_path).expect("tauri config"),
        )
        .expect("tauri config json");

        // skills 走整目录映射（R13）：新增 reference 不需要逐文件登记。
        let resources = tauri_config["bundle"]["resources"]
            .as_object()
            .expect("bundle resources map");
        assert_eq!(
            resources.get("../.claude/skills/").and_then(|v| v.as_str()),
            Some(".claude/skills/")
        );
        for source in resources.keys() {
            assert!(
                !source.starts_with("../.claude/skills/tsn-"),
                "stale per-file skill mapping: {source}"
            );
        }

        // package.json 已出厂移除（R1a），磁盘上不得回潮。
        assert!(
            !repo_root
                .join(".claude/skills/tsn-topology/package.json")
                .exists()
        );
        // 场景 reference 必须真实存在，目录映射才有内容可打包。
        assert!(
            repo_root
                .join(".claude/skills/tsn-topology/references/generic-tsn.md")
                .exists()
        );
        assert!(
            repo_root
                .join(".claude/skills/tsn-topology/references/aerospace-onboard.md")
                .exists()
        );
        // 拓扑 MCP server 随 app 打包（98fe8ab）：资源映射须包含它，打到 src-node/ 下。
        assert_eq!(
            resources
                .get("../src-node/dist/tsn-topology-server.mjs")
                .and_then(|v| v.as_str()),
            Some("src-node/tsn-topology-server.mjs")
        );
    }

    #[test]
    fn describe_topology_templates_returns_catalog() {
        let via_command = describe_topology_templates();
        assert_eq!(
            via_command,
            crate::topology_compute::describe_templates_catalog()
        );
        assert_eq!(via_command["templateCount"], 2);
    }

    #[test]
    fn rejects_long_prompt_before_starting_worker() {
        let long_prompt = "x".repeat(MAX_PROMPT_CHARS + 1);

        let error = validate_prompt(&long_prompt).expect_err("long prompt fails");

        assert!(error.contains("输入过长"));
    }

    /// 审计 P1#3：验证 process_group(0) + libc::kill(-pgid) 能连根端掉组长
    /// 之外的组成员——模拟 worker 超时时一并杀掉 SDK 拉起的 MCP child，
    /// 不让其成为继续持有 DB_RPC_TOKEN 的孤儿进程。
    #[test]
    fn process_group_kill_terminates_member_process() {
        // 组长 shell 后台起一个长命 sleep（模拟 MCP child），打印其 pid 后阻塞。
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 120 & echo $!; wait")
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn group leader");
        // process_group(0) 后组长即组员，pgid 等于其 pid。
        let pgid = child.id() as i32;

        // 读出组员 pid（read_line 读到换行即返回，不等 EOF）。
        let stdout = child.stdout.take().expect("stdout");
        let mut first_line = String::new();
        BufReader::new(stdout)
            .read_line(&mut first_line)
            .expect("read member pid");
        let member_pid: i32 = first_line.trim().parse().expect("member pid");

        // kill 前组员应存活（signal 0 探活：0 = 存在且有权限）。
        assert_eq!(
            unsafe { libc::kill(member_pid, 0) },
            0,
            "member should be alive before group kill"
        );

        // 向整个进程组发 SIGKILL：组长 + 组员一并端掉。
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        let _ = child.wait();

        // 轮询确认组员被回收（kill(pid,0) == -1 / ESRCH）。
        let mut dead = false;
        for _ in 0..100 {
            if unsafe { libc::kill(member_pid, 0) } == -1 {
                dead = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // 防御性收尾，避免极端情况下残留。
        unsafe {
            libc::kill(member_pid, libc::SIGKILL);
        }
        assert!(
            dead,
            "member ({member_pid}) must be killed via process-group SIGKILL"
        );
    }

    /// 起一个进程组（组长 sh + 子 sleep 当组员），返回 (child, pgid, member_pid)。
    /// 仿 process_group_kill_terminates_member_process 的搭法。
    #[cfg(unix)]
    fn spawn_test_process_group() -> (std::process::Child, i32, i32) {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 120 & echo $!; wait")
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn group leader");
        let pgid = child.id() as i32;
        let stdout = child.stdout.take().expect("stdout");
        let mut first_line = String::new();
        BufReader::new(stdout)
            .read_line(&mut first_line)
            .expect("read member pid");
        let member_pid: i32 = first_line.trim().parse().expect("member pid");
        (child, pgid, member_pid)
    }

    /// 轮询确认进程被回收（kill(pid,0) == -1 / ESRCH）。
    #[cfg(unix)]
    fn wait_until_dead(pid: i32) -> bool {
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } == -1 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[cfg(unix)]
    fn register(registry: &AgentWorkerRegistry, run_id: &str, pgid: i32) {
        registry
            .0
            .lock()
            .expect("registry mutex")
            .replace(ActiveWorker {
                run_id: run_id.to_string(),
                pgid,
            });
    }

    #[cfg(unix)]
    #[test]
    fn cancel_matching_run_id_kills_process_group() {
        let (mut child, pgid, member_pid) = spawn_test_process_group();
        let registry = AgentWorkerRegistry::default();
        register(&registry, "run-cancel", pgid);

        let killed = do_cancel(&registry, "run-cancel");
        let _ = child.wait();

        assert!(killed, "matching runId must report killed");
        assert!(
            wait_until_dead(member_pid),
            "member ({member_pid}) must be reaped via process-group SIGKILL"
        );
        assert!(
            registry.0.lock().expect("registry mutex").is_none(),
            "slot must be cleared after cancel"
        );
        unsafe {
            libc::kill(member_pid, libc::SIGKILL);
        }
    }

    #[cfg(unix)]
    #[test]
    fn cancel_mismatched_run_id_reports_false_and_spares_process() {
        let (mut child, pgid, member_pid) = spawn_test_process_group();
        let registry = AgentWorkerRegistry::default();
        register(&registry, "run-real", pgid);

        let killed = do_cancel(&registry, "run-WRONG");

        assert!(!killed, "mismatched runId must report not killed");
        assert!(
            registry.0.lock().expect("registry mutex").is_some(),
            "mismatched cancel must leave the registered worker in place"
        );
        assert_eq!(
            unsafe { libc::kill(member_pid, 0) },
            0,
            "member must stay alive when runId does not match"
        );
        // 收尾真杀，避免残留 sleep。
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn cancel_empty_registry_is_idempotent_false() {
        let registry = AgentWorkerRegistry::default();
        let killed = do_cancel(&registry, "anything");
        assert!(!killed, "empty registry cancel must report not killed");
        assert!(registry.0.lock().expect("registry mutex").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn kill_helper_skips_dead_process_group_via_liveness_probe() {
        // 起一个进程组再彻底杀掉并 reap，得到一个「已不存在」的 pgid。
        let (mut child, pgid, member_pid) = spawn_test_process_group();
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        let _ = child.wait();
        assert!(wait_until_dead(member_pid), "setup: group must be dead");

        // 对已退出的 pgid 调 helper：探活返回不存在 → 不发 SIGKILL、不 panic。
        kill_worker_process_group(&ActiveWorker {
            run_id: "stale".to_string(),
            pgid,
        });
    }

    #[cfg(unix)]
    #[test]
    fn registration_drop_on_already_cleared_slot_is_noop() {
        let registry = AgentWorkerRegistry::default();
        {
            let _registration = AgentWorkerRegistration::new(
                &registry,
                ActiveWorker {
                    run_id: "run-reap".to_string(),
                    pgid: 1,
                },
            );
            assert!(registry.0.lock().expect("registry mutex").is_some());
            // 模拟 reap 时同锁去注册。
            let _ = registry.0.lock().expect("registry mutex").take();
            assert!(registry.0.lock().expect("registry mutex").is_none());
            // _registration Drop 此处兜底再 take 一次（已 None）——不得 panic。
        }
        assert!(registry.0.lock().expect("registry mutex").is_none());
    }
}
