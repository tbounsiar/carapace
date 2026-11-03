//! The two ends of a transfer behind one interface. Local calls block, so they run on the
//! blocking pool.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use crate::files::{self, EntryKind, FsError, MAX_ENTRIES};
use crate::localfs;
use crate::sftp::{self, Remote, RemoteMeta};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Meta {
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub modified: Option<i64>,
    /// Permission bits (`0o7777`); `None` on Windows or when the server sent none.
    pub mode: Option<u32>,
}

impl From<RemoteMeta> for Meta {
    fn from(m: RemoteMeta) -> Self {
        Self {
            kind: m.kind,
            size: m.size,
            modified: m.modified,
            mode: m.mode,
        }
    }
}

/// Mode a copied file ends with: the replaced file's, else the source's, else 0o644 (a Windows
/// source). Only the permission bits are kept, never setuid, setgid or sticky.
pub fn file_mode(replaced: Option<&Meta>, source: Option<u32>) -> u32 {
    replaced
        .filter(|m| m.kind == EntryKind::File)
        .and_then(|m| m.mode)
        .or(source)
        .map_or(0o644, |m| m & 0o777)
}

/// Mode a created remote directory asks for: the source's (0o755 when unknown). The owner keeps
/// full access, or the files of a read-only source directory could not be written into it.
pub fn dir_mode(source: Option<u32>) -> u32 {
    source.map_or(0o755, |m| (m & 0o777) | 0o700)
}

pub async fn blocking<T, F>(f: F) -> Result<T, FsError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FsError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| FsError::Io("the local file operation".into()))?
}

#[derive(Clone)]
pub enum Side {
    Local,
    Remote(Arc<Remote>),
}

/// A child of a source directory; `name` is `None` when it is not valid Unicode.
pub struct Child {
    pub name: Option<String>,
    pub meta: Meta,
}

fn modified(meta: &Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_secs()).ok())
}

/// `link` decides what counts as a symlink.
fn local_meta(meta: &Metadata, link: bool) -> Meta {
    let kind = if link {
        EntryKind::Symlink
    } else if meta.is_dir() {
        EntryKind::Dir
    } else if meta.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode() & 0o7777)
    };
    #[cfg(not(unix))]
    let mode = None;
    Meta {
        kind,
        size: (kind == EntryKind::File).then_some(meta.len()),
        modified: modified(meta),
        mode,
    }
}

fn local_lstat(path: &Path, strict: bool) -> Result<Option<Meta>, FsError> {
    match fs::symlink_metadata(path) {
        // Sources skip what the OS calls a symlink (symlinks and junctions), so cloud
        // placeholder files can still be uploaded; destinations treat every reparse point as a
        // link, so nothing is ever written through one.
        Ok(m) => {
            let link = if strict {
                localfs::is_link(&m)
            } else {
                m.file_type().is_symlink()
            };
            Ok(Some(local_meta(&m, link)))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(localfs::fail(e, path)),
    }
}

/// Opens a regular file without following a link at its last component. `None` when the path
/// turned into a link or a non-file since it was listed.
pub fn open_source(path: &Path) -> Result<Option<File>, FsError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = match options.open(path) {
        Ok(f) => f,
        #[cfg(unix)]
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Ok(None),
        Err(e) => return Err(localfs::fail(e, path)),
    };
    let meta = file.metadata().map_err(|e| localfs::fail(e, path))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        // A non-link reparse point (cloud placeholder) opened as itself would not serve the
        // file's data, so it is opened again normally. That open goes by path, so it must still
        // reach the file checked above, not a link swapped in meanwhile.
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            let reopened = File::open(path).map_err(|e| localfs::fail(e, path))?;
            return Ok(same_file(&file, &reopened).then_some(reopened));
        }
    }
    Ok(Some(file))
}

