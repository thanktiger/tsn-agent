//! 历代出厂 skill 文件哈希（R1）与出厂移除清单（R1a）。
//!
//! 锚定判据是「上一个执行过播种的构建」：v0.4.1 无播种机制（野外无 app-data
//! 副本），唯一真实的旧出厂副本来自 feat/release-writable-skill 构建，其播种
//! 内容 = 下表第一组（提取自 commit 33a28d9 时点的仓库文件）；v0.4.1（89d5412）
//! 内容哈希作无害冗余收录。
//!
//! 发版 checklist：每次发布把当期出厂文件的 (路径, sha256) 追加到此表（旧值
//! 永不删除），使后续版本能把「未编辑的旧出厂文件」静默升级为新内容。

/// 历代出厂内容 (skills 根相对路径, sha256 hex 小写)。同路径命中即视为
/// 「未被用户编辑的出厂内容」；按路径分键防跨文件碰撞误判（用户把 A 文件的
/// 旧出厂内容贴进 B 文件不得被静默覆写）。
pub const HISTORICAL_FACTORY_HASHES: &[(&str, &str)] = &[
    // —— feat/release-writable-skill 播种内容（33a28d9）——
    (
        // 单体版（场景拆分前）
        "tsn-topology/SKILL.md",
        "6daa182bcd7ed3a73cb561542218024f2fdf23e247c1b1ac4bb2d7f782702a81",
    ),
    (
        // {"type":"commonjs"} 残留
        "tsn-topology/package.json",
        "8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a",
    ),
    (
        "tsn-flow-planning/SKILL.md",
        "ff9c769f446f80ed60d10197260653189d7273d1307a6b402c826c9ed05f1b35",
    ),
    // —— v0.4.1（89d5412，无播种机制——冗余）——
    (
        "tsn-topology/SKILL.md",
        "1877437bff27e8e030d991b1235fdfbdb5172828dac443388727c5ab46763507",
    ),
];

/// 出厂移除清单（R1a）：新出厂布局已删除的文件（skills 根相对路径）。
/// 哈希命中历代出厂值的孤儿随播种/恢复删除；用户改过的孤儿保留。
pub const FACTORY_REMOVED_FILES: &[&str] = &["tsn-topology/package.json"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn historical_hashes_are_wellformed_and_unique() {
        // 发版 checklist 人工追加的廉价格式守卫：64 位小写 hex、(路径,哈希) 对唯一。
        let mut seen = std::collections::BTreeSet::new();
        for (path, hash) in HISTORICAL_FACTORY_HASHES {
            assert_eq!(hash.len(), 64, "{path} 哈希长度必须 64");
            assert!(
                hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
                "{path} 哈希必须为小写 hex"
            );
            assert!(!path.is_empty() && !path.starts_with('/') && !path.contains(".."));
            assert!(seen.insert((path, hash)), "重复条目：{path}");
        }
    }
}
