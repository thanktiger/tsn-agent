//! 第二批 U2：远端执行器——把 U1 产物 scp 到远端独立临时目录、ssh 跑 `inet`、收退出码与输出、
//! best-effort 清理。复用 `commands.rs` 进程纪律（结构化 argv / 超时 / 进程组杀 / 脱敏）。
//!
//! 设计：argv 构造 / 目录名 / 脱敏是纯函数（可单测，见 KTD8 注入防护）；真 ssh/scp 经
//! `RemoteRunner` trait 抽象（`SshRunner` 默认实现；测试注入 mock，真连留集成验收）。
//! 阶段无关（KTD4）：本模块只管「发送+跑+回收」，不含拓扑阶段语义，后续阶段可复用。

use serde::{Deserialize, Serialize};
use std::io;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 远端主机 UI 可配置项（R20）：host/user/inet 路径。落 app_state KV（JSON）。
/// remote_base_dir 本期不进 UI（保持 env/默认）；base_dir 用户可编辑是 deferred。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InetHostConfig {
    pub host: String,
    pub user: String,
    /// INET 环境命令前缀（见 RemoteConfig.inet_env_cmd）；序列化为 `inetEnvCmd`。
    pub inet_env_cmd: String,
}

/// host/user 字符集校验（R20 + security-lens）：限 `[a-zA-Z0-9._-]`、非空。
/// 拦含空格/shell 元字符的值，防 `user@host` 拼进 ssh argv 被注入额外选项（如 `-o ProxyCommand=`）。
pub fn is_valid_host_or_user(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 远端执行器消费的 bundle 形状（三文件内容）。定义在执行器侧（inet_remote 保留），
/// 由 bundle 生成器（inet_sim_bundle）产出——这样删旧的 inet_bundle 不影响执行器。
#[derive(Debug, Clone)]
pub struct InetBundle {
    pub network_ned: String,
    pub omnetpp_ini: String,
    pub manifest_json: String,
}

/// 开发期默认 INET 环境命令前缀（真机校正 2026-06-26）：把任意命令丢进 opp_env 的
/// OMNeT++/INET 环境里跑（inet 与 opp_scavetool 都在该环境 PATH 上）。app 以
/// `<inet_env_cmd> -c '<cmd>'` 调用。源自 boss 那台的 `~/.local/bin/inet` wrapper。
const DEFAULT_INET_ENV_CMD: &str = "source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && /home/zhang/.local/bin/opp_env run inet-4.6.0 -w /home/zhang/inet-workspace --build-modes=release";

/// 远端主机配置。密钥靠 ssh-agent，不存密码。
#[derive(Debug, Clone)]
pub struct RemoteConfig {
    pub host: String,
    pub user: String,
    pub remote_base_dir: String,
    /// INET 环境命令前缀：以 `<inet_env_cmd> -c '<cmd>'` 在 OMNeT++/INET 环境里跑命令。
    /// 自用工具、信任用户：这是命令模板、直接执行，不做字符集校验（同 inet_path 的安全口径）。
    pub inet_env_cmd: String,
    pub timeout: Duration,
}

impl RemoteConfig {
    /// 开发期固定远端（Tailscale）。可由环境变量覆盖，便于将来切本机/换主机。
    pub fn dev_default() -> Self {
        let host = std::env::var("TSN_AGENT_INET_HOST").unwrap_or_else(|_| "100.104.38.106".into());
        let user = std::env::var("TSN_AGENT_INET_USER").unwrap_or_else(|_| "zhang".into());
        let remote_base_dir = std::env::var("TSN_AGENT_INET_BASEDIR")
            .unwrap_or_else(|_| "/home/zhang/tsn-agent-runs".into());
        let inet_env_cmd =
            std::env::var("TSN_AGENT_INET_ENV").unwrap_or_else(|_| DEFAULT_INET_ENV_CMD.into());
        Self {
            host,
            user,
            remote_base_dir,
            inet_env_cmd,
            timeout: Duration::from_secs(120),
        }
    }
}

/// 远端执行失败分类——驱动「连不上(inet_unreachable)」vs「跑不起来(inet_load_failed)」分文案。
#[derive(Debug)]
pub enum RemoteError {
    /// 连不上 / 超时 / 传输失败 / 找不到 ssh —— 环境问题，非拓扑错。
    Unreachable(String),
}

/// 软仿运行 + 结果取回产物（U3）：在 RemoteRunOutcome 之外多带回 scavetool 导出的 CSV。
/// `exit_code` 非 0 → inet 没跑成（caller 判 load_failed）、`csv` 为 None；
/// `exit_code`=0 但 `csv` 空/None → 结果为空（caller 判「结果为空」，不渲染收敛）。
#[derive(Debug, Clone)]
pub struct SimRunOutcome {
    pub exit_code: Option<i32>,
    pub output_tail: String,
    /// scavetool 导出的 timeChanged CSV 原文（成功且非空才 Some）。
    pub csv: Option<String>,
    /// scavetool 命令本身失败（非零退出/缺失/连接断）——区别于「跑成功但导出 0 行」，
    /// 让 caller 给出「工具未安装/执行失败」而非「recording 配置」的诊断（reliability/maintainability review）。
    pub scavetool_failed: bool,
}

pub trait RemoteRunner {
    /// 软仿（U3）：scp bundle → 跑 inet → 跑 opp_scavetool 导出 timeChanged CSV → cat 回传 → 清理。
    /// `scavetool_filter` 是 `opp_scavetool export -f` 的过滤表达式（由调用方构造、本函数 shell-quote）。
    fn run_sim_fetch_csv(
        &self,
        bundle: &InetBundle,
        cfg: &RemoteConfig,
        scavetool_filter: &str,
    ) -> Result<SimRunOutcome, RemoteError>;
}

/// 远端 scavetool 取数命令串：在 inet_env_cmd 的环境里（opp_scavetool 在该环境 PATH 上）
/// cd 进 run 目录、export timeChanged 到 CSV、再 cat 回传 stdout。filter/路径都过 sh_squote 防注入，
/// inner 整体再 sh_squote 作为 `-c` 单参（嵌套引号安全）。
pub fn remote_scavetool_cmd(
    cfg: &RemoteConfig,
    remote_dir: &str,
    scavetool_filter: &str,
) -> String {
    let inner = format!(
        "cd {} && opp_scavetool export -f {} -F CSV-R -o timechanged.csv results/*.vec >/dev/null 2>&1 && cat timechanged.csv",
        sh_squote(remote_dir),
        sh_squote(scavetool_filter)
    );
    format!("{} -c {}", cfg.inet_env_cmd, sh_squote(&inner))
}

// ---- 纯函数（可单测）：目录名 / argv / 脱敏 ----

/// 远端临时目录名只许 `[a-zA-Z0-9_-]`（KTD8：杜绝路径注入 / rm -rf 删错目录）。
pub fn is_safe_run_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 生成 run 目录名 `run-<16 hex>`，随机源不用时钟（避免碰撞 + 不可预测）。
pub fn gen_run_dir_name() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("run-{hex}")
}

