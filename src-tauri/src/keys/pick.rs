use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tokio::sync::oneshot;

use super::error::KeyError;
use crate::{config, fsutil};

const MAX_PATH_CHARS: usize = 4096;

/// `Some` while a picker is open; the sender cancels the waiting command.
static PICKER: Mutex<Option<Option<oneshot::Sender<()>>>> = Mutex::new(None);

fn slot() -> std::sync::MutexGuard<'static, Option<Option<oneshot::Sender<()>>>> {
    PICKER.lock().unwrap_or_else(|e| e.into_inner())
}

/// At most one native picker at a time. Released on drop, so a command future that is
/// dropped or returns early never leaves the guard taken.
#[derive(Debug)]
pub struct PickerGuard(());

impl PickerGuard {
    /// The receiver resolves when `cancel_picker` is called (the window went away while the
    /// dialog was open, so its answer would never come or never matter).
    pub fn acquire() -> Option<(Self, oneshot::Receiver<()>)> {
        let mut slot = slot();
        if slot.is_some() {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        *slot = Some(Some(tx));
        Some((Self(()), rx))
    }
}

impl Drop for PickerGuard {
    fn drop(&mut self) {
        *slot() = None;
    }
}

/// Ends the wait of an open picker; its command returns `null` and releases the guard.
pub fn cancel_picker() {
    if let Some(Some(tx)) = slot().as_mut().map(Option::take) {
        let _ = tx.send(());
    }
}

/// A plain local path from a form field (absolute or `~/`), expanded; `None` for anything else,
/// templates included.
fn plain_path(current: Option<&str>) -> Option<PathBuf> {
    let raw = current?.trim();
    if raw.is_empty()
        || raw.contains("${")
        || raw.chars().count() > MAX_PATH_CHARS
        || raw.chars().any(char::is_control)
        || !(raw.starts_with("~/") || config::is_local_absolute(raw))
    {
        return None;
    }
    fsutil::expand_local(raw)
}

fn existing_dir(path: &Path) -> Option<PathBuf> {
    fsutil::canonical(path).ok().filter(|p| p.is_dir())
}

/// Start folder of the key folder picker: `current` when it is an existing directory, else the
/// managed keys directory, else the app home that holds it.
pub fn folder_start(current: Option<&str>, keys_dir: &Path) -> Option<PathBuf> {
    plain_path(current)
        .and_then(|p| existing_dir(&p))
        .or_else(|| existing_dir(keys_dir))
        .or_else(|| keys_dir.parent().and_then(existing_dir))
}

/// Start folder of the key file picker: the folder of `current` (or `current` itself when it is
/// a directory) if it exists, else `~/.ssh`, else the home directory.
pub fn file_start(current: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    let from_current = plain_path(current).and_then(|p| {
        if p.is_dir() {
            existing_dir(&p)
        } else {
            p.parent().and_then(existing_dir)
        }
    });
    from_current
        .or_else(|| home.and_then(|h| existing_dir(&h.join(".ssh"))))
        .or_else(|| home.and_then(existing_dir))
}

/// The path a picker returned, as the frontend gets it: absolute, without the `\\?\` prefix,
/// valid Unicode. Links are not resolved; the commands that use the path check it.
pub fn picked_path(path: PathBuf) -> Result<String, KeyError> {
    let path = fsutil::strip_verbatim(path);
    if !path.is_absolute() {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.pickedRelative",
            "the picker returned a relative path"
        )));
    }
    path.into_os_string().into_string().map_err(|_| {
        KeyError::invalid(crate::text!(
            "errors.keys.pathNotUnicode",
            "the path is not valid Unicode"
        ))
    })
}
