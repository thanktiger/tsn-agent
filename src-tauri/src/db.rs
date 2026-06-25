pub const DATABASE_URL: &str = "sqlite:tsn-agent.db";

/// Schema-version 1：sessions / app_state（U_R5 后 `diagnostic_logs` 已迁出 sqlite，
/// 改由文件 jsonl 存储；旧 v1 db 通过 v3 migration 自动 `DROP TABLE`）。
pub const SESSION_SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        has_project INTEGER NOT NULL DEFAULT 0,
        project_name TEXT,
        bundle_file_count INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
        ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
"#;

/// V1 历史 schema：fresh dev db 之前会含 `diagnostic_logs` 表 + 两个索引。
/// 仅供 v1 → v3 升级路径上对老 db 的 `DROP TABLE` 兜底逻辑测试参考（仅测试构建编译）。
#[cfg(test)]
pub const LEGACY_DIAGNOSTIC_LOGS_DDL: &str = r#"
    CREATE TABLE IF NOT EXISTS diagnostic_logs (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        run_id TEXT,
        duration_ms INTEGER,
        details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_session_created_at
        ON diagnostic_logs(session_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_session_category
        ON diagnostic_logs(session_id, category);
"#;

/// Schema-version 2：拓扑权威表 topology_nodes / topology_links + 单步撤销
/// pre-image 表 topology_undo_snapshots。
///
/// （migration v2 历史上建过 13 张 node.* / topo_feature_links / topology_refs
/// 空壳表，从未有业务写入；2026-06-24 随 migration v6 一并 DROP，见下方迁移向量。）
///
/// 字段 NULLABLE 取舍依据 Spike A 报告：
/// - topology_nodes.node_type：BFE fixture 不含 → NULLABLE
/// - topology_links.name：BFE fixture 不含 → NULLABLE
///
/// `application_id` 在本 migration 末尾设置（dev db v1→v2 升级时自动 set）。
pub const P0_DOMAIN_SCHEMA_SQL: &str = r#"
    -- topology.json (2 tables)
    CREATE TABLE IF NOT EXISTS topology_nodes (
        session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        -- 节点逻辑序号（规划器/MAC 表的节点身份，如 "0"/"1"/"2"）：每会话唯一，作主键。
        mid           TEXT    NOT NULL,
        -- 逻辑节点名（如 ES-1）：initialize 落库写入，画布显示优先用它；
        -- NULLABLE——apply_operations 增量节点与历史数据回退派生名。
        name          TEXT,
        x             REAL    NOT NULL,
        y             REAL    NOT NULL,
        node_type     TEXT,
        -- mac/ip：NULLABLE，U1 留空，U3 确定性分配器回填。
        mac           TEXT,
        ip            TEXT,
        -- 端口/队列数：DEFAULT 8。
        port_count    INTEGER NOT NULL DEFAULT 8,
        queue_count   INTEGER NOT NULL DEFAULT 8,
        insert_order  INTEGER NOT NULL,
        PRIMARY KEY (session_id, mid)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_nodes_session
        ON topology_nodes(session_id, insert_order);

    CREATE TABLE IF NOT EXISTS topology_links (
        session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        link_seq       INTEGER NOT NULL,
        name           TEXT,
        src_node       TEXT    NOT NULL,
        dst_node       TEXT    NOT NULL,
        -- 端口/速率从 styles_json 拆出的独立列（NULLABLE；role/plane 仍留 styles_json）。
        src_port       INTEGER,
        dst_port       INTEGER,
        speed          INTEGER,
        styles_json    TEXT    NOT NULL,
        PRIMARY KEY (session_id, link_seq)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_links_session
        ON topology_links(session_id, src_node, dst_node);

    -- 单步撤销 pre-image blob（按 (session_id, domain) 覆盖式只留一份，
    -- ON DELETE CASCADE 随 session 删除清快照）。本机临时状态，不进
    -- SESSION_SCOPED_TABLES（不随 session 导出/导入）。
    CREATE TABLE IF NOT EXISTS topology_undo_snapshots (
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        domain      TEXT NOT NULL,
        blob_json   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (session_id, domain)
    );

    -- 时钟同步：单域配置（一 session 一行）。gm_mid 逻辑上引用
    -- topology_nodes.mid，但不写跨表 FK（应用层校验，照项目惯例）；FK 只到
    -- sessions（ON DELETE CASCADE）。disabled_link_seqs 是禁用链路 link_seq
    -- 集的 JSON 数组串。取值域校验在 zod + Rust，DB 不写 CHECK。
    CREATE TABLE IF NOT EXISTS timesync_domain (
        session_id          TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        gm_mid              TEXT,
        one_step_mode       INTEGER NOT NULL DEFAULT 0,
        fre_switch          INTEGER NOT NULL DEFAULT 0,
        disabled_link_seqs  TEXT    NOT NULL DEFAULT '[]',
        PRIMARY KEY (session_id)
    );

    -- 时钟同步：每节点端口角色 + 同步参数。master_port/slave_port/
    -- port_ptp_enabled 是端口号数组的 JSON 串（确定性衍生、全量覆盖写）。
    -- mid 逻辑上引用 topology_nodes.mid，不写跨表 FK。
    CREATE TABLE IF NOT EXISTS timesync_nodes (
        session_id              TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        mid                     TEXT    NOT NULL,
        master_port             TEXT    NOT NULL DEFAULT '[]',
        slave_port              TEXT    NOT NULL DEFAULT '[]',
        port_ptp_enabled        TEXT    NOT NULL DEFAULT '[]',
        sync_period             INTEGER,
        measure_period          INTEGER,
        report_enable           INTEGER,
        mean_link_delay_thresh  INTEGER,
        offset_threshold        INTEGER,
        PRIMARY KEY (session_id, mid)
    );

    PRAGMA application_id = 1414745601;  -- 0x54534E01 ("TSN\x01")
"#;

/// `connect_app_database` 内 safety-net 用：v1 + v2 schema 的 `CREATE IF NOT EXISTS`
/// + v3 `DROP diagnostic_logs` + v6 `DROP` 废弃空壳表，均幂等。
pub fn safety_net_schema_sql() -> String {
    format!(
        "{SESSION_SCHEMA_SQL}\n{P0_DOMAIN_SCHEMA_SQL}\n{DROP_DIAGNOSTIC_LOGS_SQL}\n{DROP_UNUSED_TABLES_SQL}"
    )
}

/// topology_nodes.name 加列迁移（2026-06-10）：CREATE IF NOT EXISTS 不会给
/// 已存在的表补列，SQLite 的 ALTER 又不幂等——用 pragma 检查守卫，老库自愈，
/// 新库由上面 CREATE 直接带列后此处 no-op。
pub async fn ensure_topology_nodes_name_column(
    pool: &sqlx::Pool<sqlx::Sqlite>,
) -> Result<(), sqlx::Error> {
    let has_column: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('topology_nodes') WHERE name = 'name'",
    )
    .fetch_one(pool)
    .await?;

    if has_column == 0 {
        sqlx::query("ALTER TABLE topology_nodes ADD COLUMN name TEXT")
            .execute(pool)
            .await?;
    }

    Ok(())
}

/// 拓扑去 Qunee 化 re-key（2026-06-17）：把节点身份从 Qunee 遗留的 `imac` 大数字
/// 改为逻辑序号 `sync_name`（每会话唯一、即规划器/MAC 表认的节点号），并删除纯 Qunee
/// 渲染用的 `sync_type` 列；连线两端从 `src_imac/dst_imac` 改为引用 `src_sync_name/dst_sync_name`。
///
/// 改主键属表重建，不走 migrations() 向量（否则全新库先按新 schema 建表、此迁移再找
/// `imac` 列会报错）。沿用 `ensure_topology_nodes_name_column` 的命令式 pragma 守卫范式：
/// 仅当老库仍有 `imac` 列时重建，新库/已迁移库 no-op。每行已存 `sync_name`，重建只是把它
/// 扶正为键 + 用 imac→sync_name 映射改写连线端点；端点解析不到节点的悬空连线被丢弃。
///
/// 注意：这是历史迁移的中间态——产出的列叫 `sync_name`/`src_sync_name`/`dst_sync_name`，
/// 之后由 `ensure_topology_rekey_mid_and_ports` 再把 `sync_name`→`mid`、端口拆列。
/// 两守卫探测条件互斥（本守卫探 `imac` 列存在；mid 守卫探 `mid` 列缺失），各自幂等。
pub async fn ensure_topology_rekey_to_sync_name(
    pool: &sqlx::Pool<sqlx::Sqlite>,
) -> Result<(), sqlx::Error> {
    let has_legacy_imac: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('topology_nodes') WHERE name = 'imac'",
    )
    .fetch_one(pool)
    .await?;

    if has_legacy_imac == 0 {
        return Ok(());
    }

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        CREATE TABLE topology_nodes_rekey (
            session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            sync_name     TEXT    NOT NULL,
            name          TEXT,
            x             REAL    NOT NULL,
            y             REAL    NOT NULL,
            node_type     TEXT,
            insert_order  INTEGER NOT NULL,
            PRIMARY KEY (session_id, sync_name)
        );
        INSERT OR IGNORE INTO topology_nodes_rekey
            (session_id, sync_name, name, x, y, node_type, insert_order)
            SELECT session_id, sync_name, name, x, y, node_type, insert_order
            FROM topology_nodes;

        CREATE TABLE topology_links_rekey (
            session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            link_seq       INTEGER NOT NULL,
            name           TEXT,
            src_sync_name  TEXT    NOT NULL,
            dst_sync_name  TEXT    NOT NULL,
            styles_json    TEXT    NOT NULL,
            PRIMARY KEY (session_id, link_seq)
        );
        INSERT INTO topology_links_rekey
            (session_id, link_seq, name, src_sync_name, dst_sync_name, styles_json)
            SELECT l.session_id, l.link_seq, l.name,
                (SELECT n.sync_name FROM topology_nodes n
                    WHERE n.session_id = l.session_id AND n.imac = l.src_imac),
                (SELECT n.sync_name FROM topology_nodes n
                    WHERE n.session_id = l.session_id AND n.imac = l.dst_imac),
                l.styles_json
            FROM topology_links l
            WHERE EXISTS (SELECT 1 FROM topology_nodes n
                    WHERE n.session_id = l.session_id AND n.imac = l.src_imac)
              AND EXISTS (SELECT 1 FROM topology_nodes n
                    WHERE n.session_id = l.session_id AND n.imac = l.dst_imac);

        DROP TABLE topology_links;
        DROP TABLE topology_nodes;
        ALTER TABLE topology_nodes_rekey RENAME TO topology_nodes;
        ALTER TABLE topology_links_rekey RENAME TO topology_links;

        CREATE INDEX IF NOT EXISTS idx_topology_nodes_session
            ON topology_nodes(session_id, insert_order);
        CREATE INDEX IF NOT EXISTS idx_topology_links_session
            ON topology_links(session_id, src_sync_name, dst_sync_name);
        "#,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// U1+U2 拓扑表演进（2026-06-24）：一次组合表重建，把节点键 `sync_name`→`mid`、
/// 给节点补 `mac`/`ip`/`port_count`/`queue_count` 四列，把连线端点 `src/dst_sync_name`→
/// `src/dst_node`、从 `styles_json` 拆出 `src_port`/`dst_port`/`speed` 三列。
/// `role`/`plane` 仍留 `styles_json`。
///
/// 走表重建范式（建 `_rekey` 表→`INSERT…SELECT`→DROP→RENAME），与
/// `ensure_topology_rekey_to_sync_name` 同款，但 nodes 改键与 links 改名+拆列在
/// **同一事务一次完成**，避免对 links 连做两次重建。探测条件用「目标新列缺失」
/// （`mid` 列不存在才迁），防 imac→sync_name 守卫遮蔽本守卫。
/// 老库一次 connect 可能先 imac→sync_name 再 sync_name→mid：两守卫条件互斥、各自幂等。
///
/// 端口拆列 best-effort：`styles_json.leftLabel`/`rightLabel`（如 `"P1"` 或 `"1"`）
/// 抽出数字部分作 `src_port`/`dst_port`，非数字置 NULL；`styles_json.speed` 移到 `speed`
/// 列。leftLabel/rightLabel/speed 三键留在 styles_json（拆列是新增冗余，不删旧键）。
pub async fn ensure_topology_rekey_mid_and_ports(
    pool: &sqlx::Pool<sqlx::Sqlite>,
) -> Result<(), sqlx::Error> {
    let has_mid: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('topology_nodes') WHERE name = 'mid'",
    )
    .fetch_one(pool)
    .await?;

    if has_mid > 0 {
        return Ok(());
    }

    let mut tx = pool.begin().await?;

    // 节点重建：sync_name→mid（同值），补 mac/ip（NULLABLE，U3 回填）、
    // port_count/queue_count（DEFAULT 8）。
    sqlx::query(
        r#"
        CREATE TABLE topology_nodes_rekey (
            session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            mid           TEXT    NOT NULL,
            name          TEXT,
            x             REAL    NOT NULL,
            y             REAL    NOT NULL,
            node_type     TEXT,
            mac           TEXT,
            ip            TEXT,
            port_count    INTEGER NOT NULL DEFAULT 8,
            queue_count   INTEGER NOT NULL DEFAULT 8,
            insert_order  INTEGER NOT NULL,
            PRIMARY KEY (session_id, mid)
        );
        INSERT OR IGNORE INTO topology_nodes_rekey
            (session_id, mid, name, x, y, node_type, insert_order)
            SELECT session_id, sync_name, name, x, y, node_type, insert_order
            FROM topology_nodes;

        DROP TABLE topology_nodes;
        ALTER TABLE topology_nodes_rekey RENAME TO topology_nodes;
        CREATE INDEX IF NOT EXISTS idx_topology_nodes_session
            ON topology_nodes(session_id, insert_order);
        "#,
    )
    .execute(&mut *tx)
    .await?;

    // 连线重建：src/dst_sync_name→src/dst_node，拆 src_port/dst_port（从
    // leftLabel/rightLabel best-effort parse 数字）、speed（从 styles_json.speed）。
    // 拆列在 Rust 侧逐行做（SQLite 无现成 JSON 数字前缀提取），故先把端点改名 SQL 化、
    // 再补三列、最后逐行回填。
    sqlx::query(
        r#"
        CREATE TABLE topology_links_rekey (
            session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            link_seq    INTEGER NOT NULL,
            name        TEXT,
            src_node    TEXT    NOT NULL,
            dst_node    TEXT    NOT NULL,
            src_port    INTEGER,
            dst_port    INTEGER,
            speed       INTEGER,
            styles_json TEXT    NOT NULL,
            PRIMARY KEY (session_id, link_seq)
        );
        INSERT INTO topology_links_rekey
            (session_id, link_seq, name, src_node, dst_node, styles_json)
            SELECT session_id, link_seq, name, src_sync_name, dst_sync_name, styles_json
            FROM topology_links;

        DROP TABLE topology_links;
        ALTER TABLE topology_links_rekey RENAME TO topology_links;
        CREATE INDEX IF NOT EXISTS idx_topology_links_session
            ON topology_links(session_id, src_node, dst_node);
        "#,
    )
    .execute(&mut *tx)
    .await?;

    // 端口/speed best-effort 回填：逐行读 styles_json，parse leftLabel/rightLabel 数字前缀。
    let link_rows = sqlx::query("SELECT session_id, link_seq, styles_json FROM topology_links")
        .fetch_all(&mut *tx)
        .await?;
    for row in &link_rows {
        use sqlx::Row;
        let session_id: String = row.get("session_id");
        let link_seq: i64 = row.get("link_seq");
        let styles_json: String = row.get("styles_json");
        let (src_port, dst_port, speed) = parse_link_ports_and_speed(&styles_json);
        sqlx::query(
            "UPDATE topology_links SET src_port = ?, dst_port = ?, speed = ? \
             WHERE session_id = ? AND link_seq = ?",
        )
        .bind(src_port)
        .bind(dst_port)
        .bind(speed)
        .bind(&session_id)
        .bind(link_seq)
        .execute(&mut *tx)
        .await?;
    }

    // 撤销快照跨 schema 版本不可复用：sync_name 时代的 blob 用旧 JSON key
    // （sync_name/src_sync_name/dst_sync_name），重建后的 NodeRow/LinkRow 按
    // mid/src_node/dst_node 反序列化找不到 key → 盖回空串损坏行。同事务清空，
    // 迁移后不会拿旧 blob 撤出损坏数据（撤无可撤即可，不跨版本续命）。
    // 表存在才删（生产库 P0 schema 必有此表；极简测试库可能没建）。
    let has_undo_table: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='topology_undo_snapshots'",
    )
    .fetch_one(&mut *tx)
    .await?;
    if has_undo_table > 0 {
        sqlx::query("DELETE FROM topology_undo_snapshots")
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// 从 styles_json best-effort 解析 (src_port, dst_port, speed)。
/// 解析失败（非法 JSON）三者全 None；逐字段：
/// - src_port ← leftLabel 的数字前缀（`"P1"`→1、`"1"`→1、非数字→None）
/// - dst_port ← rightLabel 同理
/// - speed ← styles_json.speed（整数；缺失/非整数→None）
pub fn parse_link_ports_and_speed(styles_json: &str) -> (Option<i64>, Option<i64>, Option<i64>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(styles_json) else {
        return (None, None, None);
    };
    let port_of = |key: &str| -> Option<i64> {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(parse_port_label)
    };
    let speed = value.get("speed").and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_f64().map(|f| f as i64))
            .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
    });
    (port_of("leftLabel"), port_of("rightLabel"), speed)
}

