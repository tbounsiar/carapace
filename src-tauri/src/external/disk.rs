//! The edit directory: `$CARAPACE_HOME/edit/<id>/<name>` plus `<id>/.carapace-edit.json`.
//! Every directory is owner-only and every file is created owner-only. A directory is checked
//! against the identity recorded when it was created before each use, and nothing in it is
//! opened through a link, so a link or junction planted there is never followed.

use std::fs::{self, File};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::fsutil::{self, DirId, FileId};
use crate::localfs;
use crate::sftp::{self, Version};

pub const MANIFEST: &str = ".carapace-edit.json";
const MANIFEST_TEMP: &str = ".carapace-edit.json.carapace-part";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_TEMPS: u32 = 16;
const CHUNK: usize = 64 * 1024;

/// What a copy was synced from. No secret: ids, the remote path and version data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub host_id: String,
    pub remote_path: String,
    pub file_name: String,
    /// Version token of the server file at the last sync.
    pub token: String,
    /// The file the server resolved `remote_path` to, when it is a link elsewhere.
    pub target: Option<String>,
    /// SHA-256 of the content at the last sync.
    pub synced_hash: String,
    pub synced_size: u64,
    pub opened_at: u64,
    pub synced_at: Option<u64>,
    pub uploaded_at: Option<u64>,
    /// SHA256 fingerprint of the server's host key when the file was opened.
    pub host_key: String,
    /// `hostname:port:username` the file was opened from.
    pub endpoint: String,
}

impl Manifest {
    /// Every field a later upload relies on is well formed, so a manifest written by someone
    /// else cannot point an upload at another file.
    pub fn is_valid(&self) -> bool {
        let path_ok = sftp::normalize(&self.remote_path)
            .ok()
            .flatten()
            .is_some_and(|p| p == self.remote_path && p != "/");
        let target_ok = self.target.as_ref().is_none_or(|t| {
            sftp::normalize(t)
                .ok()
                .flatten()
                .is_some_and(|p| p == *t && p != "/")
        });
        self.version == 1
            && path_ok
            && target_ok
            && self.file_name == super::rules::local_name(sftp::file_name(&self.remote_path))
            && Version::parse(&self.token).is_some()
            && crate::config::validate::is_canonical_id(&self.host_id)
            && !self.host_key.is_empty()
            && !self.endpoint.is_empty()
    }
}

/// One edited file's directory.
#[derive(Debug, Clone)]
pub struct Slot {
    pub id: String,
    pub dir: PathBuf,
    pub dir_id: DirId,
    pub name: String,
}

#[derive(Debug)]
pub struct LocalState {
    pub hash: String,
    pub size: u64,
}

/// What an open copy looked like when an upload started; compared again at its end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    id: FileId,
}

impl Stamp {
    pub fn of(file: &File) -> io::Result<Self> {
        let meta = file.metadata()?;
        Ok(Self {
            len: meta.len(),
            modified: meta.modified().ok(),
            id: fsutil::file_id(file)?,
        })
    }
}

pub enum Snap {
    Ready(Snapshot),
    TooLarge,
    /// Saved again while it was copied.
    Changed,
}

/// An owner-only frozen copy for one upload, deleted when dropped.
pub struct Snapshot {
    path: PathBuf,
    file: Option<File>,
}

impl Snapshot {
    pub fn take_file(&mut self) -> Option<File> {
        self.file.take()
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        self.file = None;
        let _ = fs::remove_file(&self.path);
    }
}

/// Marks a downloaded file as coming from the internet (Windows `Zone.Identifier`, macOS
/// quarantine), so the system warns before running it. Best effort: some file systems have no
/// place for the mark.
pub fn mark_downloaded(path: &Path) {
    if mark(path).is_err() {
        log::warn!("could not mark an edited copy as downloaded");
    }
}

#[cfg(windows)]
fn mark(path: &Path) -> io::Result<()> {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    fs::write(stream, b"[ZoneTransfer]\r\nZoneId=3\r\n")
}

