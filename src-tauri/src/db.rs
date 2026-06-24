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
        sync_name     TEXT    NOT NULL,
        -- 逻辑节点名（如 ES-1）：initialize 落库写入，画布显示优先用它；
        -- NULLABLE——apply_operations 增量节点与历史数据回退派生名。
        name          TEXT,
        x             REAL    NOT NULL,
        y             REAL    NOT NULL,
        node_type     TEXT,
        insert_order  INTEGER NOT NULL,
        PRIMARY KEY (session_id, sync_name)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_nodes_session
        ON topology_nodes(session_id, insert_order);

    CREATE TABLE IF NOT EXISTS topology_links (
        session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        link_seq       INTEGER NOT NULL,
        name           TEXT,
        src_sync_name  TEXT    NOT NULL,
        dst_sync_name  TEXT    NOT NULL,
        styles_json    TEXT    NOT NULL,
        PRIMARY KEY (session_id, link_seq)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_links_session
        ON topology_links(session_id, src_sync_name, dst_sync_name);

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

/// Export/Import 共享的 session 域数据表清单（表名 + 列清单，首列恒为 session_id）。
/// 单一事实源：导出切片（session_export）与导入复制（session_import）都遍历此清单，
/// 防两端漂移 —— 导出写了 import 不收的表 = 静默丢数据。
/// `sessions` 行本身不在清单内（两端都有特殊处理：导出置 payload、导入改写 id）。
pub const SESSION_SCOPED_TABLES: &[(&str, &[&str])] = &[
    (
        "topology_nodes",
        &[
            "session_id",
            "sync_name",
            "name",
            "x",
            "y",
            "node_type",
            "insert_order",
        ],
    ),
    (
        "topology_links",
        &[
            "session_id",
            "link_seq",
            "name",
            "src_sync_name",
            "dst_sync_name",
            "styles_json",
        ],
    ),
];

/// Plan v3 U_R5：lazy migration。旧 v1 db 含 `diagnostic_logs` 表 + 索引；
/// 升级到 v3 时一次性 `DROP TABLE IF EXISTS`，数据直接丢弃（脱敏摘要，
/// 不属用户数据，参考 KTD）。新写入 jsonl 由 `log_file_writer` 负责。
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
