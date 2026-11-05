use std::path::{Path, PathBuf};

use secrecy::SecretString;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::error::CommandError;
use super::resolve::required;
use crate::analytics::{Analytics, Event, GeneratedType, ImportedType};
use crate::config::{ConfigStore, KeyAlgorithm, KeyEntry, KeyOrigin};
use crate::keys::{self, Deployed, KeyError, KeyInfo, KeyLocation, KeyType, PickerGuard};
use crate::secrets::{KeyPassKey, SecretStore, fits_keychain};
use crate::sftp::SftpManager;
use crate::ssh::SshManager;
use crate::text::Text;

type Res<T> = Result<T, CommandError>;

/// A registered key as the frontend sees it: the config entry, whether a passphrase is
/// remembered in the keychain, and a warning about the private key file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyView {
    #[serde(flatten)]
    pub key: KeyEntry,
    pub has_passphrase: bool,
    pub warning: Option<Text>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployResult {
    pub added: bool,
    /// The key is already there, but only on lines with options; nothing was changed.
    pub restricted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyLocationView {
    pub dir: String,
    pub is_default: bool,
    pub warning: Option<Text>,
}

fn view(secrets: &SecretStore, key: KeyEntry) -> KeyView {
    let has_passphrase = KeyPassKey::new(&key.id)
        .and_then(|k| secrets.has_key_passphrase(&k))
        .unwrap_or_else(|_| {
            log::warn!(
                "could not check the passphrase of key {} in the keychain",
                key.id
            );
            false
        });
    KeyView {
        warning: keys::permission_warning(&key.path),
        has_passphrase,
        key,
    }
}

fn keys_dir_of(store: &ConfigStore) -> PathBuf {
    keys::keys_dir(store.dir())
}

fn display(path: &Path) -> Res<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        CommandError::new(
            "invalid_input",
            crate::text!(
                "errors.keys.pathNotUnicode",
                "the path is not valid Unicode"
            ),
        )
    })
}

fn list(store: &ConfigStore, secrets: &SecretStore) -> Res<Vec<KeyView>> {
    Ok(store
        .snapshot()?
        .keys
        .into_iter()
        .map(|k| view(secrets, k))
        .collect())
}

/// Checked before any slow work, so a refused request costs nothing.
fn check_request(
    store: &ConfigStore,
    name: &str,
    passphrase: Option<&SecretString>,
    remember: bool,
) -> Res<()> {
    let name = crate::config::validate::key_name(name)?;
    if store
        .snapshot()?
        .keys
        .iter()
        .any(|k| k.name.to_lowercase() == name.to_lowercase())
    {
        return Err(CommandError::new(
            "already_exists",
            crate::text!(
                "errors.keys.nameTaken",
                "a key with this name already exists"
            ),
        ));
    }
    if let Some(p) = passphrase {
        keys::validate_passphrase(p)?;
    }
    match (remember, passphrase) {
        (true, None) => Err(CommandError::new(
            "invalid_input",
            crate::text!(
                "errors.keys.nothingToRemember",
                "there is no passphrase to remember"
            ),
        )),
        (true, Some(p)) if !fits_keychain(p) => Err(CommandError::new(
            "invalid_input",
            crate::text!(
                "errors.keys.passphraseTooLong",
                "the passphrase is too long for the system keychain"
            ),
        )),
        _ => Ok(()),
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, KeyError> + Send + 'static,
) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| {
            CommandError::new(
                "io",
                crate::text!("errors.keys.operationFailed", "the key operation failed"),
            )
        })?
        .map_err(CommandError::from)
}

fn entry(
    name: &str,
    path: &Path,
    managed: bool,
    origin: KeyOrigin,
    info: KeyInfo,
) -> Res<KeyEntry> {
    Ok(KeyEntry {
        id: Uuid::new_v4().to_string(),
        name: name.to_owned(),
        path: display(path)?,
        managed,
        origin,
        algorithm: info.algorithm,
        bits: info.bits,
        public_key: info.public_key,
        fingerprint: info.fingerprint,
        comment: info.comment,
        encrypted: info.encrypted,
    })
}

