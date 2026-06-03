mod commands;
mod db;
mod diagnostic_store;
mod log_file_writer;
mod planner_client;
mod project_writer;
mod redaction;
mod session_export;
mod session_store;
mod skill_files;
mod topology_sidecar;
mod topology_sidecar_routes;

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
        .setup(|app| {
            // Plan v3 U3：sidecar 在 setup() 内同步起，bind 失败直接 panic（fail-closed）。
            let handle = tauri::async_runtime::block_on(topology_sidecar::launch());
            app.manage(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_health,
            diagnostic_store::append_diagnostic_log,
            diagnostic_store::clear_session_diagnostic_logs,
            diagnostic_store::list_diagnostic_logs,
            commands::run_claude_agent,
            planner_client::planner_get_plan_result,
            planner_client::planner_query_plan_status,
            planner_client::planner_start_plan,
            planner_client::planner_stop_plan,
            project_writer::open_project_export_dir,
            project_writer::suggest_project_export_dir,
            project_writer::write_project_artifacts,
            session_export::export_session,
            session_store::get_current_session,
            session_store::list_sessions,
            session_store::remove_session,
            session_store::save_session,
            session_store::set_current_session,
            skill_files::list_skill_files,
            skill_files::read_skill_file,
            skill_files::write_skill_file
        ])
        .build(tauri::generate_context!())
        .expect("failed to build TSN Agent")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(handle) = app_handle.try_state::<topology_sidecar::SidecarHandle>() {
                    handle.shutdown();
                }
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
