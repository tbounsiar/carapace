mod analytics;
mod commands;
mod config;
mod files;
mod fsutil;
mod keys;
mod localfs;
mod quit;
mod secrets;
mod sftp;
mod ssh;
mod terminal;
mod transfer;
mod vars;

use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WindowEvent};

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
            app.manage(quit::QuitGuard::default());
            let store = commands::secrets::config_store(home, &secrets);
            // Loading moves a version 1 file aside or drops environments; their keychain entries go
            // with them. Consent is read here, before the webview runs: an unreadable file is unset.
            let consent = store.snapshot().ok().and_then(|c| c.analytics);
            commands::secrets::forget_legacy(&store, &secrets);
            let version = app.package_info().version.to_string();
            let analytics = analytics::Analytics::for_app(consent, &version);
            app.manage(transfer::TransferManager::with_observer(
                Arc::new(commands::transfer::AppConnections(app.handle().clone())),
                commands::transfer::observer(analytics.clone()),
            ));
            app.manage(secrets);
            app.manage(store);
            app.manage(analytics.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(analytics::FLUSH_INTERVAL).await;
                    analytics.expire_attempts(analytics::ATTEMPT_TTL);
                    let sender = analytics.clone();
                    let handle = handle.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        let store = handle.state::<config::ConfigStore>();
                        sender.retry_save(|v| store.set_analytics(v));
                        sender.flush(analytics::PERIODIC_FLUSH);
                    })
                    .await;
                }
            });
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
            if let Some(ssh) = webview.try_state::<ssh::SshManager>() {
                ssh.unsubscribe_ends();
            }
            // The new page has no unsaved editor and has not subscribed yet.
            if let Some(guard) = webview.try_state::<quit::QuitGuard>() {
                guard.reset();
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && commands::app::on_quit_request(window.app_handle()) {
                    api.prevent_close();
                }
                return;
            }
            if !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            if let Some(terminals) = window.try_state::<terminal::TerminalManager>() {
                terminals.close_all();
            }
            // The picker is parented to this window; its answer may never come.
            if window.label() == "main" {
                keys::cancel_picker();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::create_project,
            commands::config::rename_project,
            commands::config::delete_project,
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
            commands::ssh::test_host,
            commands::ssh::cancel_host_test,
            commands::ssh::subscribe_connections,
            commands::terminal::open_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_read_text,
            commands::sftp::sftp_write_text,
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
            commands::keys::check_key_location,
            commands::keys::pick_key_folder,
            commands::keys::pick_key_file,
            commands::keys::import_key,
            commands::keys::rename_key,
            commands::keys::delete_key,
            commands::keys::forget_key_passphrase,
            commands::keys::deploy_public_key,
            commands::analytics::analytics_state,
            commands::analytics::set_analytics_consent,
            commands::analytics::analytics_recent,
            commands::analytics::analytics_app_started,
            commands::analytics::open_privacy_page,
            commands::app::set_quit_guard,
            commands::app::subscribe_app_events,
            commands::app::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Cmd+Q on macOS asks to exit without closing the window first. With no window
            // left (the last one closed) there is no page to ask.
            if let RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
                && app.get_webview_window("main").is_some()
                && commands::app::on_quit_request(app)
            {
                api.prevent_exit();
            }
            if let RunEvent::Exit = event
                && let Some(analytics) = app.try_state::<analytics::Analytics>()
            {
                if let Some(store) = app.try_state::<config::ConfigStore>() {
                    analytics.retry_save(|v| store.set_analytics(v));
                }
                analytics.shutdown();
            }
        });
}