fn ssh_security_opts() -> Vec<String> {
    vec![
        "-o".into(),
        "StrictHostKeyChecking=yes".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
    ]
}

/// ssh argv：跑一条远端命令（remote_cmd 作单个参数，远端 shell 解释；路径已在 remote_cmd 内单引号 quote）。
pub fn build_ssh_argv(cfg: &RemoteConfig, remote_cmd: &str) -> Vec<String> {
    let mut argv = ssh_security_opts();
    argv.push(format!("{}@{}", cfg.user, cfg.host));
    argv.push(remote_cmd.to_string());
    argv
}

/// scp argv：把本地目录内容递归传到远端目录。
pub fn build_scp_argv(cfg: &RemoteConfig, local_src: &str, remote_dir: &str) -> Vec<String> {
    let mut argv = vec!["-r".to_string()];
    argv.extend(ssh_security_opts());
    argv.push(local_src.to_string());
    argv.push(format!("{}@{}:{}", cfg.user, cfg.host, remote_dir));
    argv
}

/// shell 单引号转义：值内的 `'` 替换为 `'\''`，安全嵌进单引号串（KTD8）。
/// 即便 inet_path/base_dir 经 env 覆盖含特殊字符也不破坏远端命令。
fn sh_squote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 远端运行命令串：在 inet_env_cmd 的 OMNeT++/INET 环境里 cd 到 bundle 目录跑 inet。
/// inet 在该环境 PATH 上；inner 整体 sh_squote 后作为 `-c` 的单个参数（嵌套引号安全）。
pub fn remote_run_cmd(cfg: &RemoteConfig, remote_dir: &str) -> String {
    let inner = format!(
        "cd {} && inet -u Cmdenv -f omnetpp.ini -n .",
        sh_squote(remote_dir)
    );
    format!("{} -c {}", cfg.inet_env_cmd, sh_squote(&inner))
}

/// 远端清理命令串：rm -rf 受 is_safe 约束的 run 目录（调用方须先校验 dir 安全）。
pub fn remote_cleanup_cmd(remote_dir: &str) -> String {
    format!("rm -rf {}", sh_squote(remote_dir))
}

