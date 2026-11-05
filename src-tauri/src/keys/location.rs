use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use super::error::KeyError;
use super::file::validate_file_name;
use crate::text::Text;
use crate::{config, fsutil, localfs};

const MAX_PATH_CHARS: usize = 4096;

/// Where a key pair is written. `managed` is the app's own keys directory, created and kept
/// owner-only; any other folder must exist and is never created or changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyDir {
    pub path: PathBuf,
    pub managed: bool,
    /// The custom folder that was checked; generation refuses another one at the same path.
    id: Option<fsutil::DirId>,
}

impl KeyDir {
    pub fn managed(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            managed: true,
            id: None,
        }
    }
}

/// The result of checking a folder before generating into it.
#[derive(Debug, Clone, PartialEq)]
pub struct KeyLocation {
    /// Canonical, except for a managed directory that does not exist yet.
    pub dir: PathBuf,
    pub is_default: bool,
    pub warning: Option<Text>,
}

fn folder_io(e: io::Error, path: &Path) -> KeyError {
    match e.kind() {
        ErrorKind::NotFound => KeyError::MissingFolder,
        ErrorKind::PermissionDenied => KeyError::ReadOnlyFolder,
        _ => KeyError::Io(path.display().to_string()),
    }
}

/// A real directory at `path` itself: a link or junction is refused even when it points to
/// a directory, so the folder the user sees is the one written to.
fn link_refused() -> KeyError {
    KeyError::invalid(crate::text!(
        "errors.keys.folderIsLink",
        "Links are not accepted. Choose the real folder."
    ))
}

fn real_dir(path: &Path) -> Result<(), KeyError> {
    let meta = fs::symlink_metadata(path).map_err(|e| folder_io(e, path))?;
    if localfs::is_link(&meta) {
        return Err(link_refused());
    }
    if !meta.is_dir() {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.folderIsFile",
            "This is a file, not a folder."
        )));
    }
    Ok(())
}

/// Resolves the folder of a generation: `None` is the managed directory, anything else must be
/// absolute or start with `~/` and be an existing real directory. A custom folder that is the
/// managed directory counts as managed.
pub fn key_dir(managed: &Path, raw: Option<&str>) -> Result<KeyDir, KeyError> {
    let Some(raw) = raw else {
        return Ok(KeyDir::managed(managed));
    };
    if raw.trim().is_empty() {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.folderRequired",
            "Choose a folder for the key."
        )));
    }
    if raw.chars().count() > MAX_PATH_CHARS || raw.chars().any(char::is_control) {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.folderInvalid",
            "The folder path is invalid."
        )));
    }
    let not_local = || {
        KeyError::invalid(crate::text!(
            "errors.keys.folderNotLocal",
            "Use a full path, or one starting with ~/."
        ))
    };
    if !(raw.starts_with("~/") || config::is_local_absolute(raw)) {
        return Err(not_local());
    }
    let expanded = fsutil::expand_local(raw).ok_or_else(not_local)?;
    real_dir(&expanded)?;
    let path = fsutil::canonical(&expanded).map_err(|e| folder_io(e, &expanded))?;
    if !fsutil::is_local_path(&path) {
        return Err(not_local());
    }
    let managed = fsutil::canonical(managed).is_ok_and(|m| m == path);
    let id = open(&path)?.id;
    Ok(KeyDir {
        path,
        managed,
        id: Some(id),
    })
}

/// Refuses a name already used in `dir` by the private key or its `.pub` (links included).
pub(super) fn ensure_free(dir: &Path, file_name: &str) -> Result<(), KeyError> {
    let pub_name = format!("{file_name}.pub");
    for name in [file_name, pub_name.as_str()] {
        if fs::symlink_metadata(dir.join(name)).is_ok() {
            return Err(KeyError::Taken(file_name.to_owned()));
        }
    }
    Ok(())
}

fn open(path: &Path) -> Result<fsutil::DirHandle, KeyError> {
    fsutil::open_dir(path).map_err(|e| match e.kind() {
        ErrorKind::InvalidInput => link_refused(),
        _ => folder_io(e, path),
    })
}

fn changed() -> KeyError {
    KeyError::invalid(crate::text!(
        "errors.keys.folderChanged",
        "The folder changed. Choose it again."
    ))
}

/// Opens the checked custom folder for the whole generation. On Windows the handle keeps it
/// from being renamed or removed; everywhere its identity must match the folder that was
/// checked, so a folder or junction swapped in at that path is refused. `None` for the
/// managed directory.
pub(super) fn hold(dir: &KeyDir) -> Result<Option<fsutil::DirHandle>, KeyError> {
    if dir.managed {
        return Ok(None);
    }
    real_dir(&dir.path)?;
    let held = open(&dir.path)?;
    if Some(held.id) != dir.id {
        return Err(changed());
    }
    Ok(Some(held))
}

/// Right before writing: the path still names the held folder. Unix writes by path, so this
/// narrows the window there; on Windows the held handle already prevents a swap.
pub(super) fn recheck(dir: &KeyDir, held: Option<&fsutil::DirHandle>) -> Result<(), KeyError> {
    let Some(held) = held else {
        return Ok(());
    };
    real_dir(&dir.path)?;
    if open(&dir.path)?.id != held.id {
        return Err(changed());
    }
    Ok(())
}

/// Maps a write error in the target folder to what the user can act on.
pub(super) fn write_error(e: io::Error, dir: &KeyDir, file_name: &str) -> KeyError {
    match e.kind() {
        ErrorKind::AlreadyExists => KeyError::Taken(file_name.to_owned()),
        _ if dir.managed => KeyError::io(e, &dir.path.join(file_name)),
        _ => folder_io(e, &dir.path),
    }
}

/// A warning when other users can list or change the folder. Never for the managed directory.
pub fn folder_warning(dir: &KeyDir) -> Option<Text> {
    if dir.managed {
        return None;
    }
    fsutil::dir_open_to_others(&dir.path)
        .unwrap_or(false)
        .then(|| {
            crate::text!(
                "errors.keys.sharedFolder",
                "Other users can open this folder. The private key file stays readable only by you, but they may be able to replace or delete it."
            )
        })
}

/// The checks a generation into `raw` (or the managed directory) applies, without generating.
/// A custom folder is also probed for writing; nothing is left behind. Blocking.
pub fn check_location(
    managed: &Path,
    raw: Option<&str>,
    file_name: &str,
) -> Result<KeyLocation, KeyError> {
    let file_name = validate_file_name(file_name)?;
    let dir = key_dir(managed, raw)?;
    let shown = if dir.managed {
        fsutil::canonical(&dir.path).unwrap_or_else(|_| dir.path.clone())
    } else {
        dir.path.clone()
    };
    if shown.is_dir() {
        ensure_free(&shown, file_name)?;
    }
    if !dir.managed {
        fsutil::probe_writable(&dir.path, file_name).map_err(|e| folder_io(e, &dir.path))?;
    }
    Ok(KeyLocation {
        warning: folder_warning(&dir),
        is_default: dir.managed,
        dir: shown,
    })
}
