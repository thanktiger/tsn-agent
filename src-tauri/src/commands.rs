use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};
use tauri::{path::BaseDirectory, Emitter, Manager};

const MAX_PROMPT_CHARS: usize = 4_000;
const MAX_CONTEXT_CHARS: usize = 12_000;
const CLAUDE_BRIDGE_SYNC_TIMEOUT: Duration = Duration::from_secs(300);
static CLAUDE_AGENT_RUNNING: AtomicBool = AtomicBool::new(false);

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
    audit_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeWorkerResponse {
    assistant_text: String,
    session_id: Option<String>,
    #[serde(default)]
    stage_results: Vec<serde_json::Value>,
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
    audit_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAgentEventPayload {
    run_id: String,
    kind: String,
    text: Option<String>,
    session_id: Option<String>,
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
    let worker_path = find_worker_path(Some(&app))?;
    let cwd = repo_root_from_worker(&worker_path);
    let run_id = request.run_id.clone().unwrap_or_else(create_run_id);
    let app_session_id = request.app_session_id.clone();
    let audit_dir = agent_audit_dir(&app);
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
        }),
    );
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

    let mut child = Command::new("node")
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
        // 审计 P1#3：worker 独立进程组（pgid = worker pid），超时可 kill(-pgid)
        // 连根端掉 SDK 拉起的 MCP child，避免孤儿进程继续持有 DB_RPC_TOKEN。
        .process_group(0)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| {
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
    // process_group(0) 后 worker 是组长，pgid 等于其 pid。
    let worker_pgid = child.id() as i32;
    let started_at = Instant::now();
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
            Ok(Some(_status)) => break,
            Ok(None) if started_at.elapsed() > CLAUDE_BRIDGE_SYNC_TIMEOUT => {
                // 向整个进程组发 SIGKILL：worker + SDK 拉起的 MCP child 一并端掉，
                // 避免孤儿进程继续持有 sidecar 的 DB_RPC_TOKEN（审计 P1#3）。
                unsafe {
                    libc::kill(-worker_pgid, libc::SIGKILL);
                }
                let _ = child.wait();
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
                ))
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
        let error_summary = redact_error(&first_non_empty(
            &stderr,
            "智能助手运行时未返回最终结果。",
        ));
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
        return Err(format!("智能助手运行时执行失败：{}", error_summary));
    }

    let final_response = response
        .or_else(|| parse_worker_output(&stdout).ok())
        .ok_or_else(|| {
            format!(
                "智能助手运行时没有返回最终结果：{}",
                redact_error(&stdout)
            )
        })?;

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
    let parsed: ClaudeWorkerResponse = serde_json::from_str(final_line.trim()).map_err(|_| {
        format!(
            "智能助手运行时返回了非 JSON 输出：{}",
            redact_error(stdout)
        )
    })?;
    let assistant_text = parsed.assistant_text.trim().to_string();

    if assistant_text.is_empty() {
        return Err("智能助手运行时没有返回可展示内容。".to_string());
    }

    Ok(ClaudeAgentResponse {
        assistant_text,
        session_id: parsed.session_id,
        stage_results: parsed.stage_results,
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
        stdout_lines.push(trimmed);
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
    let parsed: ClaudeWorkerEvent = serde_json::from_str(line).map_err(|_| {
        format!(
            "智能助手运行时返回了非 JSON 输出：{}",
            redact_error(line)
        )
    })?;
    let run_id = parsed.run_id.unwrap_or_else(|| fallback_run_id.to_string());

    match parsed.event.as_str() {
        "chunk" => {
            let text = parsed.text.unwrap_or_default();
            if !text.is_empty() {
                emit_claude_event(app, &run_id, "chunk", Some(text), None);
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
            emit_claude_event(app, &run_id, "session", None, parsed.session_id);
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
) {
    let _ = app.emit(
        "claude-agent-event",
        ClaudeAgentEventPayload {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            text,
            session_id,
        },
    );
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

    if let Some(app) = app {
        if let Ok(resource_path) = app
            .path()
            .resolve("src-node/claude-agent-worker.mjs", BaseDirectory::Resource)
        {
            if resource_path.exists() {
                return Ok(resource_path);
            }
        }
    }

    if development_worker_path.exists() {
        return Ok(development_worker_path);
    }

    Err(format!(
        "未找到智能助手运行时 worker：{}。请先运行 npm run build:worker。",
        development_worker_path.display()
    ))
}

fn repo_root_from_worker(worker_path: &Path) -> PathBuf {
    if worker_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        == Some("dist")
    {
        if let Some(repo_root) = worker_path.parent().and_then(Path::parent).and_then(Path::parent) {
            return repo_root.to_path_buf();
        }
    }

    worker_path
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn first_non_empty<'a>(left: &'a str, right: &'a str) -> &'a str {
    if left.trim().is_empty() {
        right
    } else {
        left
    }
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
        let tauri_config_path = manifest_dir.join("tauri.conf.json");
        let tauri_config = std::fs::read_to_string(tauri_config_path).expect("tauri config");

        assert!(tauri_config.contains("../.claude/skills/tsn-topology/SKILL.md"));
        assert!(tauri_config.contains("../.claude/skills/tsn-topology/package.json"));
        assert!(tauri_config.contains("../.claude/skills/tsn-topology/docs/rules.md"));
        assert!(tauri_config.contains("../.claude/skills/tsn-flow-planning/SKILL.md"));
        // legacy builder 脚本闭包已下线，不应再打包（topology 参数事实源收口）。
        assert!(!tauri_config.contains("../.claude/skills/tsn-topology/tools/topology-builder.js"));
        assert!(
            !tauri_config.contains("../.claude/skills/tsn-topology/tools/run-topology-skill.js")
        );
        assert!(!tauri_config.contains("../.claude/skills/tsn-topology/tools/validate-topology.js"));
        assert!(!tauri_config
            .contains("../.claude/skills/tsn-topology/tools/validate-mac-forwarding-table.js"));
        assert!(!tauri_config.contains(
            "../.claude/skills/tsn-topology/tools/render-mac-forwarding-html.js"
        ));
        assert!(!tauri_config.contains("../src-node/dist/tsn-topology-server.mjs"));
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
}
