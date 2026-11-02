use std::fs::{self, Metadata};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::no_replace;
use super::path::{display, name as local_name, resolve};
use crate::files::{EntryKind, FileEntry, FsError, Listing, MAX_ENTRIES};

#[cfg(windows)]
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
#[cfg(windows)]
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

fn fail(e: io::Error, path: &Path) -> FsError {
    let p = path.display().to_string();
    match e.kind() {
        ErrorKind::NotFound => FsError::NotFound(p),
        ErrorKind::PermissionDenied => FsError::PermissionDenied(p),
        ErrorKind::AlreadyExists => FsError::AlreadyExists(p),
        ErrorKind::DirectoryNotEmpty => FsError::NotEmpty(p),
        _ => FsError::Io(p),
    }
}

fn lstat(path: &Path) -> Result<Metadata, FsError> {
    fs::symlink_metadata(path).map_err(|e| fail(e, path))
}

fn exists(path: &Path) -> Result<bool, FsError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(fail(e, path)),
    }
}

/// Anything that redirects elsewhere: symlinks, and on Windows every reparse point (junctions,
/// mount points, cloud placeholders). Deleting one removes only the link.
fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// Removes the link itself. Windows directory links and junctions are directories to the OS.
fn remove_link(path: &Path, meta: &Metadata) -> Result<(), FsError> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return fs::remove_dir(path).map_err(|e| fail(e, path));
        }
    }
    let _ = meta;
    fs::remove_file(path).map_err(|e| fail(e, path))
}

fn hidden(name: &str, meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
            return true;
        }
    }
    let _ = meta;
    name.starts_with('.')
}

fn permissions(meta: &Metadata) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(crate::files::mode_string(meta.permissions().mode()))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

fn entry(path: &Path, name: String, meta: &Metadata) -> Result<FileEntry, FsError> {
    let ft = meta.file_type();
    // Listing uses the OS notion of a symlink (junctions included) so cloud placeholder folders
    // stay navigable; deletion uses the stricter `is_link`.
    let kind = if ft.is_symlink() {
        EntryKind::Symlink
    } else if ft.is_dir() {
        EntryKind::Dir
    } else if ft.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    Ok(FileEntry {
        path: display(path)?,
        hidden: hidden(&name, meta),
        name,
        kind,
        size: (kind == EntryKind::File).then_some(meta.len()),
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_secs()).ok()),
        permissions: permissions(meta),
    })
}

fn entry_at(path: &Path) -> Result<FileEntry, FsError> {
    let meta = lstat(path)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| FsError::Io(path.display().to_string()))?;
    entry(path, name.to_owned(), &meta)
}

pub fn home() -> Result<String, FsError> {
    let home = std::env::home_dir().ok_or_else(|| FsError::Io("the home directory".into()))?;
    display(&home)
}

fn roots() -> Vec<FileEntry> {
    let candidates: Vec<String> = if cfg!(windows) {
        (b'A'..=b'Z').map(|l| format!("{}:\\", l as char)).collect()
    } else {
        vec!["/".into()]
    };
    candidates
        .into_iter()
        .filter(|root| fs::metadata(root).is_ok_and(|m| m.is_dir()))
        .map(|root| FileEntry {
            name: root.trim_end_matches('\\').to_owned(),
            path: root,
            kind: EntryKind::Dir,
            size: None,
            modified: None,
            permissions: None,
            hidden: false,
        })
        .collect()
}

/// Children of `dir`, never more than `cap`. The name is `None` when it is not valid Unicode.
fn children(dir: &Path, cap: usize) -> Result<Vec<(Option<String>, PathBuf, Metadata)>, FsError> {
    let mut out = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| fail(e, dir))? {
        let item = item.map_err(|e| fail(e, dir))?;
        let name = item.file_name().into_string().ok();
        if out.len() == cap {
            return Err(FsError::TooLarge(dir.display().to_string()));
        }
        let path = item.path();
        let meta = lstat(&path)?;
        out.push((name, path, meta));
    }
    Ok(out)
}