/// 端口标签数字提取：只认 `P<digits>`（大小写 P，如 `"P1"`→1）或纯数字（`"1"`→1）。
/// 其余（`"eth0"`/`"GE0/1"`/空）→ None，避免跳过任意前缀误把 `"eth0"` 解析成 0。
pub(crate) fn parse_port_label(label: &str) -> Option<i64> {
    let digits = label.strip_prefix(['P', 'p']).unwrap_or(label);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        None
    } else {
        digits.parse::<i64>().ok()
    }
}

/// Export/Import 共享的 session 域数据表清单（表名 + 列清单，首列恒为 session_id）。
/// 单一事实源：导出切片（session_export）与导入复制（session_import）都遍历此清单，
/// 防两端漂移 —— 导出写了 import 不收的表 = 静默丢数据。
/// `sessions` 行本身不在清单内（两端都有特殊处理：导出置 payload、导入改写 id）。
pub const SESSION_SCOPED_TABLES: &[(&str, &[&str])] = &[
    (
        "topology_nodes",
        &[
            "session_id",
            "mid",
            "name",
            "x",
            "y",
            "node_type",
            "mac",
            "ip",
            "port_count",
            "queue_count",
            "insert_order",
        ],
    ),
    (
        "topology_links",
        &[
            "session_id",
            "link_seq",
            "name",
            "src_node",
            "dst_node",
            "src_port",
            "dst_port",
            "speed",
            "styles_json",
        ],
    ),
    (
        "timesync_domain",
        &[
            "session_id",
            "gm_mid",
            "one_step_mode",
            "fre_switch",
            "disabled_link_seqs",
        ],
    ),
    (
        "timesync_nodes",
        &[
            "session_id",
            "mid",
            "master_port",
            "slave_port",
            "port_ptp_enabled",
            "sync_period",
            "measure_period",
            "report_enable",
            "mean_link_delay_thresh",
            "offset_threshold",
        ],
    ),
];

