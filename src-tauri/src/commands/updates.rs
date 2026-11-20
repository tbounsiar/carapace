use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use super::error::CommandError;
use crate::analytics::iso_utc;
use crate::config::ConfigStore;
use crate::external::ExternalEdits;
use crate::quit::{ExitState, QuitGuard};
use crate::transfer::TransferManager;
use crate::updates::{
    Begin, CHECK_INTERVAL, CHECK_TIMEOUT, FIRST_CHECK_DELAY, Meter, OpenWork, Prefs, Progress,
    Stage, UpdateError, UpdateEvent, UpdateInfo, UpdateState, Updates, classify, install_error,
    install_kind, is_plain_version, may_apply, release_notes_url,
};

type Res<T> = Result<T, CommandError>;
pub type AppUpdates = Updates<Update>;

pub fn app_updates(version: &str) -> AppUpdates {
    let bundle = tauri::utils::platform::bundle_type();
    Updates::new(version, install_kind(bundle, cfg!(debug_assertions)))
}

fn prefs(store: &ConfigStore) -> Prefs {
    Prefs::of(store.settings().ok().as_ref())
}

fn now() -> String {
    iso_utc(SystemTime::now())
}

/// A version the plugin parsed as semver but that is not plain (build metadata, too long)
/// is not offered: it would go into the release page URL and the settings file.
fn info_of(update: &Update) -> Result<UpdateInfo, UpdateError> {
    if !is_plain_version(&update.version) {
        return Err(UpdateError::Unavailable);
    }
    let date = update
        .date
        .and_then(|d| u64::try_from(d.unix_timestamp()).ok())
        .map(|secs| iso_utc(UNIX_EPOCH + Duration::from_secs(secs)));
    Ok(UpdateInfo {
        version: update.version.clone(),
        date,
    })
}

async fn remote(app: &AppHandle) -> Result<Option<(UpdateInfo, Update)>, UpdateError> {
    let exiting = app.clone();
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        // Windows only: the updater starts the installer, then ends the process itself.
        .on_before_exit(move || {
            if let Some(exit) = exiting.try_state::<ExitState>() {
                exit.shut_down();
            }
            super::app::exit_tasks(&exiting);
            exiting.cleanup_before_exit();
        })
        .build()
        .map_err(|e| classify(&e, Stage::Check))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| classify(&e, Stage::Check))?
    else {
        return Ok(None);
    };
    Ok(Some((info_of(&update)?, update)))
}

/// Checks after `FIRST_CHECK_DELAY`, then every `CHECK_INTERVAL`, each time only if the
/// automatic check is on at that moment.
pub fn start_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            auto_check(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn auto_check(app: &AppHandle) {
    let store = app.state::<ConfigStore>();
    if !prefs(&store).auto_check {
        return;
    }
    let updates = app.state::<AppUpdates>();
    match remote(app).await {
        Ok(found) => {
            updates.checked(found, now());
            updates.notify(prefs(&store).skipped.as_deref());
        }
        Err(e) => log::warn!("automatic update check failed: {}", e.code()),
    }
}

#[tauri::command]
pub async fn update_state(
    store: State<'_, ConfigStore>,
    updates: State<'_, AppUpdates>,
) -> Res<UpdateState> {
    Ok(updates.state(&prefs(&store)))
}

#[tauri::command]
pub async fn set_update_auto_check(
    store: State<'_, ConfigStore>,
    updates: State<'_, AppUpdates>,
    enabled: bool,
) -> Res<UpdateState> {
    let settings = store.set_update_auto_check(enabled)?;
    Ok(updates.state(&Prefs::of(Some(&settings))))
}

/// Ignores the skipped version: the user asked.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
) -> Res<Option<UpdateInfo>> {
    match remote(&app).await {
        Ok(found) => Ok(updates.checked(found, now())),
        Err(e) => {
            log::warn!("update check failed: {}", e.code());
            Err(e.into())
        }
    }
}

#[tauri::command]
pub async fn subscribe_updates(
    store: State<'_, ConfigStore>,
    updates: State<'_, AppUpdates>,
    on_event: Channel<UpdateEvent>,
) -> Res<()> {
    let skipped = prefs(&store).skipped;
    updates.subscribe(
        Arc::new(move |event| on_event.send(event).is_ok()),
        skipped.as_deref(),
    );
    Ok(())
}

