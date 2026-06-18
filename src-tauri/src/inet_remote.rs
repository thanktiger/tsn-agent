//! 第二批 U2：远端执行器——把 U1 产物 scp 到远端独立临时目录、ssh 跑 `inet`、收退出码与输出、
//! best-effort 清理。复用 `commands.rs` 进程纪律（结构化 argv / 超时 / 进程组杀 / 脱敏）。
//!
//! 设计：argv 构造 / 目录名 / 脱敏是纯函数（可单测，见 KTD8 注入防护）；真 ssh/scp 经
//! `RemoteRunner` trait 抽象（`SshRunner` 默认实现；测试注入 mock，真连留集成验收）。
//! 阶段无关（KTD4）：本模块只管「发送+跑+回收」，不含拓扑阶段语义，后续阶段可复用。

use std::io;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::inet_bundle::InetBundle;

/// 远端主机配置。本期固定 boss 那台（多主机/UI 配置 deferred）；密钥靠 ssh-agent，不存密码。
#[derive(Debug, Clone)]
pub struct RemoteConfig {
    pub host: String,
    pub user: String,
    pub remote_base_dir: String,
    pub inet_path: String,
    pub timeout: Duration,
}

impl RemoteConfig {
    /// 开发期固定远端（Tailscale）。可由环境变量覆盖，便于将来切本机/换主机。
    pub fn dev_default() -> Self {
        let host = std::env::var("TSN_AGENT_INET_HOST").unwrap_or_else(|_| "100.104.38.106".into());
        let user = std::env::var("TSN_AGENT_INET_USER").unwrap_or_else(|_| "zhang".into());
        let remote_base_dir = std::env::var("TSN_AGENT_INET_BASEDIR")
            .unwrap_or_else(|_| "/home/zhang/tsn-agent-runs".into());
        let inet_path = std::env::var("TSN_AGENT_INET_PATH")
            .unwrap_or_else(|_| "/home/zhang/.local/bin/inet".into());
        Self { host, user, remote_base_dir, inet_path, timeout: Duration::from_secs(120) }
    }
}

#[derive(Debug, Clone)]
pub struct RemoteRunOutcome {
    /// inet 退出码（None = 未取到，按不可达处理）。
    pub exit_code: Option<i32>,
    /// 脱敏 + 截断后的输出尾部，供错误文案。
    pub output_tail: String,
}

/// 远端执行失败分类——驱动 U3/U4「连不上(inet_unreachable)」vs「跑不起来(inet_load_failed)」分文案。
#[derive(Debug)]
pub enum RemoteError {
    /// 连不上 / 超时 / 传输失败 / 找不到 ssh —— 环境问题，非拓扑错。
    Unreachable(String),
}

pub trait RemoteRunner {
    /// 把 bundle 发到远端、跑 inet、收退出码与输出、清理。
    fn run_bundle(&self, bundle: &InetBundle, cfg: &RemoteConfig) -> Result<RemoteRunOutcome, RemoteError>;
}

// ---- 纯函数（可单测）：目录名 / argv / 脱敏 ----

/// 远端临时目录名只许 `[a-zA-Z0-9_-]`（KTD8：杜绝路径注入 / rm -rf 删错目录）。
pub fn is_safe_run_dir_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
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
        "-o".into(), "StrictHostKeyChecking=yes".into(),
        "-o".into(), "BatchMode=yes".into(),
        "-o".into(), "ConnectTimeout=10".into(),
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