/// Plan v3 U_R5：lazy migration。旧 v1 db 含 `diagnostic_logs` 表 + 索引；
/// 升级到 v3 时一次性 `DROP TABLE IF EXISTS`，数据直接丢弃（脱敏摘要，
/// 不属用户数据，参考 KTD）。执行日志模块已于 U8（2026-06-25）整体删除。
pub const DROP_DIAGNOSTIC_LOGS_SQL: &str = r#"
    DROP INDEX IF EXISTS idx_diagnostic_logs_session_created_at;
    DROP INDEX IF EXISTS idx_diagnostic_logs_session_category;
    DROP TABLE IF EXISTS diagnostic_logs;
"#;

/// migration v4 的建表 SQL，**冻结不可改**：sqlx Migrator 按内容 checksum 校验
/// 已应用迁移，改一个字节都会让老库启动报 VersionMismatch。session_backfill_state
/// 的实际下线由 v6 `DROP` 完成（见 DROP_UNUSED_TABLES_SQL），此处仅保留历史原文。
pub const SESSION_BACKFILL_STATE_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS session_backfill_state (
        session_id    TEXT    PRIMARY KEY NOT NULL,
        state         TEXT    NOT NULL,
        error_code    TEXT,
        attempted_at  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_backfill_state
        ON session_backfill_state(state);
"#;

/// 废弃空壳表清理（migration v6，2026-06-24）：migration v2 建过 13 张 node.*
/// 子表 + topo_feature_links + topology_refs，从未有业务写入（walker 下线后无人
/// 填充）；v4 的 session_backfill_state 服务的 walker 已退化为 payload 健康检查，
/// 连带恢复子系统一并下线。一次性 `DROP TABLE IF EXISTS`，child→parent 顺序
/// （nodes_* 先于 nodes，避免 FK 悬挂）。新库这些表本就不再建，DROP 全 no-op。
pub const DROP_UNUSED_TABLES_SQL: &str = r#"
    DROP INDEX IF EXISTS idx_session_backfill_state;
    DROP TABLE IF EXISTS session_backfill_state;
    DROP TABLE IF EXISTS nodes_object_cfg;
    DROP TABLE IF EXISTS nodes_array_cfg;
    DROP TABLE IF EXISTS nodes_frer_cfg;
    DROP TABLE IF EXISTS nodes_psfg_stream_gates;
    DROP TABLE IF EXISTS nodes_psfg_flow_meters;
    DROP TABLE IF EXISTS nodes_psfg_stream_filters;
    DROP TABLE IF EXISTS nodes_time_cfg;
    DROP TABLE IF EXISTS nodes_gcl_cfg;
    DROP TABLE IF EXISTS nodes_sdu_table_cfg;
    DROP TABLE IF EXISTS nodes_oss_cfg;
    DROP INDEX IF EXISTS idx_nodes_session;
    DROP TABLE IF EXISTS nodes;
    DROP INDEX IF EXISTS idx_topo_feature_session_src;
    DROP INDEX IF EXISTS idx_topo_feature_session_dst;
    DROP TABLE IF EXISTS topo_feature_links;
    DROP TABLE IF EXISTS topology_refs;
"#;

/// 端系统持久层标签统一（2026-06-17）：旧版给端系统节点的 `node_type` 存
/// `networkcard`（借"网卡"一词当节点类型），与应用其余各层统一使用的
/// `endSystem` 不一致。把存量行刷成 `endSystem`，使库内只有一套叫法。
/// 纯数据 UPDATE，无匹配行时空跑，幂等。
pub const RENAME_NETWORKCARD_NODE_TYPE_SQL: &str = r#"
    UPDATE topology_nodes SET node_type = 'endSystem' WHERE node_type = 'networkcard';
"#;

pub fn migrations() -> Vec<tauri_plugin_sql::Migration> {
    vec![
        tauri_plugin_sql::Migration {
            version: 1,
            description: "create_session_store",
            sql: SESSION_SCHEMA_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 2,
            description: "create_p0_domain_tables",
            sql: P0_DOMAIN_SCHEMA_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 3,
            description: "drop_diagnostic_logs_for_file_writer",
            sql: DROP_DIAGNOSTIC_LOGS_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 4,
            description: "create_session_backfill_state",
            // v4 SQL 必须原样保留（sqlx Migrator 对已应用迁移做 checksum 校验，
            // 改动会让老库 VersionMismatch）。该表的下线由 v6 DROP 完成。
            sql: SESSION_BACKFILL_STATE_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 5,
            description: "rename_networkcard_node_type_to_end_system",
            sql: RENAME_NETWORKCARD_NODE_TYPE_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 6,
            description: "drop_unused_node_and_backfill_tables",
            sql: DROP_UNUSED_TABLES_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    #[test]
    fn parse_port_label_extracts_digits() {
        assert_eq!(parse_port_label("P1"), Some(1));
        assert_eq!(parse_port_label("P3"), Some(3));
        assert_eq!(parse_port_label("1"), Some(1));
        assert_eq!(parse_port_label("5"), Some(5));
        assert_eq!(parse_port_label("P12"), Some(12));
        assert_eq!(parse_port_label("p7"), Some(7));
        // 只认 P<digits> 或纯数字；其余前缀不再误解析。
        assert_eq!(parse_port_label("eth0"), None);
        assert_eq!(parse_port_label("GE0/1"), None);
        assert_eq!(parse_port_label("port"), None);
        assert_eq!(parse_port_label("P"), None);
        assert_eq!(parse_port_label(""), None);
    }

    #[test]
    fn parse_link_ports_and_speed_best_effort() {
        // 数字端口 + speed 全提取
        assert_eq!(
            parse_link_ports_and_speed(r#"{"leftLabel":"P1","rightLabel":"2","speed":1000}"#),
            (Some(1), Some(2), Some(1000))
        );
        // 非数字 leftLabel → None；缺 rightLabel → None；speed 字符串可 parse
        assert_eq!(
            parse_link_ports_and_speed(r#"{"leftLabel":"eth","speed":"100"}"#),
            (None, None, Some(100))
        );
        // 非法 JSON → 全 None
        assert_eq!(parse_link_ports_and_speed("not json"), (None, None, None));
        // 空对象 → 全 None
        assert_eq!(parse_link_ports_and_speed("{}"), (None, None, None));
    }

    async fn sync_name_era_pool() -> sqlx::Pool<sqlx::Sqlite> {
        // 直建「sync_name 时代」schema（imac 已迁、mid 未迁）+ 样本。
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE topology_nodes (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                sync_name TEXT NOT NULL, name TEXT,
                x REAL NOT NULL, y REAL NOT NULL, node_type TEXT, insert_order INTEGER NOT NULL,
                PRIMARY KEY (session_id, sync_name)
            );
            CREATE TABLE topology_links (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                link_seq INTEGER NOT NULL, name TEXT,
                src_sync_name TEXT NOT NULL, dst_sync_name TEXT NOT NULL,
                styles_json TEXT NOT NULL,
                PRIMARY KEY (session_id, link_seq)
            );
            INSERT INTO sessions (id) VALUES ('s1');
            INSERT INTO topology_nodes (session_id, sync_name, name, x, y, node_type, insert_order)
                VALUES ('s1', '0', 'SW-0', 1.5, 2.5, 'switch', 0),
                       ('s1', '1', 'ES-1', 3.0, 4.0, 'endSystem', 1);
            INSERT INTO topology_links (session_id, link_seq, name, src_sync_name, dst_sync_name, styles_json)
                VALUES ('s1', 0, 'l0', '0', '1', '{"leftLabel":"P0","rightLabel":"3","speed":1000,"plane":"A"}'),
                       ('s1', 1, 'l1', '0', '1', '{"leftLabel":"weird","speed":100}');
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn mid_rekey_migrates_sync_name_era_db_and_is_idempotent() {
        let pool = sync_name_era_pool().await;
        ensure_topology_rekey_mid_and_ports(&pool).await.unwrap();

        // 节点：sync_name 列消失，mid + 四列在；数据保真。
        let gone: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('topology_nodes') WHERE name = 'sync_name'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(gone, 0);
        let (name, x, pc, qc, mac, ip): (
            Option<String>,
            f64,
            i64,
            i64,
            Option<String>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT name, x, port_count, queue_count, mac, ip FROM topology_nodes WHERE session_id='s1' AND mid='0'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(name.as_deref(), Some("SW-0"));
        assert_eq!(x, 1.5);
        assert_eq!((pc, qc), (8, 8));
        assert!(mac.is_none() && ip.is_none());

        // 连线：src/dst_sync_name → src/dst_node，端口拆出，speed 拆出。
        let link0: (String, String, Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT src_node, dst_node, src_port, dst_port, speed FROM topology_links WHERE session_id='s1' AND link_seq=0",
        )
        .fetch_one(&pool).await.unwrap();
        assert_eq!((link0.0.as_str(), link0.1.as_str()), ("0", "1"));
        assert_eq!(link0.2, Some(0), "leftLabel P0 → 0");
        assert_eq!(link0.3, Some(3), "rightLabel 3 → 3");
        assert_eq!(link0.4, Some(1000));
        // 非数字 leftLabel → NULL；缺 rightLabel → NULL。
        let link1: (Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT src_port, dst_port, speed FROM topology_links WHERE session_id='s1' AND link_seq=1",
        )
        .fetch_one(&pool).await.unwrap();
        assert_eq!(link1, (None, None, Some(100)));
        // styles_json 保留（role/plane/原标签仍在）。
        let styles: String = sqlx::query_scalar(
            "SELECT styles_json FROM topology_links WHERE session_id='s1' AND link_seq=0",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(styles.contains("\"plane\":\"A\""), "styles_json 保留 plane");

        // 再跑一次 no-op（mid 列已存在）：不报错、行数不变。
        ensure_topology_rekey_mid_and_ports(&pool).await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn mid_rekey_clears_stale_undo_snapshots() {
        // sync_name 时代写过的撤销快照（blob 用旧 key src_sync_name 等）跨 schema
        // 版本不可复用；迁移守卫成功重建后必须清空，否则撤销会拿旧 blob 盖出损坏行。
        let pool = sync_name_era_pool().await;
        sqlx::query(
            r#"CREATE TABLE topology_undo_snapshots (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                domain TEXT NOT NULL,
                blob_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (session_id, domain)
            );"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        // 模拟一份 sync_name 时代的 topology 快照 blob（旧 key）。
        sqlx::query(
            "INSERT INTO topology_undo_snapshots (session_id, domain, blob_json, created_at) \
             VALUES ('s1', 'topology', \
             '{\"nodes\":[{\"session_id\":\"s1\",\"sync_name\":\"0\"}],\"links\":[]}', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_topology_rekey_mid_and_ports(&pool).await.unwrap();

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topology_undo_snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0, "迁移后旧快照应清空，避免盖出损坏行");
    }

    #[tokio::test]
    async fn fresh_safety_net_db_has_mid_and_new_columns_and_mid_guard_is_noop() {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(&safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();

        let node_cols: Vec<String> =
            sqlx::query("SELECT name FROM pragma_table_info('topology_nodes')")
                .fetch_all(&pool)
                .await
                .unwrap()
                .iter()
                .map(|r| r.get::<String, _>("name"))
                .collect();
        for c in ["mid", "mac", "ip", "port_count", "queue_count"] {
            assert!(node_cols.iter().any(|n| n == c), "新库缺节点列 {c}");
        }
        assert!(
            !node_cols.iter().any(|n| n == "sync_name"),
            "新库不应有 sync_name 列"
        );
        let link_cols: Vec<String> =
            sqlx::query("SELECT name FROM pragma_table_info('topology_links')")
                .fetch_all(&pool)
                .await
                .unwrap()
                .iter()
                .map(|r| r.get::<String, _>("name"))
                .collect();
        for c in ["src_node", "dst_node", "src_port", "dst_port", "speed"] {
            assert!(link_cols.iter().any(|n| n == c), "新库缺连线列 {c}");
        }

        // mid 守卫在新库 no-op（mid 已存在）。
        ensure_topology_rekey_mid_and_ports(&pool).await.unwrap();
    }

    #[test]
    fn session_scoped_tables_topology_columns_match_new_schema() {
        let nodes = SESSION_SCOPED_TABLES
            .iter()
            .find(|(t, _)| *t == "topology_nodes")
            .unwrap()
            .1;
        for c in ["mid", "mac", "ip", "port_count", "queue_count"] {
            assert!(nodes.contains(&c), "导出清单缺节点列 {c}");
        }
        assert!(!nodes.contains(&"sync_name"));
        let links = SESSION_SCOPED_TABLES
            .iter()
            .find(|(t, _)| *t == "topology_links")
            .unwrap()
            .1;
        for c in ["src_node", "dst_node", "src_port", "dst_port", "speed"] {
            assert!(links.contains(&c), "导出清单缺连线列 {c}");
        }
        assert!(!links.contains(&"src_sync_name"));
    }

    async fn fresh_safety_net_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(&safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn table_columns(pool: &sqlx::Pool<sqlx::Sqlite>, table: &str) -> Vec<String> {
        sqlx::query(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .fetch_all(pool)
            .await
            .unwrap()
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .collect()
    }

    #[tokio::test]
    async fn safety_net_creates_timesync_tables_with_full_columns() {
        let pool = fresh_safety_net_pool().await;

        let domain_cols = table_columns(&pool, "timesync_domain").await;
        for c in [
            "session_id",
            "gm_mid",
            "one_step_mode",
            "fre_switch",
            "disabled_link_seqs",
        ] {
            assert!(
                domain_cols.iter().any(|n| n == c),
                "timesync_domain 缺列 {c}"
            );
        }
        // 主键 session_id（一 session 一行）。
        let domain_pk: Vec<String> = sqlx::query(
            "SELECT name FROM pragma_table_info('timesync_domain') WHERE pk > 0 ORDER BY pk",
        )
        .fetch_all(&pool)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get::<String, _>("name"))
        .collect();
        assert_eq!(domain_pk, vec!["session_id".to_string()]);

        let node_cols = table_columns(&pool, "timesync_nodes").await;
        for c in [
            "session_id",
            "mid",
            "master_port",
            "slave_port",
            "port_ptp_enabled",
            "sync_period",
            "measure_period",
            "report_enable",
            "mean_link_delay_thresh",
            "offset_threshold",
        ] {
            assert!(node_cols.iter().any(|n| n == c), "timesync_nodes 缺列 {c}");
        }
        let node_pk: Vec<String> = sqlx::query(
            "SELECT name FROM pragma_table_info('timesync_nodes') WHERE pk > 0 ORDER BY pk",
        )
        .fetch_all(&pool)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get::<String, _>("name"))
        .collect();
        assert_eq!(node_pk, vec!["session_id".to_string(), "mid".to_string()]);

        // 再跑一遍 safety_net 幂等。
        sqlx::query(&safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn deleting_session_cascades_to_timesync_tables() {
        let pool = fresh_safety_net_pool().await;
        sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1','t','t','t','{}')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid) VALUES ('s1', '0')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port) \
             VALUES ('s1', '0', '[1]', '[]')",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM sessions WHERE id = 's1'")
            .execute(&pool)
            .await
            .unwrap();

        let domain_left: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM timesync_domain WHERE session_id = 's1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let nodes_left: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM timesync_nodes WHERE session_id = 's1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(domain_left, 0, "删 session 应级联清 timesync_domain");
        assert_eq!(nodes_left, 0, "删 session 应级联清 timesync_nodes");
    }

    #[test]
    fn session_scoped_tables_include_timesync_tables() {
        for (table, required) in [
            (
                "timesync_domain",
                &["session_id", "gm_mid", "disabled_link_seqs"][..],
            ),
            (
                "timesync_nodes",
                &["session_id", "mid", "master_port", "offset_threshold"][..],
            ),
        ] {
            let cols = SESSION_SCOPED_TABLES
                .iter()
                .find(|(t, _)| *t == table)
                .unwrap_or_else(|| panic!("SESSION_SCOPED_TABLES 缺 {table}"))
                .1;
            assert_eq!(cols[0], "session_id", "{table} 首列须为 session_id");
            for c in required {
                assert!(cols.contains(c), "{table} 导出清单缺列 {c}");
            }
        }
    }
}