/// 脱敏：把主机 IP / 用户名 / 远端基目录定向替换为占位符，再交既有 redact_error。
/// 现有 `redact_secrets` 只挡 key=值/token，挡不住裸主机串（见计划 KTD1/U2）。
pub fn redact_remote(text: &str, cfg: &RemoteConfig) -> String {
    let mut s = text.to_string();
    if !cfg.remote_base_dir.is_empty() {
        s = s.replace(&cfg.remote_base_dir, "[remote-dir]");
    }
    let user_host = format!("{}@{}", cfg.user, cfg.host);
    s = s.replace(&user_host, "[remote-host]");
    if !cfg.host.is_empty() {
        s = s.replace(&cfg.host, "[remote-host]");
    }
    if !cfg.user.is_empty() {
        s = s.replace(&cfg.user, "[remote-user]");
    }
    crate::redaction::redact_error(&s)
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // 按字节切可能落在 UTF-8 多字节字符中间（中文 INET 日志会触发 panic）——向后挪到字符边界。
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

// ---- 真实现：SshRunner ----

pub struct SshRunner;

impl RemoteRunner for SshRunner {
    fn run_sim_fetch_csv(
        &self,
        bundle: &InetBundle,
        cfg: &RemoteConfig,
        scavetool_filter: &str,
    ) -> Result<SimRunOutcome, RemoteError> {
        let ssh = resolve_remote_bin("ssh", "TSN_AGENT_SSH_PATH");
        let scp = resolve_remote_bin("scp", "TSN_AGENT_SCP_PATH");

        let dir_name = gen_run_dir_name();
        if !is_safe_run_dir_name(&dir_name) {
            return Err(RemoteError::Unreachable("run 目录名生成异常".into()));
        }
        let remote_dir = format!("{}/{}", cfg.remote_base_dir, dir_name);

        let local_dir = std::env::temp_dir().join(format!("tsn-inet-{dir_name}"));
        let gen_dir = local_dir.join("tsnagent").join("generated");
        let write = || -> io::Result<()> {
            std::fs::create_dir_all(&gen_dir)?;
            std::fs::write(gen_dir.join("network.ned"), &bundle.network_ned)?;
            std::fs::write(local_dir.join("omnetpp.ini"), &bundle.omnetpp_ini)?;
            std::fs::write(local_dir.join("manifest.json"), &bundle.manifest_json)?;
            Ok(())
        };
        if let Err(e) = write() {
            return Err(RemoteError::Unreachable(format!("本地写 bundle 失败：{e}")));
        }
        let cleanup_local = || {
            let _ = std::fs::remove_dir_all(&local_dir);
        };
        let cleanup_remote = || {
            let _ = run_with_timeout(
                make_cmd(&ssh, build_ssh_argv(cfg, &remote_cleanup_cmd(&remote_dir))),
                cfg.timeout,
            );
        };

        let transport = |cmd: Command, what: &str| -> Result<(), RemoteError> {
            match run_with_timeout(cmd, cfg.timeout) {
                Ok(o) if o.status.success() => Ok(()),
                Ok(o) => Err(RemoteError::Unreachable(format!(
                    "{what}失败（退出码 {}）：{}",
                    o.status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "未知".into()),
                    redact_remote(&String::from_utf8_lossy(&o.stderr), cfg)
                ))),
                Err(e) => Err(RemoteError::Unreachable(format!(
                    "{what}失败：{}",
                    redact_remote(&e.to_string(), cfg)
                ))),
            }
        };

        // 1) 建目录 + 2) scp。
        let mkdir_cmd = format!("mkdir -p {}", sh_squote(&remote_dir));
        if let Err(e) = transport(
            make_cmd(&ssh, build_ssh_argv(cfg, &mkdir_cmd)),
            "连远端 / 建目录",
        ) {
            cleanup_local();
            return Err(e);
        }
        let local_src = format!("{}/.", local_dir.display());
        if let Err(e) = transport(
            make_cmd(&scp, build_scp_argv(cfg, &local_src, &remote_dir)),
            "传输 bundle",
        ) {
            cleanup_remote();
            cleanup_local();
            return Err(e);
        }

        // 3) 跑 inet。
        let run_res = run_with_timeout(
            make_cmd(&ssh, build_ssh_argv(cfg, &remote_run_cmd(cfg, &remote_dir))),
            cfg.timeout,
        );
        let inet_output = match run_res {
            Ok(o) => o,
            Err(e) => {
                cleanup_remote();
                cleanup_local();
                return Err(RemoteError::Unreachable(format!(
                    "远端运行 inet 失败：{}",
                    redact_remote(&e.to_string(), cfg)
                )));
            }
        };
        let code = inet_output.status.code();
        let mut combined = String::from_utf8_lossy(&inet_output.stdout).to_string();
        combined.push_str(&String::from_utf8_lossy(&inet_output.stderr));
        let redacted = redact_remote(&combined, cfg);
        if code == Some(255) || code.is_none() {
            cleanup_remote();
            cleanup_local();
            return Err(RemoteError::Unreachable(format!(
                "连不上远端 INET（ssh 退出码 {}）：{}",
                code.map(|c| c.to_string()).unwrap_or_else(|| "未知".into()),
                tail(&redacted, 2000)
            )));
        }
        // inet 非 0 退出 → load_failed：不取数，回 csv=None 让 caller 分型。
        if code != Some(0) {
            cleanup_remote();
            cleanup_local();
            return Ok(SimRunOutcome {
                exit_code: code,
                output_tail: tail(&redacted, 2000),
                csv: None,
                scavetool_failed: false,
            });
        }

        // 4) scavetool 导出 timeChanged CSV 并 cat 回传。
        // 区分「命令失败」（非零退出/缺失/断连）与「成功但导出 0 行」——前者 scavetool_failed=true。
        let (csv, scavetool_failed) = match run_with_timeout(
            make_cmd(
                &ssh,
                build_ssh_argv(
                    cfg,
                    &remote_scavetool_cmd(cfg, &remote_dir, scavetool_filter),
                ),
            ),
            cfg.timeout,
        ) {
            Ok(o) if o.status.success() => {
                let out = String::from_utf8_lossy(&o.stdout).to_string();
                if out.trim().is_empty() {
                    (None, false) // 跑成功但无 timeChanged 行 → 真·结果为空
                } else {
                    (Some(out), false)
                }
            }
            // scavetool 非零退出/缺失/断连 → 命令失败（与结果为空区分）。
            _ => (None, true),
        };

        // 5) best-effort 清理。
        cleanup_remote();
        cleanup_local();

        Ok(SimRunOutcome {
            exit_code: code,
            output_tail: tail(&redacted, 2000),
            csv,
            scavetool_failed,
        })
    }
}

