mod commands;
mod db;
mod diagnostic_store;
mod inet_bundle;
mod inet_remote;
mod inet_verify_command;
mod log_file_writer;
mod redaction;
mod session_export;
mod session_import;
mod session_store;
mod skill_factory_hashes;
mod skill_files;
mod topology_backfill;
mod topology_compute;
mod topology_intermediate;
mod topology_mutation_buffer;
mod topology_mutations_command;
mod topology_ops;
mod topology_position_command;
mod topology_query_command;
mod topology_sidecar;
mod topology_sidecar_routes;
mod topology_undo;
mod topology_undo_command;
mod topology_verify;

#[tauri::command]
fn app_health() -> &'static str {
    "ok"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DATABASE_URL, db::migrations())
                .build(),
        )
        .manage(session_store::SessionStore::default())
        .manage(diagnostic_store::DiagnosticStore::default())
        .manage(std::sync::Arc::new(
            topology_mutation_buffer::TopologyMutationBuffer::default(),
        ))
        .setup(|app| {
            // Plan v3 U3 + U4a-1：sidecar 起前先拉起 sqlx pool 与 mutation buffer。
            // emit 闭包桥接到 Tauri AppHandle，生产 emit_to("main", ...)；
            // 失败回退到全局 emit，再失败写 stderr（UI 端 watchdog 兜底）。
            let pool =
                tauri::async_runtime::block_on(session_store::connect_app_database(app.handle()))
                    .expect("connect app database");
            // Plan v3 U5：把无 backfill_state 的 session 标 pending_walker，然后立即
            // 跑 walker 把 sessions.payload 写进 topology_nodes/_links/_refs。
            // 最小路径只覆盖基础拓扑表；13 张 nodes.* + topo_feature 由 MCP
            // apply_operations 增量补齐（Phase A 边界）。
            if let Err(error) = tauri::async_runtime::block_on(
                topology_backfill::mark_pending_for_all_sessions(&pool),
            ) {
                eprintln!("backfill pending 扫描失败：{error}");
            }
            if let Err(error) = tauri::async_runtime::block_on(
                topology_backfill::run_walker_for_pending_sessions(&pool),
            ) {
                eprintln!("backfill walker 启动期扫描失败：{error}");
            }
            let buffer: std::sync::Arc<topology_mutation_buffer::TopologyMutationBuffer> = app
                .state::<std::sync::Arc<topology_mutation_buffer::TopologyMutationBuffer>>()
                .inner()
                .clone();
            let emit_handle = app.handle().clone();
            let emit: topology_sidecar_routes::MutationEmitFn =
                std::sync::Arc::new(move |record| {
                    topology_position_command::emit_session_db_changed(&emit_handle, &record);
                });
            let handle =
                tauri::async_runtime::block_on(topology_sidecar::launch(pool, buffer, emit));
            app.manage(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_health,
            diagnostic_store::append_diagnostic_log,
            diagnostic_store::clear_session_diagnostic_logs,
            diagnostic_store::list_diagnostic_logs,
            commands::run_claude_agent,
            commands::describe_topology_templates,
            session_export::export_session,
            session_export::reveal_in_dir,
            session_import::import_session,
            topology_backfill::list_backfill_failures,
            topology_backfill::retry_backfill,
            topology_backfill::view_session_payload,
            topology_mutations_command::get_topology_mutations_since,
            topology_position_command::update_node_position,
            topology_undo_command::undo_topology,
            topology_query_command::query_topology,
            topology_query_command::verify_topology,
            inet_verify_command::verify_inet, // 暂未接前端：INET 验证挪到后续流量规划阶段，保留作其基础，勿当死代码删
            session_store::get_current_session,
            session_store::list_sessions,
            session_store::remove_session,
            session_store::save_session,
            session_store::set_current_session,
            skill_files::list_skill_files,
            skill_files::read_skill_file,
            skill_files::write_skill_file,
            skill_files::restore_factory_skills
        ])
        .build(tauri::generate_context!())
        .expect("failed to build TSN Agent")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit)
                && let Some(handle) = app_handle.try_state::<topology_sidecar::SidecarHandle>()
            {
                handle.shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_health_returns_ok() {
        assert_eq!(app_health(), "ok");
    }
}
