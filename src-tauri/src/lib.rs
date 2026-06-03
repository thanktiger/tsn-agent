mod commands;
mod db;
mod diagnostic_store;
mod planner_client;
mod project_writer;
mod redaction;
mod session_store;
mod skill_files;

#[tauri::command]
fn app_health() -> &'static str {
    "ok"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            session_store::get_current_session,
            session_store::list_sessions,
            session_store::remove_session,
            session_store::save_session,
            session_store::set_current_session,
            skill_files::list_skill_files,
            skill_files::read_skill_file,
            skill_files::write_skill_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TSN Agent");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_health_returns_ok() {
        assert_eq!(app_health(), "ok");
    }
}
