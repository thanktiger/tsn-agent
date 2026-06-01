use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
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
    let payload = serde_json::json!({
        "prompt": request.prompt,
        "cwd": cwd,
        "runId": run_id,
        "appSessionId": request.app_session_id,
        "auditDir": audit_dir,
        "resumeSessionId": request.resume_session_id,
        "conversationContext": request.conversation_context,
        "stageRunnerInput": request.stage_runner_input,
    })
    .to_string();

    let mut child = Command::new("node")
        .arg(&worker_path)
        .arg(payload)
        .current_dir(cwd)
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
                let _ = child.kill();
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
    let pool = match tauri::async_runtime::block_on(crate::session_store::connect_app_database(app))
    {
        Ok(pool) => pool,
        Err(_) => return,
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

    let _ = tauri::async_runtime::block_on(crate::diagnostic_store::append_diagnostic_log_entry(
        &pool, entry,
    ));
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

fn redact_error(value: &str) -> String {
    value
        .replace("claude-run-", "agent-run-")
        .replace("Claude Code", "智能助手工具")
        .replace("Claude Agent SDK", "智能助手运行时")
        .replace("Claude Agent", "智能助手")
        .replace("Claude SDK", "智能助手运行时")
        .replace("Claude", "智能助手")
        .replace("智能助手-run-", "agent-run-")
        .replace("claude_api_key", "agent_api_key")
        .replace("sk-ant-", "sk-ant-[redacted]-")
        .split_whitespace()
        .map(redact_token_like_word)
        .collect::<Vec<_>>()
        .join(" ")
}

fn redact_token_like_word(word: &str) -> String {
    let lower = word.to_ascii_lowercase();
    let sensitive_keys = [
        "api_key",
        "apikey",
        "token",
        "secret",
        "password",
        "claude_api_key",
    ];

    if let Some(separator_index) = word.find('=').or_else(|| word.find(':')) {
        let key = &lower[..separator_index];

        if sensitive_keys
            .iter()
            .any(|sensitive_key| key.contains(sensitive_key))
        {
            return format!("{}[redacted]", &word[..separator_index + 1]);
        }
    }

    word.to_string()
}

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
        assert!(tauri_config.contains("../.claude/skills/tsn-topology/tools/topology-builder.js"));
        assert!(tauri_config
            .contains("../.claude/skills/tsn-topology/tools/validate-topology.js"));
        assert!(tauri_config.contains(
            "../.claude/skills/tsn-topology/tools/validate-mac-forwarding-table.js"
        ));
        assert!(!tauri_config.contains(
            "../.claude/skills/tsn-topology/tools/render-mac-forwarding-html.js"
        ));
        assert!(
            tauri_config.contains("../.claude/skills/tsn-topology/tools/run-topology-skill.js")
        );
        assert!(tauri_config.contains("../.claude/skills/tsn-flow-planning/SKILL.md"));
        assert!(!tauri_config.contains("../src-node/dist/tsn-topology-server.mjs"));
    }

    #[test]
    fn rejects_long_prompt_before_starting_worker() {
        let long_prompt = "x".repeat(MAX_PROMPT_CHARS + 1);

        let error = validate_prompt(&long_prompt).expect_err("long prompt fails");

        assert!(error.contains("输入过长"));
    }
}