fn resolve_remote_bin(name: &str, env_override: &str) -> std::ffi::OsString {
    use std::ffi::OsString;
    use std::path::Path;
    if let Some(p) = std::env::var_os(env_override)
        && !p.is_empty()
        && Path::new(&p).exists()
    {
        return p;
    }
    for c in [
        format!("/usr/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/opt/homebrew/bin/{name}"),
    ] {
        if Path::new(&c).exists() {
            return OsString::from(c);
        }
    }
    OsString::from(name)
}

fn make_cmd(bin: &std::ffi::OsString, args: Vec<String>) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    cmd
}

/// spawn + 轮询超时 + 到时进程组杀（Unix kill(-pgid) / Windows taskkill /T）。
/// stdout/stderr 由两个后台线程**持续排空**（对齐 commands.rs spawn_line_reader 纪律）——
/// 否则远端输出超过 OS pipe buffer（~64KB）时子进程会阻塞在 write、永不退出、死锁到超时。
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> io::Result<std::process::Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;
    let pid = child.id();

    // 并发排空，防 pipe 写满阻塞。
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = stdout.as_mut() {
            let _ = std::io::Read::read_to_end(s, &mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = stderr.as_mut() {
            let _ = std::io::Read::read_to_end(s, &mut buf);
        }
        buf
    });

    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() > timeout {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .output();
            }
            let _ = child.wait();
            let _ = out_handle.join();
            let _ = err_handle.join();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "远端命令超时"));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    // 进程已退出 → pipe EOF，读线程随即结束。
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RemoteConfig {
        RemoteConfig {
            host: "100.104.38.106".into(),
            user: "zhang".into(),
            remote_base_dir: "/home/zhang/tsn-agent-runs".into(),
            inet_env_cmd: "OPPENV run inet-4.6.0 --build-modes=release".into(),
            timeout: Duration::from_secs(120),
        }
    }

    #[test]
    fn ssh_argv_carries_security_opts_and_remote_cmd() {
        let argv = build_ssh_argv(
            &cfg(),
            &remote_run_cmd(&cfg(), "/home/zhang/tsn-agent-runs/run-ab"),
        );
        assert!(argv.iter().any(|a| a == "StrictHostKeyChecking=yes"));
        assert!(argv.iter().any(|a| a == "BatchMode=yes"));
        assert!(argv.iter().any(|a| a == "zhang@100.104.38.106"));
        let last = argv.last().unwrap();
        // inet 在 inet_env_cmd 环境里跑：`<env> -c '<inner>'`，inner 含 cd run 目录 + inet。
        assert!(last.starts_with("OPPENV run inet-4.6.0 --build-modes=release -c "));
        assert!(last.contains("run-ab"));
        assert!(last.contains("inet -u Cmdenv -f omnetpp.ini -n ."));
    }

    #[test]
    fn scavetool_cmd_runs_in_inet_env() {
        // 取数也走 inet_env_cmd 环境（opp_scavetool 在该环境 PATH 上）；filter 经 sh_squote。
        let cmd = remote_scavetool_cmd(
            &cfg(),
            "/home/zhang/tsn-agent-runs/run-x",
            "name=~timeChanged",
        );
        assert!(cmd.starts_with("OPPENV run inet-4.6.0 --build-modes=release -c "));
        assert!(cmd.contains("opp_scavetool export -f"));
        assert!(cmd.contains("cat timechanged.csv"));
    }

    #[test]
    fn scp_argv_is_structured_with_recursive_and_dest() {
        let argv = build_scp_argv(
            &cfg(),
            "/tmp/tsn-inet-x/.",
            "/home/zhang/tsn-agent-runs/run-x",
        );
        assert_eq!(argv[0], "-r");
        assert!(argv.iter().any(|a| a == "StrictHostKeyChecking=yes"));
        assert!(
            argv.last()
                .unwrap()
                .ends_with("zhang@100.104.38.106:/home/zhang/tsn-agent-runs/run-x")
        );
    }

    #[test]
    fn run_dir_name_is_safe() {
        let n = gen_run_dir_name();
        assert!(is_safe_run_dir_name(&n));
        assert!(n.starts_with("run-"));
        assert!(!is_safe_run_dir_name("../etc"));
        assert!(!is_safe_run_dir_name("a b"));
        assert!(!is_safe_run_dir_name(""));
    }

    #[test]
    fn cleanup_cmd_targets_only_run_dir() {
        let cmd = remote_cleanup_cmd("/home/zhang/tsn-agent-runs/run-deadbeef");
        assert!(cmd.starts_with("rm -rf '"));
        assert!(cmd.contains("/run-deadbeef"));
    }

    #[test]
    fn redact_strips_bare_host_user_dir() {
        let raw = "ssh zhang@100.104.38.106 failed at /home/zhang/tsn-agent-runs/run-x";
        let out = redact_remote(raw, &cfg());
        assert!(!out.contains("100.104.38.106"));
        assert!(!out.contains("/home/zhang/tsn-agent-runs"));
        assert!(out.contains("[remote-host]") || out.contains("[remote-dir]"));
    }

    #[test]
    fn tail_is_char_boundary_safe_on_multibyte() {
        // 远超 max 的多字节中文串：按字节切会落在字符中间 panic，char-boundary 版不会。
        let s = "网络拓扑".repeat(300);
        let t = tail(&s, 50); // 不 panic 即通过；String 本身保证合法 UTF-8。
        assert!(t.starts_with('…'));
    }

    #[test]
    fn inet_host_config_uses_camelcase_inet_env_cmd() {
        // 前端 get/set_inet_host_config 读 inetEnvCmd（camelCase），非 inet_env_cmd。
        let cfg = InetHostConfig {
            host: "h".into(),
            user: "u".into(),
            inet_env_cmd: "opp_env run inet-4.6.0".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        assert!(v.get("inetEnvCmd").is_some(), "inetEnvCmd camelCase");
        assert!(v.get("inet_env_cmd").is_none());
        // 回程：前端发 camelCase → 反序列化回结构。
        let back: InetHostConfig =
            serde_json::from_str(r#"{"host":"h2","user":"u2","inetEnvCmd":"x"}"#).unwrap();
        assert_eq!(back.inet_env_cmd, "x");
    }

    #[test]
    fn host_user_validation_rejects_injection_chars() {
        assert!(is_valid_host_or_user("100.104.38.106"));
        assert!(is_valid_host_or_user("zhang"));
        assert!(is_valid_host_or_user("dev-box_1"));
        assert!(!is_valid_host_or_user("")); // 空
        assert!(!is_valid_host_or_user("zhang -o ProxyCommand=x")); // 空格 + 选项注入
        assert!(!is_valid_host_or_user("a;rm -rf")); // shell 元字符
        assert!(!is_valid_host_or_user("a@b")); // @ 不允许
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_captures_output_and_exit_code() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "printf hello; exit 3"]);
        let out = run_with_timeout(cmd, Duration::from_secs(5)).unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello");
    }
}