#[cfg(windows)]
fn file_id(f: &File) -> Option<(u32, u32, u32)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is valid (plain integers).
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is owned by `f` and open; `info` is writable and of the expected type.
    let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut info) };
    (ok != 0).then_some((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

/// Whether two handles are the same file (volume and file index).
#[cfg(windows)]
pub fn same_file(a: &File, b: &File) -> bool {
    matches!((file_id(a), file_id(b)), (Some(x), Some(y)) if x == y)
}

/// Every directory from `root` down to `dir` must still be a real directory, not a link or a
/// reparse point, so a file is never created through one swapped in during the job.
fn check_dirs(root: &Path, dir: &Path) -> Result<(), FsError> {
    let rel = dir
        .strip_prefix(root)
        .map_err(|_| FsError::Io(dir.display().to_string()))?;
    let real_dir = |p: &Path| match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() && !localfs::is_link(&m) => Ok(()),
        Ok(_) => Err(FsError::Io(p.display().to_string())),
        Err(e) => Err(localfs::fail(e, p)),
    };
    let mut current = root.to_path_buf();
    real_dir(&current)?;
    for c in rel.components() {
        current.push(c);
        real_dir(&current)?;
    }
    Ok(())
}

/// `create_new` never opens or follows an existing entry, a link included. Owner-only on Unix
/// until the final mode is set; on Windows the directory's inherited ACL applies.
pub fn create_local_temp(root: &Path, path: &Path) -> Result<File, FsError> {
    check_dirs(root, path.parent().unwrap_or(path))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|e| localfs::fail(e, path))
}

/// Gives a finished local temp file its final mode (Unix only; Windows keeps the inherited ACL).
pub async fn set_local_mode(file: &tokio::fs::File, mode: u32, path: &str) -> Result<(), FsError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))
            .await
            .map_err(|e| localfs::fail(e, &local_path(path)))
    }
    #[cfg(not(unix))]
    {
        let _ = (file, mode, path);
        Ok(())
    }
}

fn local_children(dir: &Path) -> Result<Vec<Child>, FsError> {
    let mut out = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| localfs::fail(e, dir))? {
        let item = item.map_err(|e| localfs::fail(e, dir))?;
        if out.len() == MAX_ENTRIES {
            return Err(FsError::TooLarge(dir.display().to_string()));
        }
        let path = item.path();
        let Some(meta) = local_lstat(&path, false)? else {
            continue;
        };
        out.push(Child {
            name: item.file_name().into_string().ok(),
            meta,
        });
    }
    Ok(out)
}

fn local_remove(path: &Path) -> Result<(), FsError> {
    let meta = fs::symlink_metadata(path).map_err(|e| localfs::fail(e, path))?;
    if localfs::is_link(&meta) {
        return localfs::remove_link(path, &meta);
    }
    if meta.is_dir() {
        return Err(FsError::AlreadyExists(path.display().to_string()));
    }
    fs::remove_file(path).map_err(|e| localfs::fail(e, path))
}

fn local_rename(from: &Path, to: &Path, replace: bool) -> Result<(), FsError> {
    let exists = |e: std::io::Error| match e.kind() {
        ErrorKind::AlreadyExists => FsError::AlreadyExists(to.display().to_string()),
        _ => localfs::fail(e, from),
    };
    if replace {
        match fs::symlink_metadata(to) {
            Ok(m) if localfs::is_link(&m) => localfs::remove_link(to, &m)?,
            Ok(m) if m.is_dir() => return Err(FsError::AlreadyExists(to.display().to_string())),
            // Atomic replacement of a regular file on both platforms.
            Ok(_) => return fs::rename(from, to).map_err(|e| localfs::fail(e, from)),
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(localfs::fail(e, to)),
        }
    }
    localfs::rename_no_replace(from, to).map_err(exists)
}

pub fn local_path(path: &str) -> PathBuf {
    PathBuf::from(path)
}

impl Side {
    pub fn join(&self, dir: &str, name: &str) -> String {
        match self {
            Self::Local => Path::new(dir).join(name).to_string_lossy().into_owned(),
            Self::Remote(_) => sftp::join(dir, name),
        }
    }

