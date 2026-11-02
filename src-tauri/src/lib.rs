mod commands;
mod config;
mod ssh;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let home = config::resolve_home()?;
            app.manage(ssh::SshManager::new(&home));
            app.manage(config::ConfigStore::new(home));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::list_projects,
            commands::config::create_project,
            commands::config::rename_project,
            commands::config::delete_project,
            commands::config::create_environment,
            commands::config::rename_environment,
            commands::config::delete_environment,
            commands::config::create_host,
            commands::config::update_host,
            commands::config::delete_host,
            commands::ssh::connect_host,
            commands::ssh::answer_host_key,
            commands::ssh::replace_host_key,
            commands::ssh::disconnect_host,
            commands::ssh::list_connections,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