/// Saves the entry and, when asked, its passphrase, under the lifecycle lock so a delete can
/// never run in between and leave an orphaned keychain entry.
fn register(
    store: &ConfigStore,
    secrets: &SecretStore,
    entry: KeyEntry,
    remember: Option<&SecretString>,
) -> Res<KeyView> {
    let _lifecycle = secrets.lifecycle();
    let saved = store.add_key(entry)?;
    if let Some(p) = remember {
        let stored = KeyPassKey::new(&saved.id).and_then(|k| secrets.set_key_passphrase(&k, p));
        if stored.is_err() {
            return Err(CommandError::new(
                "keychain_unavailable",
                crate::text!(
                    "errors.keys.passphraseNotSaved",
                    "the key was added but its passphrase could not be saved in the system keychain"
                ),
            ));
        }
    }
    drop(_lifecycle);
    Ok(view(secrets, saved))
}

pub(super) struct GenerateRequest {
    pub name: String,
    pub file_name: String,
    /// `None` is the managed keys directory.
    pub dir: Option<String>,
    pub algorithm: KeyType,
    pub comment: String,
    pub passphrase: Option<SecretString>,
    pub remember_passphrase: bool,
}

async fn generate(
    store: &ConfigStore,
    secrets: &SecretStore,
    request: GenerateRequest,
) -> Res<KeyView> {
    let GenerateRequest {
        name,
        file_name,
        dir,
        algorithm,
        comment,
        passphrase,
        remember_passphrase,
    } = request;
    check_request(store, &name, passphrase.as_ref(), remember_passphrase)?;
    keys::validate_file_name(&file_name)?;
    let managed_dir = keys_dir_of(store);
    let (generated, passphrase) = {
        let managed_dir = managed_dir.clone();
        blocking(move || {
            let dir = keys::key_dir(&managed_dir, dir.as_deref())?;
            let generated =
                keys::generate(&dir, &file_name, algorithm, &comment, passphrase.as_ref());
            generated.map(|g| (g, passphrase))
        })
        .await?
    };
    let path_text = display(&generated.path)?;
    let fingerprint = generated.info.fingerprint.clone();
    let scope = generated.managed.then_some(managed_dir.as_path());
    let registered = entry(
        &name,
        &generated.path,
        generated.managed,
        KeyOrigin::Generated,
        generated.info,
    )
    .and_then(|e| {
        register(
            store,
            secrets,
            e,
            passphrase.as_ref().filter(|_| remember_passphrase),
        )
    });
    // A key nobody can see in the list is not left behind, unless only the keychain failed.
    if let Err(e) = &registered
        && e.code != "keychain_unavailable"
        && keys::remove_pair(&path_text, &fingerprint, scope).is_err()
    {
        log::warn!("could not remove the files of a key that was not registered");
    }
    registered
}

async fn import(
    store: &ConfigStore,
    secrets: &SecretStore,
    name: String,
    path: String,
    passphrase: Option<SecretString>,
    remember_passphrase: bool,
) -> Res<KeyView> {
    check_request(store, &name, passphrase.as_ref(), remember_passphrase)?;
    let ((canonical, info), passphrase) = blocking(move || {
        keys::inspect(&path, passphrase.as_ref()).map(|found| (found, passphrase))
    })
    .await?;
    let entry = entry(&name, &canonical, false, KeyOrigin::Imported, info)?;
    register(
        store,
        secrets,
        entry,
        passphrase.as_ref().filter(|_| remember_passphrase),
    )
}

async fn check_location(
    store: &ConfigStore,
    dir: Option<String>,
    file_name: String,
) -> Res<KeyLocationView> {
    let managed = keys_dir_of(store);
    let KeyLocation {
        dir,
        is_default,
        warning,
    } = blocking(move || keys::check_location(&managed, dir.as_deref(), &file_name)).await?;
    Ok(KeyLocationView {
        dir: display(&dir)?,
        is_default,
        warning,
    })
}

pub(super) fn busy() -> CommandError {
    CommandError::new(
        "busy",
        crate::text!("errors.keys.pickerBusy", "a file picker is already open"),
    )
}

fn picker_failed() -> CommandError {
    CommandError::new(
        "io",
        crate::text!(
            "errors.keys.pickerFailed",
            "the file picker could not be opened"
        ),
    )
}

pub(super) type Picked =
    std::pin::Pin<Box<dyn std::future::Future<Output = Option<rfd::FileHandle>> + Send>>;

