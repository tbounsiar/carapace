mod commands;
mod config;
mod secrets;
mod ssh;
mod terminal;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, WindowEvent};

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
            let secrets = secrets::SecretStore::keychain();
            app.manage(ssh::SshManager::new(&home, secrets.clone()));
            app.manage(terminal::TerminalManager::default());
            app.manage(secrets);
            app.manage(config::ConfigStore::new(home));
            Ok(())
        })
        // Terminal events are bound to the page that opened them; a reload or a closed window
        // would otherwise leave shells running with nobody reading their output.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started
                && let Some(terminals) = webview.try_state::<terminal::TerminalManager>()
            {
                terminals.close_all();
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed)
                && let Some(terminals) = window.try_state::<terminal::TerminalManager>()
            {
                terminals.close_all();
            }
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
            commands::terminal::open_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::secrets::set_host_secret,
            commands::secrets::delete_host_secret,
            commands::secrets::has_host_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
