mod commands;
mod config;
mod files;
mod fsutil;
mod keys;
mod localfs;
mod secrets;
mod sftp;
mod ssh;
mod terminal;
mod transfer;
mod vars;

use std::sync::Arc;

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
            app.manage(sftp::SftpManager::default());
            app.manage(transfer::TransferManager::new(Arc::new(
                commands::transfer::AppConnections(app.handle().clone()),
            )));
            let store = config::ConfigStore::new(home);
            // Loading moves a version 1 file aside; its keychain entries go with it.
            let _ = store.snapshot();
            commands::secrets::forget_legacy(&store, &secrets);
            app.manage(secrets);
            app.manage(store);
            Ok(())
        })
        // Terminal events are bound to the page that opened them; a reload or a closed window
        // would otherwise leave shells running with nobody reading their output.
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Started {
                return;
            }
            if let Some(terminals) = webview.try_state::<terminal::TerminalManager>() {
                terminals.close_all();
            }
            // Transfers keep running; the reloaded page subscribes again.
            if let Some(transfers) = webview.try_state::<transfer::TransferManager>() {
                transfers.unsubscribe();
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
            commands::config::get_config,
            commands::config::create_project,
            commands::config::rename_project,
            commands::config::delete_project,
            commands::config::create_environment,
            commands::config::rename_environment,
            commands::config::delete_environment,
            commands::config::set_active_environment,
            commands::config::set_variables,
            commands::config::create_collection,
            commands::config::rename_collection,
            commands::config::delete_collection,
            commands::config::move_node,
            commands::config::create_host,
            commands::config::update_host,
            commands::config::delete_host,
            commands::config::resolve_host,
            commands::ssh::connect_host,
            commands::ssh::answer_host_key,
            commands::ssh::replace_host_key,
            commands::ssh::disconnect_host,
            commands::ssh::list_connections,
            commands::terminal::open_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_delete,
            commands::localfs::local_home,
            commands::localfs::local_list,
            commands::localfs::local_mkdir,
            commands::localfs::local_rename,
            commands::localfs::local_delete,
            commands::transfer::subscribe_transfers,
            commands::transfer::enqueue_transfers,
            commands::transfer::cancel_transfer,
            commands::transfer::answer_conflict,
            commands::transfer::clear_finished_transfers,
            commands::secrets::forget_saved_secrets,
            commands::keys::keys_dir,
            commands::keys::list_keys,
            commands::keys::generate_key,
            commands::keys::import_key,
            commands::keys::rename_key,
            commands::keys::delete_key,
            commands::keys::forget_key_passphrase,
            commands::keys::deploy_public_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