/// Opens a native file dialog parented to the main window. The dialog is built on the main
/// thread (macOS requires it) and awaited on its own thread, like the OS dialog itself; the
/// command only waits on a channel. The webview has no dialog permission: only commands open
/// dialogs. `cancelled` (window gone) ends the wait with `None`.
pub(super) async fn native_dialog(
    app: &AppHandle,
    build: impl FnOnce(rfd::AsyncFileDialog) -> Picked + Send + 'static,
    cancelled: tokio::sync::oneshot::Receiver<()>,
) -> Res<Option<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let mut dialog = rfd::AsyncFileDialog::new();
        if let Some(window) = handle.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let picked = build(dialog);
        std::thread::spawn(move || {
            let chosen = tauri::async_runtime::block_on(picked);
            let _ = tx.send(chosen.map(|h| h.path().to_path_buf()));
        });
    })
    .map_err(|_| picker_failed())?;
    Ok(tokio::select! {
        picked = rx => picked.map_err(|_| picker_failed())?,
        _ = cancelled => None,
    })
}

pub(super) async fn pick(
    app: &AppHandle,
    title: &'static str,
    start: Option<PathBuf>,
    folder: bool,
    cancelled: tokio::sync::oneshot::Receiver<()>,
) -> Res<Option<String>> {
    let build = move |dialog: rfd::AsyncFileDialog| -> Picked {
        let mut dialog = dialog.set_title(title);
        if let Some(start) = start {
            dialog = dialog.set_directory(start);
        }
        if folder {
            Box::pin(dialog.pick_folder())
        } else {
            Box::pin(dialog.pick_file())
        }
    };
    let picked = native_dialog(app, build, cancelled).await?;
    Ok(picked.map(keys::picked_path).transpose()?)
}

fn rename(store: &ConfigStore, secrets: &SecretStore, key_id: &str, name: &str) -> Res<KeyView> {
    required("keyId", key_id)?;
    Ok(view(secrets, store.rename_key(key_id, name)?))
}

fn find(store: &ConfigStore, key_id: &str) -> Res<KeyEntry> {
    required("keyId", key_id)?;
    store.snapshot()?.key(key_id).cloned().ok_or_else(|| {
        CommandError::new(
            "not_found",
            crate::text!("errors.keys.keyNotFound", "key not found"),
        )
    })
}

fn delete(store: &ConfigStore, secrets: &SecretStore, key_id: &str, delete_files: bool) -> Res<()> {
    let found = find(store, key_id)?;
    if delete_files && found.origin != KeyOrigin::Generated {
        return Err(CommandError::new(
            "invalid_input",
            crate::text!(
                "errors.keys.importedFilesKept",
                "the files of an imported key are never deleted"
            ),
        ));
    }
    let managed_dir = keys_dir_of(store);
    let scope = found.managed.then_some(managed_dir.as_path());
    // Keychain and files go first and any failure stops here, so the key stays listed and the
    // user can retry; deleting the config entry first could leave a secret or files nobody
    // can see any more. The files are checked before the keychain, so a refused deletion keeps
    // the remembered passphrase too.
    let _lifecycle = secrets.lifecycle();
    if delete_files {
        keys::check_pair(&found.path, &found.fingerprint, scope)?;
    }
    secrets.delete_key_passphrase(&KeyPassKey::new(&found.id)?)?;
    if delete_files {
        keys::remove_pair(&found.path, &found.fingerprint, scope)?;
    }
    store.delete_key(key_id)?;
    Ok(())
}

fn forget_passphrase(store: &ConfigStore, secrets: &SecretStore, key_id: &str) -> Res<()> {
    let found = find(store, key_id)?;
    let key = KeyPassKey::new(&found.id)?;
    let _lifecycle = secrets.lifecycle();
    Ok(secrets.delete_key_passphrase(&key)?)
}

async fn deploy(
    store: &ConfigStore,
    ssh: &SshManager,
    sftp: &SftpManager,
    connection_id: &str,
    key_id: &str,
) -> Res<DeployResult> {
    required("connectionId", connection_id)?;
    let key = find(store, key_id)?;
    let line =
        blocking(move || keys::deployable_line(&key.path, &key.public_key, &key.comment)).await?;
    let remote = sftp.channel(ssh, connection_id).await?;
    let outcome = keys::deploy(&remote, &line).await?;
    Ok(DeployResult {
        added: outcome == Deployed::Added,
        restricted: outcome == Deployed::PresentWithOptions,
    })
}

