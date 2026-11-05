use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::error::CommandError;
use super::resolve::required;
use super::secrets::forget_saved;
use super::ssh::close_hosts;
use crate::config::{ConfigError, ConfigFile, ConfigStore, Node};
use crate::data_transfer::export::{self, Counts, ExportInput, ExportScope};
use crate::data_transfer::format::{self, DataFile, FileScope, ParseError};
use crate::data_transfer::pending::{AppliedState, Pending, PendingImports};
use crate::data_transfer::plan::{
    ImportPlan, KeyProbe, KeychainWork, NeedsSecret, PlanItem, Renamed, Row, Strategy, VarAccount,
};
use crate::data_transfer::{self as data, Inputs, Stamp, backup};
use crate::external::ExternalEdits;
use crate::fsutil;
use crate::keys::PickerGuard;
use crate::secrets::{SavedKey, SecretKind, SecretStore, VarKey};
use crate::ssh::SshManager;

type Res<T> = Result<T, CommandError>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DataScope {
    All,
    Home,
    Project { project_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// Base name only.
    pub file_name: String,
    pub counts: Counts,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileScopeView {
    All,
    Home,
    Project { project_name: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    pub scope: FileScopeView,
    pub exported_at: Option<String>,
    pub app_version: Option<String>,
    pub counts: Counts,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Plans {
    pub merge: ImportPlan,
    pub replace: ImportPlan,
    pub duplicate: ImportPlan,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub import_id: String,
    pub file_name: String,
    pub file: FileFacts,
    pub plans: Plans,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub rows: Vec<Row>,
    pub renamed: Vec<Renamed>,
    pub skipped: Vec<PlanItem>,
    pub disconnected: Vec<String>,
    pub needs_secret: Vec<NeedsSecret>,
    pub backup_name: String,
    pub secret_values_deleted: usize,
}

fn invalid(message: &str) -> CommandError {
    CommandError::new("invalid_input", message)
}

fn expired() -> CommandError {
    CommandError::new("not_found", "This preview expired. Choose the file again.")
}

impl From<ParseError> for CommandError {
    fn from(e: ParseError) -> Self {
        Self::new(e.code(), e.message())
    }
}

fn read_error(e: &io::Error) -> CommandError {
    match e.kind() {
        ErrorKind::FileTooLarge => {
            CommandError::new("too_large", "Carapace data files are at most 8 MB.")
        }
        ErrorKind::NotFound => CommandError::new("not_found", "The file was not found."),
        ErrorKind::PermissionDenied => {
            CommandError::new("permission_denied", "Carapace cannot read this file.")
        }
        ErrorKind::InvalidInput => invalid("This is not a regular file."),
        _ => CommandError::new("io", "The file could not be read."),
    }
}

fn write_error(e: &io::Error) -> CommandError {
    match e.kind() {
        ErrorKind::PermissionDenied => CommandError::new(
            "permission_denied",
            "Carapace cannot write to this folder. Choose another one.",
        ),
        ErrorKind::NotFound => CommandError::new("not_found", "This folder does not exist."),
        _ => CommandError::new("io", "The file could not be written."),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| CommandError::new("io", "the operation failed"))?
}

/// Only paths on a local drive reach the file system: opening a UNC path would authenticate to
/// that host.
fn local(path: PathBuf) -> Res<PathBuf> {
    let path = fsutil::strip_verbatim(path);
    if !fsutil::is_local_path(&path) {
        return Err(invalid("Choose a file on this computer."));
    }
    if !fsutil::links_stay_local(&path) {
        return Err(invalid(
            "This file is on a network drive or links outside this computer. Choose a file on this computer.",
        ));
    }
    Ok(path)
}

fn base_name(path: &Path) -> Res<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned)
        .ok_or_else(|| invalid("The file name is not valid Unicode."))
}

/// The folder and name to write the export to. Never inside the app home, whose files the
/// export would replace.
pub(super) fn export_target(path: PathBuf, home: &Path) -> Res<(PathBuf, String)> {
    let path = local(path)?;
    let name = base_name(&path)?;
    let dir = path
        .parent()
        .filter(|d| d.is_dir())
        .ok_or_else(|| CommandError::new("not_found", "This folder does not exist."))?
        .to_path_buf();
    if data::inside_home(&dir, home) {
        return Err(invalid("Choose a folder outside the Carapace data folder."));
    }
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
        return Err(invalid("A folder has this name. Choose another file name."));
    }
    Ok((dir, name))
}

/// Reads and checks a picked file. Errors name the file (`file “name.json”: …`), never its
/// folder.
pub(super) fn read_import(path: PathBuf) -> Res<(String, DataFile)> {
    let shown = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let named =
        |e: CommandError| CommandError::new(e.code, format!("file “{shown}”: {}", e.message));
    let read = || -> Res<(String, DataFile)> {
        let path = local(path)?;
        let name = base_name(&path)?;
        let raw = fsutil::read_regular_capped(&path, format::MAX_FILE_BYTES, true)
            .map_err(|e| read_error(&e))?;
        Ok((name, format::parse(&raw)?))
    };
    read().map_err(named)
}

fn var_key(a: &VarAccount) -> Option<VarKey> {
    match &a.project_id {
        None => VarKey::global(&a.name),
        Some(p) => VarKey::project(p, &a.name),
    }
    .ok()
}

/// Keychain lookups for one plan computation, once per account.
fn has_value(secrets: &SecretStore) -> impl Fn(&VarAccount) -> bool + '_ {
    let cache: RefCell<HashMap<VarAccount, bool>> = RefCell::default();
    move |a| {
        if let Some(v) = cache.borrow().get(a) {
            return *v;
        }
        let found = var_key(a).is_some_and(|k| {
            secrets.has_var(&k).unwrap_or_else(|_| {
                log::warn!("could not check a secret variable in the keychain");
                false
            })
        });
        cache.borrow_mut().insert(a.clone(), found);
        found
    }
}