    /// Whether `name` can be created on this side.
    pub fn valid_name(&self, name: &str) -> bool {
        match self {
            Self::Local => localfs::name(name).is_ok(),
            Self::Remote(_) => files::name(name).is_ok(),
        }
    }

    /// Source-side `lstat`: links are what the OS calls a symlink.
    pub async fn stat_source(&self, path: &str) -> Result<Option<Meta>, FsError> {
        match self {
            Self::Local => {
                let p = local_path(path);
                blocking(move || local_lstat(&p, false)).await
            }
            Self::Remote(r) => Ok(r.stat_link(path).await?.map(Meta::from)),
        }
    }

    /// Destination-side `lstat`: every reparse point counts as a link.
    pub async fn stat_dest(&self, path: &str) -> Result<Option<Meta>, FsError> {
        match self {
            Self::Local => {
                let p = local_path(path);
                blocking(move || local_lstat(&p, true)).await
            }
            Self::Remote(r) => Ok(r.stat_link(path).await?.map(Meta::from)),
        }
    }

    /// Path to read children from. Remote directories are entered through the server's own
    /// path, and only when it resolves to `path` itself (not through a link swapped in).
    pub async fn enter(&self, path: &str, root: bool) -> Result<String, FsError> {
        match self {
            Self::Local => match self.stat_source(path).await? {
                Some(m) if m.kind == EntryKind::Dir => Ok(path.to_owned()),
                _ => Err(FsError::Io(path.into())),
            },
            Self::Remote(r) => {
                let real = r.canonical(path).await?;
                if !root && real != path {
                    return Err(FsError::Io(path.into()));
                }
                Ok(real)
            }
        }
    }

    /// Children of `dir`, and how many entries were dropped for a name a server should never
    /// send (too long, or addressing another path).
    pub async fn children(&self, dir: &str) -> Result<(Vec<Child>, u64), FsError> {
        match self {
            Self::Local => {
                let p = local_path(dir);
                Ok((blocking(move || local_children(&p)).await?, 0))
            }
            Self::Remote(r) => {
                let (entries, dropped) = r.children(dir, MAX_ENTRIES).await?;
                let children = entries
                    .into_iter()
                    .map(|(name, meta)| Child {
                        name: Some(name),
                        meta: meta.into(),
                    })
                    .collect();
                Ok((children, dropped))
            }
        }
    }

    /// `mode` applies to remote directories; local ones get the OS default and are created only
    /// below real directories from `root`.
    pub async fn mkdir(&self, path: &str, mode: u32, root: &str) -> Result<(), FsError> {
        match self {
            Self::Local => {
                let (p, root) = (local_path(path), local_path(root));
                blocking(move || {
                    check_dirs(&root, p.parent().unwrap_or(&p))?;
                    fs::create_dir(&p).map_err(|e| localfs::fail(e, &p))
                })
                .await
            }
            Self::Remote(r) => r.make_dir(path, mode).await,
        }
    }

    /// Removes a file or a link itself; a real directory is `AlreadyExists`.
    pub async fn remove(&self, path: &str) -> Result<(), FsError> {
        match self {
            Self::Local => {
                let p = local_path(path);
                blocking(move || local_remove(&p)).await
            }
            Self::Remote(r) => match r.stat_link(path).await? {
                Some(m) if m.kind == EntryKind::Dir => Err(FsError::AlreadyExists(path.into())),
                _ => r.remove_entry(path).await,
            },
        }
    }

    pub async fn rename(&self, from: &str, to: &str, replace: bool) -> Result<(), FsError> {
        match self {
            Self::Local => {
                let (f, t) = (local_path(from), local_path(to));
                blocking(move || local_rename(&f, &t, replace)).await
            }
            Self::Remote(r) => {
                if replace {
                    if let Some(m) = r.stat_link(to).await?
                        && m.kind == EntryKind::Dir
                    {
                        return Err(FsError::AlreadyExists(to.into()));
                    }
                    r.rename_replace(from, to).await
                } else {
                    r.rename_new(from, to).await
                }
            }
        }
    }
}
