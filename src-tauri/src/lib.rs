mod backend_e2e;
mod commands;
mod db;
mod eval_command;
mod flow_plan_command;
mod flow_reconcile;
mod flow_route;
mod flow_sidecar_routes;
mod flow_verify;
mod flow_verify_command;
mod hardware_api;
mod hardware_api_config;
mod hardware_command;
mod inet_remote;
mod inet_sim_bundle;
mod inet_sim_command;
mod inet_sim_http;
mod inet_sim_http_config;
mod redaction;
mod session_export;
mod session_import;
mod session_store;
mod skill_factory_hashes;
mod skill_files;
mod task_request;
mod task_store;
mod timesync_query_command;
mod timesync_sidecar_routes;
mod timesync_tree;
mod timesync_verify;
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

/// 确认过关闸用：读库 timesync 配置跑结构校验，返回 VerifyResult（camelCase）。
/// 仿 `topology_query_command::verify_topology` 命令包装（取 session_id、调核心）。
#[tauri::command]
async fn verify_time_sync(
    app: tauri::AppHandle,
    store: tauri::State<'_, session_store::SessionStore>,
    request: timesync_verify::VerifyTimeSyncRequest,
) -> Result<timesync_verify::VerifyResult, String> {
    let pool = store.pool(&app).await?;
    timesync_verify::verify_time_sync(pool, &request.session_id)
        .await
        .map_err(|e| format!("时钟同步校验失败：{e}"))
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
        .manage(commands::AgentWorkerRegistry::default())
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
            commands::run_claude_agent,
            commands::cancel_claude_agent,
            commands::describe_topology_templates,
            session_export::export_session,
            session_export::reveal_in_dir,
            eval_command::open_eval_dir,
            eval_command::export_eval_dataset,
            eval_command::clear_eval_store,
            eval_command::clear_eval_for_session,
            session_import::import_session,
            topology_mutations_command::get_topology_mutations_since,
            topology_position_command::update_node_position,
            topology_undo_command::undo_topology,
            topology_query_command::query_topology,
            topology_query_command::verify_topology,
            timesync_query_command::query_timesync,
            verify_time_sync,
            inet_sim_command::run_timesync_sim,
            inet_sim_command::get_sim_defaults,
            flow_plan_command::plan_tas,
            flow_verify_command::verify_tas,
            hardware_api_config::get_hardware_api_config,
            hardware_api_config::set_hardware_api_config,
            inet_sim_http_config::get_inet_sim_http_config,
            inet_sim_http_config::set_inet_sim_http_config,
            hardware_command::hardware_check,
            hardware_command::hardware_start,
            hardware_command::hardware_query,
            hardware_command::hardware_metrics,
            hardware_command::hardware_stop,
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
        .expect("failed to build HIBridge Agent")
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