/// Every delete must succeed, else nothing is written; `removed` counts the values already
/// deleted when a later one fails. Logged by id or count only.
fn delete_keychain(
    secrets: &SecretStore,
    work: &KeychainWork,
    removed: &std::cell::Cell<usize>,
) -> Result<(), ConfigError> {
    let fail = || {
        log::warn!("a keychain delete failed while importing; nothing was imported");
        ConfigError::Keychain
    };
    for a in &work.variables {
        let key = var_key(a).ok_or_else(fail)?;
        let had = secrets.has_var(&key).map_err(|_| fail())?;
        secrets.delete_var(&key).map_err(|_| fail())?;
        if had {
            removed.set(removed.get() + 1);
        }
    }
    for host in &work.saved_hosts {
        let key = SavedKey::new(host).map_err(|_| fail())?;
        for kind in SecretKind::ALL {
            let had = secrets.has_saved(&key, kind).map_err(|_| fail())?;
            secrets.delete_saved(&key, kind).map_err(|_| {
                log::warn!("could not delete the saved secrets of host {host} while importing");
                ConfigError::Keychain
            })?;
            if had {
                removed.set(removed.get() + 1);
            }
        }
    }
    Ok(())
}

async fn connected(ssh: &SshManager) -> HashSet<String> {
    ssh.list().await.into_iter().map(|c| c.host_id).collect()
}

fn facts(file: &DataFile) -> FileFacts {
    let scope = match &file.scope {
        FileScope::All => FileScopeView::All,
        FileScope::Home => FileScopeView::Home,
        FileScope::Project { .. } => FileScopeView::Project {
            project_name: file
                .projects
                .first()
                .map(|p| p.name.clone())
                .unwrap_or_default(),
        },
    };
    FileFacts {
        scope,
        exported_at: file.exported_at.clone(),
        app_version: file.app_version.clone(),
        counts: export::counts(file),
    }
}

fn plans(
    local: &ConfigFile,
    secrets: &SecretStore,
    file: &DataFile,
    keys: &[KeyProbe],
    connected: &HashSet<String>,
) -> Plans {
    let lookup = has_value(secrets);
    let inputs = Inputs {
        file,
        keys,
        connected,
        has_value: &lookup,
    };
    let [merge, replace, duplicate] = data::preview(local, &inputs).map(|o| o.plan);
    Plans {
        merge,
        replace,
        duplicate,
    }
}

/// Computes the three plans and makes the file the pending import (dropping any earlier one).
pub(super) fn start_preview(
    store: &ConfigStore,
    secrets: &SecretStore,
    pending: &PendingImports,
    file_name: String,
    file: DataFile,
    keys: &[KeyProbe],
    connected: &HashSet<String>,
) -> Res<ImportPreview> {
    let (local, revision) = store.snapshot_revision()?;
    let plans = plans(&local, secrets, &file, keys, connected);
    let file_facts = facts(&file);
    let import_id = pending.start(file_name.clone(), file, revision);
    Ok(ImportPreview {
        import_id,
        file_name,
        file: file_facts,
        plans,
    })
}