/// 远端运行命令串：cd 到 bundle 目录跑 inet（路径 shell-quote，KTD8）。
pub fn remote_run_cmd(cfg: &RemoteConfig, remote_dir: &str) -> String {
    format!(
        "cd {} && {} -u Cmdenv -f omnetpp.ini -n .",
        sh_squote(remote_dir),
        sh_squote(&cfg.inet_path)
    )
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
    fn run_bundle(&self, bundle: &InetBundle, cfg: &RemoteConfig) -> Result<RemoteRunOutcome, RemoteError> {
        let ssh = resolve_remote_bin("ssh", "TSN_AGENT_SSH_PATH");
        let scp = resolve_remote_bin("scp", "TSN_AGENT_SCP_PATH");

        let dir_name = gen_run_dir_name();
        if !is_safe_run_dir_name(&dir_name) {
            return Err(RemoteError::Unreachable("run 目录名生成异常".into()));
        }
        let remote_dir = format!("{}/{}", cfg.remote_base_dir, dir_name);

        // 本地落盘 bundle（独立临时目录）。
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

        // 传输步骤（mkdir/scp）：spawn 失败、超时、或远端非零退出都归为「连不上」（环境问题）。
        let transport = |cmd: Command, what: &str| -> Result<(), RemoteError> {
            match run_with_timeout(cmd, cfg.timeout) {
                Ok(o) if o.status.success() => Ok(()),
                Ok(o) => Err(RemoteError::Unreachable(format!(
                    "{what}失败（退出码 {}）：{}",
                    o.status.code().map(|c| c.to_string()).unwrap_or_else(|| "未知".into()),
                    redact_remote(&String::from_utf8_lossy(&o.stderr), cfg)
                ))),
                Err(e) => Err(RemoteError::Unreachable(format!("{what}失败：{}", redact_remote(&e.to_string(), cfg)))),
            }
        };

        // 1) 远端建目录。
        let mkdir_cmd = format!("mkdir -p {}", sh_squote(&remote_dir));
        if let Err(e) = transport(make_cmd(&ssh, build_ssh_argv(cfg, &mkdir_cmd)), "连远端 / 建目录") {
            cleanup_local();
            return Err(e);
        }
        // 2) scp 传内容。
        let local_src = format!("{}/.", local_dir.display());
        if let Err(e) = transport(make_cmd(&scp, build_scp_argv(cfg, &local_src, &remote_dir)), "传输 bundle") {
            let _ = run_with_timeout(make_cmd(&ssh, build_ssh_argv(cfg, &remote_cleanup_cmd(&remote_dir))), cfg.timeout);
            cleanup_local();
            return Err(e);
        }
        // 3) 跑 inet。
        let run_res = run_with_timeout(make_cmd(&ssh, build_ssh_argv(cfg, &remote_run_cmd(cfg, &remote_dir))), cfg.timeout);
        // 4) best-effort 清理远端。
        let _ = run_with_timeout(make_cmd(&ssh, build_ssh_argv(cfg, &remote_cleanup_cmd(&remote_dir))), cfg.timeout);
        cleanup_local();

        match run_res {
            Ok(output) => {
                let code = output.status.code();
                let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
                combined.push_str(&String::from_utf8_lossy(&output.stderr));
                let redacted = redact_remote(&combined, cfg);
                // ssh 对自身传输失败（连不上 / 认证 / host key 未登记）保留退出码 255；
                // inet 真加载失败是 1..254。255 或拿不到退出码 → 判「连不上」，不诬陷拓扑。
                if code == Some(255) || code.is_none() {
                    return Err(RemoteError::Unreachable(format!(
                        "连不上远端 INET（ssh 退出码 {}）：{}",
                        code.map(|c| c.to_string()).unwrap_or_else(|| "未知".into()),
                        tail(&redacted, 2000)
                    )));
                }
                Ok(RemoteRunOutcome { exit_code: code, output_tail: tail(&redacted, 2000) })
            }
            Err(e) => Err(RemoteError::Unreachable(format!("远端运行 inet 失败：{}", redact_remote(&e.to_string(), cfg)))),
        }
    }
}

fn resolve_remote_bin(name: &str, env_override: &str) -> std::ffi::OsString {
    use std::ffi::OsString;
    use std::path::Path;
    if let Some(p) = std::env::var_os(env_override) {
        if !p.is_empty() && Path::new(&p).exists() {
            return p;
        }
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
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
                let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output();
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
    Ok(std::process::Output { status, stdout, stderr })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RemoteConfig {
        RemoteConfig {
            host: "100.104.38.106".into(),
            user: "zhang".into(),
            remote_base_dir: "/home/zhang/tsn-agent-runs".into(),
            inet_path: "/home/zhang/.local/bin/inet".into(),
            timeout: Duration::from_secs(120),
        }
    }

    #[test]
    fn ssh_argv_carries_security_opts_and_remote_cmd() {
        let argv = build_ssh_argv(&cfg(), &remote_run_cmd(&cfg(), "/home/zhang/tsn-agent-runs/run-ab"));
        assert!(argv.iter().any(|a| a == "StrictHostKeyChecking=yes"));
        assert!(argv.iter().any(|a| a == "BatchMode=yes"));
        assert!(argv.iter().any(|a| a == "zhang@100.104.38.106"));
        let last = argv.last().unwrap();
        assert!(last.contains("cd '/home/zhang/tsn-agent-runs/run-ab'"));
        assert!(last.contains("-u Cmdenv -f omnetpp.ini -n ."));
    }

    #[test]
    fn scp_argv_is_structured_with_recursive_and_dest() {
        let argv = build_scp_argv(&cfg(), "/tmp/tsn-inet-x/.", "/home/zhang/tsn-agent-runs/run-x");
        assert_eq!(argv[0], "-r");
        assert!(argv.iter().any(|a| a == "StrictHostKeyChecking=yes"));
        assert!(argv.last().unwrap().ends_with("zhang@100.104.38.106:/home/zhang/tsn-agent-runs/run-x"));
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
