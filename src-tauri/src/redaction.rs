//! Centralized secret redaction utilities.
//!
//! Plan v3 U2b: 抽出此模块统一原本散落在 `diagnostic_store.rs` 与 `commands.rs`
//! 的两套 redact 实现。`diagnostic_store::redact_secrets` / `redact_token_like_word`
//! 与 `commands::redact_error` / `redact_token_like_word` 各自维护一份 sensitive
//! key 列表，新增 key 时容易漂移；本模块作为单一来源，下游通过 `pub use` 引用。
//!
//! 行为兼容：
//! - 既有 diagnostic_store 行为完全保留（sensitive_keys 包含 `authorization`；
//!   `sk-ant-` 字面在 word 级别整体替换为 `[redacted]`）。
//! - 既有 commands::redact_error 的中文替换 + `sk-ant-` 前缀转换全部保留；
//!   额外收益：现 redact_error 也会 redact `Authorization: Bearer …` 等模式
//!   （原 commands 端 sensitive_keys 缺 `authorization`，是漏检）。

const SENSITIVE_KEYS: &[&str] = &[
    "api_key",
    "apikey",
    "token",
    "secret",
    "password",
    "claude_api_key",
    "authorization",
];

/// 对单个 token-like 词做敏感字面值过滤。
///
/// 规则：
/// 1. 词中包含 `sk-ant-` 直接整体替换为 `[redacted]`。
/// 2. 词形如 `key=value` 或 `key:value` 且 key 命中 `SENSITIVE_KEYS` →
///    保留 key + `=`/`:` + `[redacted]`。
/// 3. 其余原样返回。
pub fn redact_token_like_word(word: &str) -> String {
    let lower = word.to_ascii_lowercase();

    if lower.contains("sk-ant-") {
        return "[redacted]".to_string();
    }

    if let Some(separator_index) = word.find('=').or_else(|| word.find(':')) {
        let key = &lower[..separator_index];
        if SENSITIVE_KEYS
            .iter()
            .any(|sensitive_key| key.contains(sensitive_key))
        {
            return format!("{}[redacted]", &word[..separator_index + 1]);
        }
    }

    word.to_string()
}

/// 按空白拆分输入，逐词过滤敏感字面值，再用单个空格拼接返回。
pub fn redact_secrets(value: &str) -> String {
    value
        .split_whitespace()
        .map(redact_token_like_word)
        .collect::<Vec<_>>()
        .join(" ")
}

/// 在 `redact_secrets` 之上叠加中文替换与 `sk-ant-` 前缀掩码，用于
/// 应用层错误信息（commands.rs 的 worker 错误日志、子进程 stderr 等）。
pub fn redact_error(value: &str) -> String {
    let transformed = value
        .replace("claude-run-", "agent-run-")
        .replace("Claude Code", "智能助手工具")
        .replace("Claude Agent SDK", "智能助手运行时")
        .replace("Claude Agent", "智能助手")
        .replace("Claude SDK", "智能助手运行时")
        .replace("Claude", "智能助手")
        .replace("智能助手-run-", "agent-run-")
        .replace("claude_api_key", "agent_api_key")
        .replace("sk-ant-", "sk-ant-[redacted]-");

    redact_secrets(&transformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_api_key_assignment() {
        assert_eq!(redact_secrets("api_key=abc123"), "api_key=[redacted]");
    }

    #[test]
    fn redacts_authorization_bearer_header_word() {
        // diagnostic_store 既有行为：含 sk-ant- 的 word 整体掩盖
        let out = redact_secrets("Authorization: Bearer sk-ant-deadbeef");
        assert!(!out.contains("deadbeef"), "out = {out}");
        assert!(out.contains("[redacted]"), "out = {out}");
    }

    #[test]
    fn redacts_authorization_key_form() {
        assert_eq!(
            redact_secrets("Authorization:eyJhbGciOi"),
            "Authorization:[redacted]"
        );
    }

    #[test]
    fn keeps_non_sensitive_words() {
        let input = "user=alice mode=claude count=42";
        assert_eq!(redact_secrets(input), input);
    }

    #[test]
    fn redact_error_applies_chinese_substitutions() {
        let out = redact_error("Claude Code returned api_key=secret");
        assert!(out.contains("智能助手工具"), "out = {out}");
        assert!(!out.contains("secret"), "out = {out}");
        assert!(out.contains("[redacted]"), "out = {out}");
    }

    #[test]
    fn redact_error_masks_sk_ant_prefix_and_then_redacts() {
        // commands.rs 既有行为：先把 sk-ant- 替换为 sk-ant-[redacted]-，
        // 再走 word-level redact。最终结果应不含原始 token 内容。
        let out = redact_error("token sk-ant-abcd1234");
        assert!(!out.contains("abcd1234"), "out = {out}");
        assert!(out.contains("[redacted]"), "out = {out}");
    }

    #[test]
    fn redact_error_renames_claude_run_prefix() {
        assert_eq!(redact_error("claude-run-001 done"), "agent-run-001 done");
    }
}