fn waiting(pending: &PendingImports, import_id: &str) -> Res<Pending> {
    required("importId", import_id)?;
    let p = pending.get(import_id).ok_or_else(expired)?;
    if p.applied.is_some() {
        return Err(invalid("This file was already imported."));
    }
    Ok(p)
}

pub(super) fn refresh_preview(
    store: &ConfigStore,
    secrets: &SecretStore,
    pending: &PendingImports,
    import_id: &str,
    keys: &[KeyProbe],
    connected: &HashSet<String>,
) -> Res<ImportPreview> {
    let p = waiting(pending, import_id)?;
    let (local, revision) = store.snapshot_revision()?;
    let plans = plans(&local, secrets, &p.file, keys, connected);
    if !pending.update(import_id, |q| q.revision = revision) {
        return Err(expired());
    }
    Ok(ImportPreview {
        import_id: p.id,
        file_name: p.file_name,
        file: facts(&p.file),
        plans,
    })
}

/// The store and keychain part of the apply, under the lifecycle lock (never across an await);
/// the caller closes connections afterwards.
pub(super) fn apply_pending(
    store: &ConfigStore,
    secrets: &SecretStore,
    pending: &PendingImports,
    import_id: &str,
    strategy: Strategy,
    keys: &[KeyProbe],
    connected: &HashSet<String>,
) -> Res<(ImportResult, ImportPlan)> {
    let p = waiting(pending, import_id)?;
    let lookup = has_value(secrets);
    let inputs = Inputs {
        file: &p.file,
        keys,
        connected,
        has_value: &lookup,
    };
    let removed = std::cell::Cell::new(0);
    let applied = {
        let _lifecycle = secrets.lifecycle();
        data::apply(
            store,
            &inputs,
            &p.revision,
            strategy,
            SystemTime::now(),
            |work| delete_keychain(secrets, work, &removed),
        )
    }
    .map_err(|e| match e {
        ConfigError::Changed => {
            CommandError::new("conflict", "Your data changed since this preview.")
        }
        ConfigError::Keychain => match removed.get() {
            0 => CommandError::new(
                "keychain_unavailable",
                "The system keychain is not available. Nothing was imported.",
            ),
            n => CommandError::new(
                "keychain_unavailable",
                format!(
                    "Nothing was imported, but {n} secret values were already removed from the keychain."
                ),
            ),
        },
        other => CommandError::from(other),
    })?;
    let state = AppliedState {
        backup: applied.backup.clone(),
        revision: applied.revision.clone(),
    };
    pending.update(import_id, |q| q.applied = Some(state));
    log::info!("data imported; backup {}", applied.backup.name);
    let o = applied.outcome;
    let result = ImportResult {
        rows: o.plan.rows.clone(),
        renamed: o.renamed,
        skipped: o.skipped,
        disconnected: o.plan.affected_connected_hosts.clone(),
        needs_secret: o.plan.needs_secret.clone(),
        backup_name: applied.backup.name,
        secret_values_deleted: o.plan.secret_values_deleted,
    };
    Ok((result, o.plan))
}

fn hosts_of(cfg: &ConfigFile) -> HashMap<&str, Option<&str>> {
    cfg.nodes
        .iter()
        .filter_map(Node::as_host)
        .map(|h| (h.id.as_str(), h.project_id.as_deref()))
        .collect()
}

/// Hosts the restore removes, and hosts it moves to another scope.
fn restore_changes(before: &ConfigFile, after: &ConfigFile) -> (Vec<String>, Vec<String>) {
    let after = hosts_of(after);
    let (mut removed, mut moved) = (Vec::new(), Vec::new());
    for (id, scope) in hosts_of(before) {
        match after.get(id) {
            None => removed.push(id.to_owned()),
            Some(s) if *s != scope => moved.push(id.to_owned()),
            Some(_) => {}
        }
    }
    (removed, moved)
}