pub(crate) fn skip_in(
    store: &ConfigStore,
    updates: &AppUpdates,
    version: &str,
) -> Res<UpdateState> {
    if !is_plain_version(version) {
        return Err(UpdateError::InvalidVersion.into());
    }
    let settings = store.set_skipped_version(version)?;
    Ok(updates.state(&Prefs::of(Some(&settings))))
}

#[tauri::command]
pub async fn skip_update(
    store: State<'_, ConfigStore>,
    updates: State<'_, AppUpdates>,
    version: String,
) -> Res<UpdateState> {
    skip_in(&store, &updates, &version)
}

/// Resolves once the package is downloaded and its signature verified by the plugin; the bytes
/// stay in memory for `apply_update`.
#[tauri::command]
pub async fn download_update(
    updates: State<'_, AppUpdates>,
    on_progress: Channel<Progress>,
) -> Res<()> {
    let (handle, generation, cancel) = match updates.begin_download()? {
        Begin::Done(size) => {
            let _ = on_progress.send(Progress {
                downloaded: size,
                total: Some(size),
            });
            return Ok(());
        }
        Begin::Start {
            handle,
            generation,
            cancel,
        } => (handle, generation, cancel),
    };
    let mut meter = Meter::default();
    let download = handle.download(
        |chunk, total| {
            if let Some(p) = meter.add(chunk, total) {
                let _ = on_progress.send(p);
            }
        },
        || {},
    );
    let result = tokio::select! {
        r = download => r.map_err(|e| classify(&e, Stage::Download)),
        _ = cancel => Err(UpdateError::Cancelled),
    };
    if let Err(e) = &result {
        log::warn!("update download failed: {}", e.code());
    }
    updates.finish_download(generation, result)?;
    Ok(())
}

#[tauri::command]
pub async fn cancel_update_download(updates: State<'_, AppUpdates>) -> Res<()> {
    updates.cancel_download();
    Ok(())
}

/// `confirmed`: the page asked the user (or found nothing open). Without it, running transfers
/// or unsaved editors refuse the install. Edited files with changes not uploaded refuse it
/// either way (`not_uploaded`): the page stops them explicitly (`stop_all_editing(true)`).
/// The exit does not go through the quit guard: Windows ends the process from the updater, and
/// elsewhere the restart request carries an exit code, which the guard never intercepts.
#[tauri::command]
pub async fn apply_update(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
    edits: State<'_, ExternalEdits>,
    transfers: State<'_, TransferManager>,
    guard: State<'_, QuitGuard>,
    exit: State<'_, ExitState>,
    confirmed: bool,
) -> Res<()> {
    let open = OpenWork {
        transfers: transfers.has_active(),
        unsaved_editors: guard.active(),
        unsynced_edits: edits.has_unsynced(),
    };
    may_apply(confirmed, open)?;
    let (handle, bytes) = updates.begin_install()?;
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let result = handle.install(&bytes);
        (result, bytes)
    })
    .await;
    let failed = |e: UpdateError, bytes: Option<Vec<u8>>| {
        let shutting_down = exit.shutting_down();
        if shutting_down && let Some(window) = app.get_webview_window("main") {
            // The exit hook hid the windows before the installer failed to start.
            let _ = window.show();
        }
        let e = install_error(e, shutting_down);
        log::warn!("update install failed: {}", e.code());
        updates.install_failed(bytes);
        CommandError::from(e)
    };
    match installed {
        Ok((Ok(()), _)) => {
            guard.allow_quit();
            app.request_restart();
            Ok(())
        }
        Ok((Err(e), bytes)) => {
            let e = classify(&e, Stage::Install);
            // A package the plugin refused is never offered again.
            let keep = (e != UpdateError::Signature).then_some(bytes);
            Err(failed(e, keep))
        }
        Err(_) => Err(failed(UpdateError::InstallFailed, None)),
    }
}

#[tauri::command]
pub async fn open_release_notes(version: String) -> Res<()> {
    let url = release_notes_url(&version)?;
    tauri::async_runtime::spawn_blocking(move || open::that_detached(url))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| UpdateError::Browser.into())
}

#[cfg(test)]
mod tests;