pub fn list(raw: &str) -> Result<Listing, FsError> {
    let Some(path) = resolve(raw)? else {
        return Ok(Listing {
            path: String::new(),
            parent: None,
            entries: roots(),
        });
    };
    let canonical = fs::canonicalize(&path).map_err(|e| fail(e, &path))?;
    // A mapped network drive canonicalizes to a UNC path; keep the drive path then.
    let shown = PathBuf::from(display(&canonical).or_else(|_| display(&path))?);
    if !fs::metadata(&shown).map_err(|e| fail(e, &shown))?.is_dir() {
        return Err(FsError::invalid(format!(
            "{} is not a directory",
            shown.display()
        )));
    }
    let entries = children(&shown, MAX_ENTRIES)?
        .into_iter()
        // Unicode-less names cannot be addressed by the frontend, so they are not listed.
        .filter_map(|(name, p, meta)| entry(&p, name?, &meta).ok())
        .collect();
    Ok(Listing {
        parent: shown.parent().map(display).transpose()?,
        path: display(&shown)?,
        entries,
    })
}

fn required(raw: &str) -> Result<PathBuf, FsError> {
    resolve(raw)?.ok_or_else(|| FsError::invalid("path is required"))
}

pub fn mkdir(parent: &str, name: &str) -> Result<FileEntry, FsError> {
    local_name(name)?;
    let path = required(parent)?.join(name);
    fs::create_dir(&path).map_err(|e| fail(e, &path))?;
    entry_at(&path)
}

pub fn rename(raw: &str, new_name: &str) -> Result<FileEntry, FsError> {
    local_name(new_name)?;
    let source = required(raw)?;
    let (Some(dir), Some(old_name)) = (source.parent(), source.file_name()) else {
        return Err(FsError::invalid("cannot rename a root"));
    };
    let target = dir.join(new_name);
    if target == source {
        return entry_at(&source);
    }
    lstat(&source)?;
    // A case-only rename on a case-insensitive filesystem finds the source itself as the target.
    let case_only = exists(&target)?
        && old_name
            .to_str()
            .is_some_and(|o| o.to_lowercase() == new_name.to_lowercase())
        && fs::canonicalize(&source).ok() == fs::canonicalize(&target).ok();
    let renamed = if case_only {
        fs::rename(&source, &target)
    } else {
        no_replace::rename(&source, &target)
    };
    renamed.map_err(|e| match e.kind() {
        ErrorKind::AlreadyExists => FsError::AlreadyExists(target.display().to_string()),
        _ => fail(e, &source),
    })?;
    entry_at(&target)
}

pub fn delete(raw: &str, recursive: bool) -> Result<(), FsError> {
    let path = required(raw)?;
    if path.parent().is_none() {
        return Err(FsError::invalid("refusing to delete a root"));
    }
    let meta = lstat(&path)?;
    if is_link(&meta) {
        return remove_link(&path, &meta);
    }
    if !meta.is_dir() {
        return fs::remove_file(&path).map_err(|e| fail(e, &path));
    }
    let real = fs::canonicalize(&path).map_err(|e| fail(e, &path))?;
    let home = std::env::home_dir().and_then(|h| fs::canonicalize(h).ok());
    if real.parent().is_none() || home.as_ref() == Some(&real) {
        return Err(FsError::invalid(format!(
            "refusing to delete {}",
            path.display()
        )));
    }
    if recursive {
        // Walks with handles relative to the opened parent and never follows links (it removes
        // the link itself), so a directory swapped for a link after the checks above cannot
        // redirect it. Unbounded in depth and size, which is safe for that reason.
        fs::remove_dir_all(&path).map_err(|e| fail(e, &path))
    } else {
        fs::remove_dir(&path).map_err(|e| fail(e, &path))
    }
}

#[cfg(test)]
mod tests;