/// Restores the backup when `data.json` is still the file the import wrote. Returns the hosts
/// removed and moved by the restore.
pub(super) fn undo_pending(
    store: &ConfigStore,
    secrets: &SecretStore,
    pending: &PendingImports,
    import_id: &str,
    bytes: &[u8],
) -> Res<(Vec<String>, Vec<String>)> {
    required("importId", import_id)?;
    let p = pending.get(import_id).ok_or_else(expired)?;
    let applied = p
        .applied
        .ok_or_else(|| invalid("Nothing was imported from this file."))?;
    let (before, after) = {
        let _lifecycle = secrets.lifecycle();
        store.restore_data(&applied.revision, bytes, |cur, restored| {
            let (removed, moved) = restore_changes(cur, restored);
            for h in removed.iter().chain(&moved) {
                forget_saved(secrets, h);
            }
        })
    }
    .map_err(|e| match e {
        ConfigError::Changed => CommandError::new(
            "conflict",
            "Your data changed since the import, so it was not restored.",
        ),
        other => CommandError::from(other),
    })?;
    pending.cancel(import_id);
    log::info!("data import undone");
    Ok(restore_changes(&before, &after))
}

pub(super) fn backup_bytes(pending: &PendingImports, import_id: &str) -> Res<PathBuf> {
    required("importId", import_id)?;
    let p = pending.get(import_id).ok_or_else(expired)?;
    let applied = p
        .applied
        .ok_or_else(|| invalid("Nothing was imported from this file."))?;
    Ok(applied.backup.path)
}

fn export_scope(scope: &DataScope) -> Res<ExportScope> {
    Ok(match scope {
        DataScope::All => ExportScope::All,
        DataScope::Home => ExportScope::Home,
        DataScope::Project { project_id } => {
            required("projectId", project_id)?;
            ExportScope::Project(project_id.clone())
        }
    })
}

fn unknown_project() -> CommandError {
    invalid("This project does not exist.")
}

/// The file bytes of an export of the current data.
pub(super) fn export_bytes(
    store: &ConfigStore,
    scope: &ExportScope,
    include_shared: bool,
    app_version: &str,
    now: SystemTime,
) -> Res<(Vec<u8>, Counts)> {
    let cfg = store.snapshot()?;
    let home = std::env::home_dir();
    let input = ExportInput {
        scope,
        include_shared,
        home: home.as_deref(),
        exported_at: Stamp::of(now).rfc3339(),
        app_version,
    };
    let file = export::build(&cfg, &input).ok_or_else(unknown_project)?;
    Ok((format::to_bytes(&file), export::counts(&file)))
}

enum Dialog {
    Save(String),
    Open,
}

