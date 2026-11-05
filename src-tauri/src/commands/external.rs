use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::error::CommandError;
use super::keys::pick;
use crate::config::{self, ConfigFile, ConfigStore, EditorMode, ExternalEditor, Node};
use crate::external::{
    Choice, EditError, EditEvent, EditedFile, ExternalEdits, OpenRequest, Opener, check_app,
};
use crate::files::MAX_PATH_BYTES;
use crate::keys::PickerGuard;

type Res<T> = Result<T, CommandError>;

const MAX_ID_CHARS: usize = 64;
const MAX_APP_PATH_CHARS: usize = 4096;

impl From<EditError> for CommandError {
    fn from(e: EditError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

fn required(name: &str, value: &str) -> Res<()> {
    if value.trim().is_empty() || value.chars().count() > MAX_ID_CHARS {
        return Err(CommandError::new(
            "invalid_input",
            format!("{name} is required (at most {MAX_ID_CHARS} characters)"),
        ));
    }
    Ok(())
}

fn check_path(path: &str) -> Res<()> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err(CommandError::new("invalid_input", "path is invalid"));
    }
    Ok(())
}

/// The opener the settings ask for; a custom mode without an app uses the system default.
pub fn opener_of(cfg: Option<&ExternalEditor>) -> Opener {
    match cfg {
        Some(ExternalEditor {
            mode: EditorMode::Custom,
            app_path: Some(app),
            ..
        }) => Opener::App(PathBuf::from(app)),
        _ => Opener::System,
    }
}

#[tauri::command]
pub async fn open_external(
    edits: State<'_, ExternalEdits>,
    connection_id: String,
    path: String,
    size: Option<u64>,
    confirm_large: Option<bool>,
    confirm_sensitive: Option<bool>,
) -> Res<EditedFile> {
    required("connectionId", &connection_id)?;
    check_path(&path)?;
    Ok(edits
        .open(OpenRequest {
            connection_id: &connection_id,
            path: &path,
            size,
            confirm_large: confirm_large.unwrap_or(false),
            confirm_sensitive: confirm_sensitive.unwrap_or(false),
        })
        .await?)
}

#[tauri::command]
pub fn subscribe_edited(
    edits: State<'_, ExternalEdits>,
    on_event: Channel<EditEvent>,
) -> Vec<EditedFile> {
    edits.subscribe(Arc::new(move |event| on_event.send(event).is_ok()))
}

#[tauri::command]
pub fn list_edited(edits: State<'_, ExternalEdits>) -> Vec<EditedFile> {
    edits.list()
}

#[tauri::command]
pub fn has_unsynced(edits: State<'_, ExternalEdits>) -> bool {
    edits.has_unsynced()
}

#[tauri::command]
pub async fn upload_now(edits: State<'_, ExternalEdits>, id: String) -> Res<EditedFile> {
    required("id", &id)?;
    Ok(edits.upload_now(&id).await?)
}

#[tauri::command]
pub async fn resolve_conflict(
    edits: State<'_, ExternalEdits>,
    id: String,
    choice: Choice,
    confirm_large: Option<bool>,
) -> Res<EditedFile> {
    required("id", &id)?;
    Ok(edits
        .resolve(&id, choice, confirm_large.unwrap_or(false))
        .await?)
}

#[tauri::command]
pub async fn stop_editing(edits: State<'_, ExternalEdits>, id: String, force: bool) -> Res<()> {
    required("id", &id)?;
    Ok(edits.stop(&id, force).await?)
}

#[tauri::command]
pub async fn stop_all_editing(edits: State<'_, ExternalEdits>, force: bool) -> Res<usize> {
    Ok(edits.stop_all(force).await?)
}

#[tauri::command]
pub async fn discard_recovered(edits: State<'_, ExternalEdits>, id: String) -> Res<()> {
    required("id", &id)?;
    Ok(edits.discard(&id).await?)
}

#[tauri::command]
pub async fn reveal(edits: State<'_, ExternalEdits>, id: String) -> Res<()> {
    required("id", &id)?;
    Ok(edits.reveal(&id).await?)
}

/// What a delete confirmation is about.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeleteTarget {
    Host { id: String },
    Collection { id: String },
    Project { id: String },
}

/// Host ids a delete of `target` would remove.
pub fn hosts_of(cfg: &ConfigFile, target: &DeleteTarget) -> Vec<String> {
    let hosts = |nodes: Vec<&Node>| -> Vec<String> {
        nodes
            .into_iter()
            .filter_map(Node::as_host)
            .map(|h| h.id.clone())
            .collect()
    };
    match target {
        DeleteTarget::Host { id } => vec![id.clone()],
        DeleteTarget::Collection { id } => hosts(cfg.subtree(id)),
        DeleteTarget::Project { id } => hosts(
            cfg.nodes
                .iter()
                .filter(|n| n.project_id() == Some(id.as_str()))
                .collect(),
        ),
    }
}

/// Edited files that deleting `target` would stop (and delete the copies of).
#[tauri::command]
pub async fn edited_affected(
    store: State<'_, ConfigStore>,
    edits: State<'_, ExternalEdits>,
    target: DeleteTarget,
) -> Res<Vec<EditedFile>> {
    let (DeleteTarget::Host { id }
    | DeleteTarget::Collection { id }
    | DeleteTarget::Project { id }) = &target;
    required("id", id)?;
    let hosts = hosts_of(&store.snapshot()?, &target);
    Ok(edits.affected(&hosts))
}

#[tauri::command]
pub async fn get_external_editor(store: State<'_, ConfigStore>) -> Res<ExternalEditor> {
    Ok(store.external_editor()?.unwrap_or_default())
}

/// A plain local path to an existing program (no template, no arguments).
pub fn check_app_path(raw: &str) -> Res<String> {
    let path = raw.trim();
    if path.is_empty()
        || path.chars().count() > MAX_APP_PATH_CHARS
        || path.chars().any(char::is_control)
        || path.contains("${")
        || !config::is_local_absolute(path)
    {
        return Err(CommandError::new(
            "invalid_input",
            "the editor app must be an absolute path on this computer",
        ));
    }
    check_app(Path::new(path))?;
    Ok(path.to_owned())
}

#[tauri::command]
pub async fn set_external_editor(
    store: State<'_, ConfigStore>,
    mode: EditorMode,
    app_path: Option<String>,
    notice_seen: bool,
) -> Res<ExternalEditor> {
    set_editor_in(&store, mode, app_path, notice_seen)
}

pub(super) fn set_editor_in(
    store: &ConfigStore,
    mode: EditorMode,
    app_path: Option<String>,
    notice_seen: bool,
) -> Res<ExternalEditor> {
    let app_path = app_path.as_deref().map(check_app_path).transpose()?;
    let value = ExternalEditor {
        mode,
        app_path,
        notice_seen,
    };
    store.set_external_editor(value.clone())?;
    Ok(value)
}

/// Native picker for the editor app, parented to the main window.
#[tauri::command]
pub async fn pick_external_editor(app: AppHandle, current: Option<String>) -> Res<Option<String>> {
    let (_open, cancelled) = PickerGuard::acquire()
        .ok_or_else(|| CommandError::new("busy", "a file picker is already open"))?;
    let start = current
        .as_deref()
        .and_then(|c| check_app_path(c).ok())
        .and_then(|p| Path::new(&p).parent().map(Path::to_path_buf));
    pick(&app, "Choose the editor app", start, false, cancelled).await
}

#[cfg(test)]
mod tests;