#[tauri::command]
pub fn keys_dir(store: State<'_, ConfigStore>) -> Res<String> {
    display(&keys_dir_of(&store))
}

#[tauri::command]
pub async fn list_keys(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
) -> Res<Vec<KeyView>> {
    list(&store, &secrets)
}

/// Flat arguments, like the other commands; that makes nine with the two states.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_key(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    analytics: State<'_, Analytics>,
    name: String,
    file_name: String,
    algorithm: KeyType,
    comment: String,
    passphrase: Option<SecretString>,
    remember_passphrase: bool,
    dir: Option<String>,
) -> Res<KeyView> {
    let request = GenerateRequest {
        name,
        file_name,
        dir,
        algorithm,
        comment,
        passphrase,
        remember_passphrase,
    };
    generate_observed(&store, &secrets, &analytics, request).await
}

pub(super) async fn generate_observed(
    store: &ConfigStore,
    secrets: &SecretStore,
    analytics: &Analytics,
    request: GenerateRequest,
) -> Res<KeyView> {
    let key_type = match request.algorithm {
        KeyType::Ed25519 => GeneratedType::Ed25519,
        KeyType::Rsa4096 => GeneratedType::Rsa4096,
    };
    let view = generate(store, secrets, request).await?;
    analytics.record(Event::KeyGenerated {
        key_type,
        custom_folder: !view.key.managed,
    });
    Ok(view)
}

#[tauri::command]
pub async fn check_key_location(
    store: State<'_, ConfigStore>,
    dir: Option<String>,
    file_name: String,
) -> Res<KeyLocationView> {
    check_location(&store, dir, file_name).await
}

#[tauri::command]
pub async fn pick_key_folder(
    app: AppHandle,
    store: State<'_, ConfigStore>,
    current: Option<String>,
) -> Res<Option<String>> {
    let (_open, cancelled) = PickerGuard::acquire().ok_or_else(busy)?;
    let keys_dir = keys_dir_of(&store);
    let start = blocking(move || Ok(keys::folder_start(current.as_deref(), &keys_dir))).await?;
    let title = crate::native_text::get(crate::native_text::NativeText::PickKeyFolder);
    pick(&app, title, start, true, cancelled).await
}

#[tauri::command]
pub async fn pick_key_file(app: AppHandle, current: Option<String>) -> Res<Option<String>> {
    let (_open, cancelled) = PickerGuard::acquire().ok_or_else(busy)?;
    let start = blocking(move || {
        Ok(keys::file_start(
            current.as_deref(),
            std::env::home_dir().as_deref(),
        ))
    })
    .await?;
    let title = crate::native_text::get(crate::native_text::NativeText::PickKeyFile);
    pick(&app, title, start, false, cancelled).await
}

#[tauri::command]
pub async fn import_key(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    analytics: State<'_, Analytics>,
    name: String,
    path: String,
    passphrase: Option<SecretString>,
    remember_passphrase: bool,
) -> Res<KeyView> {
    let view = import(
        &store,
        &secrets,
        name,
        path,
        passphrase,
        remember_passphrase,
    )
    .await?;
    record_import(&analytics, &view);
    Ok(view)
}

pub(super) fn record_import(analytics: &Analytics, view: &KeyView) {
    analytics.record(Event::KeyImported {
        key_type: match view.key.algorithm {
            KeyAlgorithm::Ed25519 => ImportedType::Ed25519,
            KeyAlgorithm::Rsa => ImportedType::Rsa,
        },
    });
}

#[tauri::command]
pub async fn rename_key(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    key_id: String,
    name: String,
) -> Res<KeyView> {
    rename(&store, &secrets, &key_id, &name)
}

#[tauri::command]
pub async fn delete_key(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    key_id: String,
    delete_files: bool,
) -> Res<()> {
    delete(&store, &secrets, &key_id, delete_files)
}

#[tauri::command]
pub async fn forget_key_passphrase(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    key_id: String,
) -> Res<()> {
    forget_passphrase(&store, &secrets, &key_id)
}

#[tauri::command]
pub async fn deploy_public_key(
    store: State<'_, ConfigStore>,
    ssh: State<'_, SshManager>,
    sftp: State<'_, SftpManager>,
    connection_id: String,
    key_id: String,
) -> Res<DeployResult> {
    deploy(&store, &ssh, &sftp, &connection_id, &key_id).await
}

#[cfg(test)]
mod tests;