#[cfg(feature = "e2e-pickers")]
async fn pick_data_file(
    _app: &AppHandle,
    dialog: Dialog,
    _cancelled: tokio::sync::oneshot::Receiver<()>,
) -> Res<Option<PathBuf>> {
    if let Dialog::Save(name) = dialog {
        log::info!("e2e picker: save dialog skipped (suggested {name})");
    }
    Ok(std::env::var_os("CARAPACE_E2E_PICKED_FILE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from))
}

#[cfg(not(feature = "e2e-pickers"))]
async fn pick_data_file(
    app: &AppHandle,
    dialog: Dialog,
    cancelled: tokio::sync::oneshot::Receiver<()>,
) -> Res<Option<PathBuf>> {
    use tauri::Manager;
    let start = app
        .path()
        .document_dir()
        .ok()
        .filter(|d| d.is_dir())
        .or_else(std::env::home_dir);
    let build = move |d: rfd::AsyncFileDialog| -> super::keys::Picked {
        let mut d = d.add_filter("Carapace data", &["json"]);
        if let Some(start) = start {
            d = d.set_directory(start);
        }
        match dialog {
            Dialog::Save(name) => Box::pin(
                d.set_title("Export Carapace data")
                    .set_file_name(name)
                    .save_file(),
            ),
            Dialog::Open => Box::pin(
                d.add_filter("All files", &["*"])
                    .set_title("Import Carapace data")
                    .pick_file(),
            ),
        }
    };
    super::keys::native_dialog(app, build, cancelled).await
}

/// Opens the save dialog itself: no path ever comes from the webview. `null` = cancelled.
#[tauri::command]
pub async fn export_data(
    app: AppHandle,
    store: State<'_, ConfigStore>,
    scope: DataScope,
    include_shared: bool,
) -> Res<Option<ExportResult>> {
    let scope = export_scope(&scope)?;
    let now = SystemTime::now();
    let cfg = store.snapshot()?;
    let project_name = match &scope {
        ExportScope::Project(id) => Some(cfg.project(id).ok_or_else(unknown_project)?.name.clone()),
        _ => None,
    };
    let default_name =
        export::default_file_name(&scope, project_name.as_deref(), &Stamp::of(now).date());
    let (_open, cancelled) = PickerGuard::acquire().ok_or_else(super::keys::busy)?;
    let Some(path) = pick_data_file(&app, Dialog::Save(default_name), cancelled).await? else {
        return Ok(None);
    };
    let home = store.dir().to_path_buf();
    let (dir, file_name) = blocking(move || export_target(path, &home)).await?;
    let version = app.package_info().version.to_string();
    let (bytes, counts) = export_bytes(&store, &scope, include_shared, &version, now)?;
    let name = file_name.clone();
    blocking(move || {
        fsutil::write_replace(&dir, &name, &bytes)
            .map(|_| ())
            .map_err(|e| write_error(&e))
    })
    .await?;
    Ok(Some(ExportResult { file_name, counts }))
}

/// Opens the open dialog, reads and checks the file, and returns the three plans; `null` =
/// cancelled.
#[tauri::command]
pub async fn preview_import(
    app: AppHandle,
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    ssh: State<'_, SshManager>,
    pending: State<'_, PendingImports>,
) -> Res<Option<ImportPreview>> {
    let (_open, cancelled) = PickerGuard::acquire().ok_or_else(super::keys::busy)?;
    let Some(path) = pick_data_file(&app, Dialog::Open, cancelled).await? else {
        return Ok(None);
    };
    drop(_open);
    let (name, file) = blocking(move || read_import(path)).await?;
    let keys = probe(&store, file.keys.clone()).await?;
    let connected = connected(&ssh).await;
    start_preview(&store, &secrets, &pending, name, file, &keys, &connected).map(Some)
}

/// Key files of the file, inspected only where `probe_keys` allows it.
async fn probe(store: &ConfigStore, keys: Vec<format::FileKey>) -> Res<Vec<KeyProbe>> {
    let registered: Vec<String> = store.snapshot()?.keys.into_iter().map(|k| k.path).collect();
    blocking(move || {
        let home = std::env::home_dir();
        Ok(data::probe_keys(&keys, &registered, home.as_deref()))
    })
    .await
}

async fn probe_pending(
    store: &ConfigStore,
    pending: &PendingImports,
    import_id: &str,
) -> Res<Vec<KeyProbe>> {
    let p = waiting(pending, import_id)?;
    probe(store, p.file.keys.clone()).await
}

#[tauri::command]
pub async fn refresh_import(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    ssh: State<'_, SshManager>,
    pending: State<'_, PendingImports>,
    import_id: String,
) -> Res<ImportPreview> {
    let keys = probe_pending(&store, &pending, &import_id).await?;
    let connected = connected(&ssh).await;
    refresh_preview(&store, &secrets, &pending, &import_id, &keys, &connected)
}

#[tauri::command]
pub async fn apply_import(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    ssh: State<'_, SshManager>,
    edits: State<'_, ExternalEdits>,
    pending: State<'_, PendingImports>,
    import_id: String,
    strategy: Strategy,
) -> Res<ImportResult> {
    let keys = probe_pending(&store, &pending, &import_id).await?;
    let connected = connected(&ssh).await;
    let (result, plan) = apply_pending(
        &store, &secrets, &pending, &import_id, strategy, &keys, &connected,
    )?;
    let mut closing = plan.removed_host_ids.clone();
    closing.extend(plan.moved_host_ids.iter().cloned());
    close_hosts(&ssh, &closing).await;
    edits.forget_hosts(&plan.removed_host_ids);
    Ok(result)
}

#[tauri::command]
pub async fn undo_import(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    ssh: State<'_, SshManager>,
    edits: State<'_, ExternalEdits>,
    pending: State<'_, PendingImports>,
    import_id: String,
) -> Res<()> {
    let path = backup_bytes(&pending, &import_id)?;
    let bytes = blocking(move || {
        backup::read(&path).map_err(|e| match e.kind() {
            ErrorKind::NotFound => CommandError::new("not_found", "The backup file is missing."),
            _ => CommandError::new("io", "The backup file could not be read."),
        })
    })
    .await?;
    let (removed, moved) = undo_pending(&store, &secrets, &pending, &import_id, &bytes)?;
    let closing: Vec<String> = removed.iter().chain(&moved).cloned().collect();
    close_hosts(&ssh, &closing).await;
    edits.forget_hosts(&removed);
    Ok(())
}

/// Drops the pending import and its undo state; an unknown id is fine.
#[tauri::command]
pub fn cancel_import(pending: State<'_, PendingImports>, import_id: String) {
    pending.cancel(&import_id);
}

#[cfg(test)]
mod tests;
