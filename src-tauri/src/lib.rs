mod analytics;
mod commands;
mod config;
mod data_transfer;
mod external;
mod files;
mod fsutil;
mod keys;
mod localfs;
mod native_text;
mod quit;
mod secrets;
mod sftp;
mod ssh;
mod terminal;
mod text;
mod transfer;
mod vars;

use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg(all(feature = "e2e-offscreen", not(debug_assertions)))]
compile_error!("the e2e-offscreen feature is for debug end-to-end builds only");

/// Size of the log file before it is rotated; one previous file is kept.
const MAX_LOG_BYTES: u128 = 1024 * 1024;

/// Debug builds log to stdout and the app log dir; release builds to the log dir only, with
/// other crates at warn so a dependency's info output never reaches the file.
fn logger<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind};
    let builder = Builder::default()
        .max_file_size(MAX_LOG_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(2));
    if cfg!(debug_assertions) {
        builder.level(log::LevelFilter::Info).build()
    } else {
        builder
            .clear_targets()
            .target(Target::new(TargetKind::LogDir { file_name: None }))
            .level(log::LevelFilter::Warn)
            .level_for("carapace_lib", log::LevelFilter::Info)
            .build()
    }
}

/// The log names hosts by id and records connection failures; on Linux the XDG data dir would
/// leave it readable by other users. Created (or tightened) to 0700 before the plugin opens it.
#[cfg(unix)]
fn private_log_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir);
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(unix)]
            private_log_dir(app.handle());
            app.handle().plugin(logger())?;
            #[cfg(feature = "e2e-offscreen")]
            if let Some(window) = app.get_webview_window("main") {
                window.set_skip_taskbar(true)?;
                window.set_position(tauri::PhysicalPosition::new(-10_000, -10_000))?;
                window.set_focusable(false)?;
                window.show()?;
            }
            let home = config::resolve_home()?;
            let secrets = secrets::SecretStore::keychain();
            app.manage(ssh::SshManager::new(
                &home,
                secrets.clone(),
                commands::ssh::is_current(app.handle().clone()),
            ));
            app.manage(terminal::TerminalManager::default());
            app.manage(sftp::SftpManager::default());
            app.manage(quit::QuitGuard::default());
            app.manage(data_transfer::pending::PendingImports::default());
            let home_dir = home.clone();
            let store = commands::secrets::config_store(home, &secrets);
            // Loading splits a config.json, moves a version 1 file aside or drops environments;
            // their keychain entries go with them. It runs before the settings are read, so the
            // analytics choices come from the split file. They are read here, before the webview
            // runs; a failed read keeps analytics off and silent until a later read succeeds.
            let known = store.snapshot().ok();
            let choices = store.analytics();
            native_text::remember(store.settings().ok().and_then(|s| s.language));
            commands::secrets::forget_legacy(&store, &secrets);
            let version = app.package_info().version.to_string();
            let analytics = analytics::Analytics::for_app(choices, &version);
            analytics.set_crash_dir(home_dir.clone());
            analytics::crash::install(analytics.crashes());
            analytics.launched();
            analytics.resume_crash_report();
            app.manage(transfer::TransferManager::with_observer(
                Arc::new(commands::transfer::AppConnections(app.handle().clone())),
                commands::transfer::observer(analytics.clone()),
            ));
            let handle = app.handle().clone();
            let edits = external::ExternalEdits::new(
                &home_dir,
                Arc::new(commands::transfer::AppConnections(app.handle().clone())),
                Arc::new(external::OsLauncher),
                Arc::new(move || {
                    let store = handle.state::<config::ConfigStore>();
                    let cfg = store.external_editor().ok().flatten();
                    commands::external::opener_of(cfg.as_ref())
                }),
            );
            edits.retain_known_hosts(|id| known.as_ref().is_some_and(|c| c.host(id).is_some()));
            edits.set_attention(commands::app::attention(app.handle().clone()));
            app.manage(edits);
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
                        sender.reload(|| store.analytics());
                        sender.resume_crash_report();
                        sender.retry_save(|w| store.update_analytics(w));
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
            if let Some(edits) = webview.try_state::<external::ExternalEdits>() {
                edits.unsubscribe();
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
                if let Some(pending) = window.try_state::<data_transfer::pending::PendingImports>()
                {
                    pending.clear();
                }
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
            commands::settings::app_settings,
            commands::settings::update_app_settings,
            commands::settings::import_legacy_settings,
            commands::analytics::analytics_state,
            commands::analytics::set_analytics_choices,
            commands::analytics::set_analytics_category,
            commands::analytics::analytics_recent,
            commands::analytics::analytics_app_started,
            commands::analytics::open_privacy_page,
            commands::app::set_quit_guard,
            commands::app::subscribe_app_events,
            commands::app::quit_app,
            commands::external::open_external,
            commands::external::subscribe_edited,
            commands::external::list_edited,
            commands::external::has_unsynced,
            commands::external::upload_now,
            commands::external::resolve_conflict,
            commands::external::stop_editing,
            commands::external::stop_all_editing,
            commands::external::discard_recovered,
            commands::external::reveal,
            commands::external::edited_affected,
            commands::external::get_external_editor,
            commands::external::set_external_editor,
            commands::external::pick_external_editor,
            commands::data_transfer::export_data,
            commands::data_transfer::preview_import,
            commands::data_transfer::refresh_import,
            commands::data_transfer::apply_import,
            commands::data_transfer::undo_import,
            commands::data_transfer::cancel_import,
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
                && let Some(edits) = app.try_state::<external::ExternalEdits>()
            {
                edits.shutdown();
            }
            if let RunEvent::Exit = event
                && let Some(analytics) = app.try_state::<analytics::Analytics>()
            {
                if let Some(store) = app.try_state::<config::ConfigStore>() {
                    analytics.retry_save(|w| store.update_analytics(w));
                }
                analytics.shutdown();
            }
        });
}