#[cfg(target_os = "macos")]
fn mark(path: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let value = format!("0081;{secs:x};Carapace;");
    // SAFETY: NUL-terminated path and name, a value buffer of the size given.
    let r = unsafe {
        libc::setxattr(
            c_path.as_ptr(),
            c"com.apple.quarantine".as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn mark(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn not_ours() -> io::Error {
    io::Error::new(ErrorKind::InvalidInput, "the edit directory changed")
}

pub fn root(home: &Path) -> PathBuf {
    home.join("edit")
}

/// An existing root that others can reach is refused, never silently tightened: files may
/// have been planted in it. An error checking it counts as open.
fn root_is_private(root: &Path) -> bool {
    !fsutil::dir_open_to_others(root).unwrap_or(true)
}

fn ensure_root(root: &Path) -> io::Result<()> {
    if let Some(home) = root.parent() {
        fs::create_dir_all(home)?;
    }
    if fs::symlink_metadata(root).is_ok() && !root_is_private(root) {
        return Err(ErrorKind::PermissionDenied.into());
    }
    fsutil::ensure_dir_owner_only(root)
}

impl Slot {
    /// A new owner-only directory under `root` for a copy named `name`.
    pub fn create(root: &Path, name: &str) -> io::Result<Self> {
        ensure_root(root)?;
        let id = Uuid::new_v4().to_string();
        let dir = root.join(&id);
        fsutil::ensure_dir_owner_only(&dir)?;
        let dir_id = fsutil::open_dir(&dir)?.id;
        Ok(Self {
            id,
            dir,
            dir_id,
            name: name.to_owned(),
        })
    }

    pub fn file(&self) -> PathBuf {
        self.dir.join(&self.name)
    }

    /// Still the directory created for this slot, and not a link.
    pub fn check(&self) -> io::Result<fsutil::DirHandle> {
        let held = fsutil::open_dir(&self.dir)?;
        if held.id != self.dir_id {
            return Err(not_ours());
        }
        Ok(held)
    }

    /// A new owner-only temp file in the slot, for a download.
    pub fn create_temp(&self) -> io::Result<(PathBuf, File)> {
        let _held = self.check()?;
        for n in 0..MAX_TEMPS {
            let temp = self.dir.join(temp_name(&self.name, n));
            match fsutil::create_owner_only(&temp) {
                Ok(f) => return Ok((temp, f)),
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        Err(ErrorKind::AlreadyExists.into())
    }

    /// Moves a temp into place: `replace` swaps the current copy (the editor sees a new file).
    pub fn place(&self, temp: &Path, replace: bool) -> io::Result<()> {
        let _held = self.check()?;
        let placed = if replace {
            fs::rename(temp, self.file())
        } else {
            localfs::rename_no_replace(temp, &self.file())
        };
        if placed.is_err() {
            let _ = fs::remove_file(temp);
        }
        placed
    }

    pub fn write_manifest(&self, manifest: &Manifest) -> io::Result<()> {
        let _held = self.check()?;
        let data = serde_json::to_vec_pretty(manifest).map_err(io::Error::other)?;
        let temp = self.dir.join(MANIFEST_TEMP);
        remove_entry(&temp)?;
        let mut file = fsutil::create_owner_only(&temp)?;
        let written = file
            .write_all(&data)
            .and_then(|()| file.sync_all())
            .and_then(|()| {
                drop(file);
                fs::rename(&temp, self.dir.join(MANIFEST))
            });
        if written.is_err() {
            let _ = fs::remove_file(&temp);
        }
        written
    }

    /// The copy, opened without following a link.
    pub fn open(&self) -> io::Result<File> {
        let _held = self.check()?;
        fsutil::open_regular(&self.file(), false)
    }

    /// The copy for an upload: on Windows nobody else can write or replace it while it is
    /// streamed.
    pub fn open_locked(&self) -> io::Result<(File, Stamp)> {
        let _held = self.check()?;
        let file = fsutil::open_regular_locked(&self.file())?;
        let stamp = Stamp::of(&file)?;
        Ok((file, stamp))
    }

    /// Copies the copy into an owner-only snapshot in the slot (a new file, never a link) and
    /// checks, before anything is sent, that it is at most `max` bytes and did not change
    /// while it was copied. The upload streams the snapshot, so the server never receives a
    /// half-saved or oversized file, whatever route the write takes there.
    pub fn snapshot(&self, max: u64) -> io::Result<Snap> {
        let (mut src, stamp) = self.open_locked()?;
        if stamp.len > max {
            return Ok(Snap::TooLarge);
        }
        let (temp, mut dst) = self.create_temp()?;
        let discard = |snap: Snap| {
            let _ = fs::remove_file(&temp);
            Ok(snap)
        };
        let copied = match io::copy(&mut (&mut src).take(max + 1), &mut dst) {
            Ok(n) => n,
            Err(e) => {
                let _ = fs::remove_file(&temp);
                return Err(e);
            }
        };
        drop(src);
        if copied > max {
            return discard(Snap::TooLarge);
        }
        if copied != stamp.len || !self.unchanged_since(&stamp) {
            return discard(Snap::Changed);
        }
        use std::io::Seek;
        if let Err(e) = dst.rewind() {
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
        Ok(Snap::Ready(Snapshot {
            path: temp,
            file: Some(dst),
        }))
    }

    /// The copy at its path is still `stamp`: same file, same size and modification time.
    pub fn unchanged_since(&self, stamp: &Stamp) -> bool {
        self.open()
            .and_then(|f| Stamp::of(&f))
            .is_ok_and(|now| now == *stamp)
    }

    pub fn local_state(&self) -> io::Result<LocalState> {
        let mut file = self.open()?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0; CHUNK];
        let mut size = 0u64;
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as u64;
        }
        Ok(LocalState {
            hash: crate::sftp::hex(&hasher.finalize()),
            size,
        })
    }

    pub fn modified_ms(&self) -> Option<u64> {
        let meta = fs::symlink_metadata(self.file()).ok()?;
        let t = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some(t.as_millis() as u64)
    }

    pub fn remove(&self) -> io::Result<()> {
        remove_dir(&self.dir)
    }
}

#[cfg(unix)]
pub fn exec_bit(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
pub fn exec_bit(_meta: &fs::Metadata) -> bool {
    false
}

fn temp_name(name: &str, n: u32) -> String {
    if n == 0 {
        format!(".{name}.carapace-part")
    } else {
        format!(".{name}.{n}.carapace-part")
    }
}

/// Removes a file or a link itself; a missing entry is fine.
fn remove_entry(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if localfs::is_link(&meta) => {
            localfs::remove_link(path, &meta).map_err(|_| io::Error::other("remove link"))
        }
        Ok(meta) if meta.is_dir() => Err(ErrorKind::InvalidInput.into()),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Removes a slot directory and what it holds. `remove_dir_all` never follows links (it
/// removes them), and a link at `dir` itself is removed as a link.
pub fn remove_dir(dir: &Path) -> io::Result<()> {
    match fs::symlink_metadata(dir) {
        Ok(meta) if localfs::is_link(&meta) || !meta.is_dir() => remove_entry(dir),
        Ok(_) => fs::remove_dir_all(dir),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// A copy found at startup with changes that never reached the server.
#[derive(Debug)]
pub struct Leftover {
    pub slot: Slot,
    pub manifest: Manifest,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

fn only_manifest(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .flatten()
            .all(|e| e.file_name() == MANIFEST || e.file_name() == MANIFEST_TEMP)
    })
}

fn read_manifest(dir: &Path) -> io::Result<Manifest> {
    let raw = fsutil::read_regular_capped(&dir.join(MANIFEST), MAX_MANIFEST_BYTES, false)?;
    serde_json::from_slice(&raw).map_err(|_| io::Error::from(ErrorKind::InvalidData))
}

/// Deletes synced and incomplete copies, returns the ones with changes never uploaded. A
/// directory whose manifest cannot be read but that holds other files is left in place, and
/// nothing is read from an edit directory or slot that is not ours alone.
pub fn scan(root: &Path) -> Vec<Leftover> {
    if fs::symlink_metadata(root).is_err() {
        return Vec::new();
    }
    if !root_is_private(root) || fsutil::ensure_dir_owner_only(root).is_err() {
        log::warn!("the edit directory is not private to this user; leftovers were not checked");
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = entry
            .file_name()
            .to_str()
            .filter(|n| crate::config::validate::is_canonical_id(n))
            .map(str::to_owned)
        else {
            continue;
        };
        if let Some(found) = check_leftover(&path, id) {
            out.push(found);
        }
    }
    out.sort_by_key(|l| l.manifest.opened_at);
    out
}

fn check_leftover(dir: &Path, id: String) -> Option<Leftover> {
    let remove = |why: &str| {
        if remove_dir(dir).is_err() {
            log::warn!("could not remove an edit leftover ({why})");
        }
        None
    };
    let meta = fs::symlink_metadata(dir).ok()?;
    if localfs::is_link(&meta) || !meta.is_dir() {
        return remove("not a directory");
    }
    let private = fsutil::dir_owned_by_me(dir).unwrap_or(false)
        && !fsutil::dir_open_to_others(dir).unwrap_or(true);
    if !private {
        log::warn!("an edit leftover is not private to this user and was left alone");
        return None;
    }
    let manifest = match read_manifest(dir) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return remove("no manifest"),
        Err(_) if only_manifest(dir) => return remove("empty"),
        Err(_) => {
            log::warn!("an edit leftover has an unreadable manifest and was kept");
            return None;
        }
    };
    if !manifest.is_valid() {
        log::warn!("an edit leftover has an unexpected manifest and was kept");
        return None;
    }
    let slot = Slot {
        id,
        dir: dir.to_owned(),
        dir_id: fsutil::open_dir(dir).ok()?.id,
        name: manifest.file_name.clone(),
    };
    match slot.local_state() {
        Ok(local) if local.hash == manifest.synced_hash => remove("synced"),
        Ok(local) => Some(Leftover {
            modified_ms: slot.modified_ms(),
            size: local.size,
            slot,
            manifest,
        }),
        Err(e) if e.kind() == ErrorKind::NotFound => remove("no copy"),
        Err(_) => {
            log::warn!("an edit leftover could not be read and was kept");
            None
        }
    }
}

#[cfg(test)]
mod tests;
