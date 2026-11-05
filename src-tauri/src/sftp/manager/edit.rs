//! Remote editor: reads a regular file as text and saves it back, refusing to overwrite a file
//! that changed since it was read unless the caller says so. File contents never reach errors
//! or logs.

use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::sftp::text::{self, Eol, LineEnding, MAX_TEXT_BYTES, Version};

/// Names a failure on this machine's side without saying where the file is.
const LOCAL_COPY: &str = "the local copy";

pub const FSYNC: &str = "fsync@openssh.com";
const CHUNK: u32 = 32 * 1024;
const MAX_TEMPS: u32 = 16;
/// Mode of a file the editor creates (the server's umask may narrow it).
const NEW_FILE_MODE: u32 = 0o644;
/// Mode bits copied to the replacement file: setuid and setgid are not carried over.
const COPIED_MODE: u32 = 0o1777;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    /// LF line endings; `line_ending` tells what the file uses.
    pub text: String,
    pub size: u64,
    pub writable: bool,
    pub version: String,
    pub line_ending: LineEnding,
    pub bom: bool,
    /// The file actually read when `path` is a symlink, else `None`.
    pub target: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub version: String,
    pub size: u64,
}

pub struct WriteText<'a> {
    pub path: &'a str,
    pub text: &'a str,
    /// `None`: write even if the file changed or was deleted since it was read.
    pub expected: Option<&'a str>,
    /// `target` of the last read; checked on a forced save (a token carries its own).
    pub expected_target: Option<&'a str>,
    pub eol: Eol,
    pub bom: bool,
}

/// What a save writes: bytes in memory, or a local file streamed in chunks. It counts and hashes
/// what was sent, so the version of the written file is known without reading it back.
pub struct Body<'a> {
    src: Src<'a>,
    sent: u64,
    hasher: Sha256,
}

/// Called at the end of a streamed file; `false` means the file changed while it was read.
pub type Unchanged<'a> = Box<dyn FnMut() -> bool + Send + 'a>;

enum Src<'a> {
    Bytes(&'a [u8]),
    File {
        file: &'a mut tokio::fs::File,
        max: u64,
        unchanged: Unchanged<'a>,
    },
}

impl<'a> Body<'a> {
    pub fn bytes(data: &'a [u8]) -> Self {
        Self::new(Src::Bytes(data))
    }

    /// Read from the current position to the end. More than `max` bytes is `TooLarge`, and
    /// `unchanged` returning false at the end is `SourceChanged`; both fail before the written
    /// temp is renamed into place.
    pub fn file(file: &'a mut tokio::fs::File, max: u64, unchanged: Unchanged<'a>) -> Self {
        Self::new(Src::File {
            file,
            max,
            unchanged,
        })
    }

    fn new(src: Src<'a>) -> Self {
        Self {
            src,
            sent: 0,
            hasher: Sha256::new(),
        }
    }

    async fn next(&mut self) -> Result<Option<Vec<u8>>, FsError> {
        let chunk = match &mut self.src {
            Src::Bytes(data) => {
                let start = self.sent as usize;
                if start >= data.len() {
                    return Ok(None);
                }
                data[start..(start + CHUNK as usize).min(data.len())].to_vec()
            }
            Src::File {
                file,
                max,
                unchanged,
            } => {
                let mut buf = vec![0; CHUNK as usize];
                let n = file
                    .read(&mut buf)
                    .await
                    .map_err(|_| FsError::Io(LOCAL_COPY.into()))?;
                if n == 0 {
                    if !unchanged() {
                        return Err(FsError::SourceChanged);
                    }
                    return Ok(None);
                }
                if self.sent + n as u64 > *max {
                    return Err(FsError::TooLarge(LOCAL_COPY.into()));
                }
                buf.truncate(n);
                buf
            }
        };
        self.hasher.update(&chunk);
        self.sent += chunk.len() as u64;
        Ok(Some(chunk))
    }

    fn version(&self, mtime: Option<u32>, real: &str) -> Version {
        let hash = text::hex(&self.hasher.clone().finalize());
        Version::hashed(self.sent, hash, mtime, real)
    }
}

/// A regular file copied from the server, with the version a later save must match.
#[derive(Debug)]
pub struct Downloaded {
    pub version: String,
    pub size: u64,
    /// The file actually read when the path is a symlink to another path.
    pub target: Option<String>,
}

enum Target {
    /// The regular file to read and write: the path itself, or the target of a symlink so the
    /// link stays a link.
    File {
        real: String,
        attrs: FileAttributes,
        link: bool,
    },
    Missing,
    /// A symlink whose target does not exist.
    Dangling,
}

enum Placed {
    /// mtime of the written file.
    Done(Option<u32>),
    /// The temp route would change the file's owner or cannot be used here.
    InPlace,
}

fn not_regular(path: &str) -> FsError {
    FsError::invalid(crate::text!(
        "errors.files.notRegular",
        "{path} is not a regular file",
        path = path
    ))
}

fn is_file(attrs: &FileAttributes) -> bool {
    kind(attrs) == Some(EntryKind::File)
}

/// Best effort: SFTP does not tell which user we are, so only a file without any write bit is
/// reported read-only; anything else is tried and a refusal is `permission_denied` at save.
fn writable(attrs: &FileAttributes) -> bool {
    attrs.permissions.is_none_or(|p| p & 0o222 != 0)
}

/// An id reported on one side only counts as different.
fn owner_differs(original: &FileAttributes, temp: &FileAttributes) -> bool {
    original.uid != temp.uid || original.gid != temp.gid
}

/// Still the regular file `edit_target` saw. Opening by path follows a link planted since, so
/// a handle that fails this is refused before a byte is written.
fn same_file(original: &FileAttributes, now: &FileAttributes) -> bool {
    is_file(now)
        && now.size == original.size
        && now.mtime == original.mtime
        && now.uid == original.uid
        && now.gid == original.gid
        && now.permissions == original.permissions
}

fn part_name(name: &str, n: u32) -> Option<String> {
    let temp = if n == 0 {
        format!(".{name}.carapace-part")
    } else {
        format!(".{name}.{n}.carapace-part")
    };
    (temp.len() <= MAX_NAME_BYTES).then_some(temp)
}

/// Errors about the temp file or the resolved target name the path the user knows.
fn on_user_path(e: FsError, path: &str) -> FsError {
    match e {
        FsError::NotFound(_) => FsError::NotFound(path.into()),
        FsError::PermissionDenied(_) => FsError::PermissionDenied(path.into()),
        FsError::AlreadyExists(_) | FsError::Io(_) => FsError::Io(path.into()),
        FsError::TooLarge(_) => FsError::TooLarge(path.into()),
        e => e,
    }
}

fn missing(e: &FsError) -> bool {
    matches!(e, FsError::NotFound(_))
}

impl Remote {
    async fn edit_target(&self, path: &str) -> Result<Target, FsError> {
        let attrs = match self.lstat(path).await {
            Ok(a) => a,
            Err(e) if missing(&e) => return Ok(Target::Missing),
            Err(e) => return Err(e),
        };
        match kind(&attrs) {
            Some(EntryKind::File) => Ok(Target::File {
                real: path.to_owned(),
                attrs,
                link: false,
            }),
            Some(EntryKind::Symlink) => {
                let real = match self.realpath(path).await {
                    Ok(r) => r,
                    Err(e) if missing(&e) => return Ok(Target::Dangling),
                    Err(e) => return Err(e),
                };
                match self.lstat(&real).await {
                    Ok(a) if is_file(&a) => Ok(Target::File {
                        link: real != path,
                        real,
                        attrs: a,
                    }),
                    Ok(_) => Err(not_regular(path)),
                    Err(e) if missing(&e) => Ok(Target::Dangling),
                    Err(e) => Err(on_user_path(e, path)),
                }
            }
            _ => Err(not_regular(path)),
        }
    }

    /// Whole content of the regular file `real`, with its attributes taken from the open
    /// handle. `path` is the name the user knows, used in errors.
    async fn read_file(
        &self,
        real: &str,
        path: &str,
    ) -> Result<(Vec<u8>, FileAttributes), FsError> {
        let handle = self
            .raw
            .open(real, OpenFlags::READ, FileAttributes::empty())
            .await
            .map(|h| h.handle)
            .map_err(|e| self.fail(e, path))?;
        let result = async {
            let attrs = self.handle_attrs(&handle, path).await?;
            if !is_file(&attrs) {
                return Err(not_regular(path));
            }
            if attrs.size.is_some_and(|s| s > MAX_TEXT_BYTES as u64) {
                return Err(FsError::TooLarge(path.into()));
            }
            let mut data = Vec::new();
            while let Some(chunk) = self
                .read_at(&handle, data.len() as u64, CHUNK, path)
                .await?
            {
                if chunk.is_empty() {
                    break;
                }
                data.extend_from_slice(&chunk);
                if data.len() > MAX_TEXT_BYTES {
                    return Err(FsError::TooLarge(path.into()));
                }
            }
            Ok((data, attrs))
        }
        .await;
        let _ = self.close_handle(&handle, path).await;
        result
    }

    pub async fn read_text(&self, path: &str) -> Result<TextFile, FsError> {
        let Target::File { real, attrs, link } = self.edit_target(path).await? else {
            return Err(FsError::NotFound(path.into()));
        };
        if attrs.size.is_some_and(|s| s > MAX_TEXT_BYTES as u64) {
            return Err(FsError::TooLarge(path.into()));
        }
        let (data, attrs) = self.read_file(&real, path).await?;
        let decoded = text::decode(&data).ok_or_else(|| FsError::NotText(path.into()))?;
        Ok(TextFile {
            text: decoded.text,
            size: data.len() as u64,
            writable: writable(&attrs),
            version: Version::of(&data, attrs.mtime, &real).token(),
            line_ending: decoded.line_ending,
            bom: decoded.bom,
            target: link.then_some(real),
        })
    }

    /// Fails unless `real` still holds `expected`: same place, then size and mtime, then hash.
    async fn check_unchanged(
        &self,
        real: &str,
        attrs: &FileAttributes,
        expected: &Version,
        path: &str,
    ) -> Result<(), FsError> {
        if expected.place != Version::place_of(real) {
            return Err(FsError::Retargeted(path.into()));
        }
        if !expected.may_match(attrs.size, attrs.mtime) {
            return Err(FsError::Changed(path.into()));
        }
        let now = match self.hash_file(real, expected.size, path).await {
            Ok(v) => v,
            Err(FsError::TooLarge(_)) => return Err(FsError::Changed(path.into())),
            Err(e) if missing(&e) => return Err(FsError::Deleted(path.into())),
            Err(e) => return Err(e),
        };
        if now != *expected {
            return Err(FsError::Changed(path.into()));
        }
        Ok(())
    }

    /// Version of the regular file `real`, read through one handle without keeping its content;
    /// more than `cap` bytes is `TooLarge`.
    async fn hash_file(&self, real: &str, cap: u64, path: &str) -> Result<Version, FsError> {
        let handle = self.open_regular(real, path).await?;
        let result = async {
            let attrs = self.handle_attrs(&handle, path).await?;
            if !is_file(&attrs) {
                return Err(not_regular(path));
            }
            let mut hasher = Sha256::new();
            let mut size = 0u64;
            while let Some(chunk) = self.read_at(&handle, size, CHUNK, path).await? {
                if chunk.is_empty() {
                    break;
                }
                size += chunk.len() as u64;
                if size > cap {
                    return Err(FsError::TooLarge(path.into()));
                }
                hasher.update(&chunk);
            }
            let hash = text::hex(&hasher.finalize());
            Ok(Version::hashed(size, hash, attrs.mtime, real))
        }
        .await;
        let _ = self.close_handle(&handle, path).await;
        result
    }

    async fn open_regular(&self, real: &str, path: &str) -> Result<String, FsError> {
        self.raw
            .open(real, OpenFlags::READ, FileAttributes::empty())
            .await
            .map(|h| h.handle)
            .map_err(|e| self.fail(e, path))
    }

    /// Size of the regular file at `path` (a link is followed to one) and the path actually
    /// reached; `InvalidInput` for anything else.
    pub async fn edit_size(&self, path: &str) -> Result<(Option<u64>, String), FsError> {
        match self.edit_target(path).await? {
            Target::File { attrs, real, .. } => Ok((attrs.size, real)),
            Target::Missing | Target::Dangling => Err(FsError::NotFound(path.into())),
        }
    }

    /// Copies the regular file at `path` into `out`; more than `max` bytes is `TooLarge`.
    /// Type and size are checked again on the open handle.
    pub async fn download(
        &self,
        path: &str,
        max: u64,
        out: &mut tokio::fs::File,
    ) -> Result<Downloaded, FsError> {
        let Target::File { real, attrs, link } = self.edit_target(path).await? else {
            return Err(FsError::NotFound(path.into()));
        };
        if attrs.size.is_some_and(|s| s > max) {
            return Err(FsError::TooLarge(path.into()));
        }
        let handle = self.open_regular(&real, path).await?;
        let result = async {
            let attrs = self.handle_attrs(&handle, path).await?;
            if !is_file(&attrs) {
                return Err(not_regular(path));
            }
            if attrs.size.is_some_and(|s| s > max) {
                return Err(FsError::TooLarge(path.into()));
            }
            let mut hasher = Sha256::new();
            let mut size = 0u64;
            while let Some(chunk) = self.read_at(&handle, size, CHUNK, path).await? {
                if chunk.is_empty() {
                    break;
                }
                size += chunk.len() as u64;
                if size > max {
                    return Err(FsError::TooLarge(path.into()));
                }
                hasher.update(&chunk);
                out.write_all(&chunk)
                    .await
                    .map_err(|_| FsError::Io(LOCAL_COPY.into()))?;
            }
            out.flush()
                .await
                .map_err(|_| FsError::Io(LOCAL_COPY.into()))?;
            let hash = text::hex(&hasher.finalize());
            Ok(Downloaded {
                version: Version::hashed(size, hash, attrs.mtime, &real).token(),
                size,
                target: link.then(|| real.clone()),
            })
        }
        .await;
        let _ = self.close_handle(&handle, path).await;
        result
    }

    /// Right before the file is replaced: still the file `edit_target` saw, to narrow the
    /// window left by the full check.
    async fn recheck(
        &self,
        real: &str,
        original: &FileAttributes,
        path: &str,
    ) -> Result<(), FsError> {
        match self.lstat(real).await {
            Ok(a) if same_file(original, &a) => Ok(()),
            Ok(_) => Err(FsError::Changed(path.into())),
            Err(e) if missing(&e) => Err(FsError::Deleted(path.into())),
            Err(e) => Err(on_user_path(e, path)),
        }
    }

    pub async fn write_text(&self, req: WriteText<'_>) -> Result<Saved, FsError> {
        let path = req.path;
        if req.text.len() > MAX_TEXT_BYTES {
            return Err(FsError::TooLarge(path.into()));
        }
        let data = text::encode(req.text, req.eol, req.bom);
        if data.len() > MAX_TEXT_BYTES {
            return Err(FsError::TooLarge(path.into()));
        }
        let mut body = Body::bytes(&data);
        self.write_body(path, req.expected, req.expected_target, &mut body)
            .await
    }

    /// The save of `write_text` for any content: same conflict check (`expected` token, or
    /// `expected_target` when forced), same atomic placement. `path` must be normalized and
    /// not `/`.
    pub async fn write_body(
        &self,
        path: &str,
        expected: Option<&str>,
        expected_target: Option<&str>,
        body: &mut Body<'_>,
    ) -> Result<Saved, FsError> {
        let expected = expected
            .map(|t| {
                Version::parse(t).ok_or_else(|| {
                    FsError::invalid(crate::text!(
                        "errors.files.versionInvalid",
                        "expectedVersion is invalid"
                    ))
                })
            })
            .transpose()?;
        let (real, original) = match self.edit_target(path).await? {
            Target::File { real, attrs, link } => {
                if expected.is_none() && link.then_some(real.as_str()) != expected_target {
                    return Err(FsError::Retargeted(path.into()));
                }
                (real, Some(attrs))
            }
            Target::Missing | Target::Dangling if expected.is_some() => {
                return Err(FsError::Deleted(path.into()));
            }
            Target::Missing => (path.to_owned(), None),
            Target::Dangling => {
                return Err(FsError::invalid(crate::text!(
                    "errors.files.danglingLink",
                    "{path} is a link to a missing file",
                    path = path
                )));
            }
        };
        let mtime = match &original {
            None => self.create_file(&real, body, path).await?,
            Some(attrs) => {
                if let Some(v) = &expected {
                    self.check_unchanged(&real, attrs, v, path).await?;
                }
                let checked = expected.is_some();
                match self
                    .replace_via_temp(&real, body, attrs, checked, path)
                    .await?
                {
                    Placed::Done(mtime) => mtime,
                    Placed::InPlace => self.rewrite(&real, body, attrs, path).await?,
                }
            }
        };
        Ok(Saved {
            version: body.version(mtime, &real).token(),
            size: body.sent,
        })
    }

    /// `None` when no temp name fits in 255 bytes.
    async fn create_temp(
        &self,
        dir: &str,
        name: &str,
    ) -> Result<Option<(String, String)>, FsError> {
        for n in 0..MAX_TEMPS {
            let Some(temp) = part_name(name, n) else {
                return Ok(None);
            };
            let temp = join(dir, &temp);
            match self.create_new(&temp).await {
                Ok(handle) => return Ok(Some((temp, handle))),
                Err(FsError::AlreadyExists(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Err(FsError::AlreadyExists(join(dir, name)))
    }

    /// Writes `data` with `mode` through an open temp handle and closes it; returns the mtime.
    async fn fill_temp(
        &self,
        handle: &str,
        body: &mut Body<'_>,
        mode: u32,
        path: &str,
    ) -> Result<Option<u32>, FsError> {
        let written = async {
            self.write_chunks(handle, body, path).await?;
            self.sync(handle, path).await?;
            self.set_handle_mode(handle, mode, path).await?;
            Ok(self.handle_attrs(handle, path).await?.mtime)
        }
        .await;
        let closed = self.close_handle(handle, path).await;
        written.and_then(|m| closed.map(|()| m))
    }

    /// A file that did not exist: temp, then a rename that never replaces, so a file created
    /// meanwhile by someone else is kept (`Changed`).
    async fn create_file(
        &self,
        real: &str,
        body: &mut Body<'_>,
        path: &str,
    ) -> Result<Option<u32>, FsError> {
        let dir = parent(real).ok_or_else(|| not_regular(path))?;
        let created = self
            .create_temp(&dir, file_name(real))
            .await
            .map_err(|e| on_user_path(e, path))?;
        let Some((temp, handle)) = created else {
            return Err(FsError::invalid(crate::text!(
                "errors.files.nameTooLong",
                "{path} has too long a name",
                path = path
            )));
        };
        let placed = match self.fill_temp(&handle, body, NEW_FILE_MODE, path).await {
            Ok(mtime) => self.rename_new(&temp, real).await.map(|()| mtime),
            Err(e) => Err(e),
        };
        match placed {
            Ok(mtime) => Ok(mtime),
            Err(FsError::AlreadyExists(_)) => {
                Err(self.discard_now(&temp, FsError::Changed(path.into())).await)
            }
            Err(e) => Err(self.discard_now(&temp, on_user_path(e, path)).await),
        }
    }

    /// Writes an owner-only temp sibling with the original's mode and renames it over `real`
    /// (atomically with posix-rename, else by moving the original aside and restoring it on
    /// failure). The temp is removed on any failure, so the original is never touched then.
    async fn replace_via_temp(
        &self,
        real: &str,
        body: &mut Body<'_>,
        original: &FileAttributes,
        checked: bool,
        path: &str,
    ) -> Result<Placed, FsError> {
        let dir = parent(real).ok_or_else(|| not_regular(path))?;
        let created = match self.create_temp(&dir, file_name(real)).await {
            Ok(created) => created,
            Err(FsError::PermissionDenied(_)) => return Ok(Placed::InPlace),
            Err(e) => return Err(on_user_path(e, path)),
        };
        let Some((temp, handle)) = created else {
            return Ok(Placed::InPlace);
        };
        let mine = match self.handle_attrs(&handle, path).await {
            Ok(a) => a,
            Err(e) => {
                let _ = self.close_handle(&handle, path).await;
                return Err(self.discard_now(&temp, e).await);
            }
        };
        // Renaming our file over it would hand someone else's file to us.
        if owner_differs(original, &mine) {
            let _ = self.close_handle(&handle, path).await;
            let _ = self.remove_file(&temp).await;
            return Ok(Placed::InPlace);
        }
        let mode = original
            .permissions
            .map_or(NEW_FILE_MODE, |p| p & COPIED_MODE);
        let mtime = match self.fill_temp(&handle, body, mode, path).await {
            Ok(m) => m,
            Err(e) => return Err(self.discard_now(&temp, e).await),
        };
        let placed = async {
            if checked {
                self.recheck(real, original, path).await?;
            }
            self.rename_replace(&temp, real).await
        }
        .await;
        match placed {
            Ok(()) => Ok(Placed::Done(mtime)),
            Err(e) => Err(self.discard_now(&temp, on_user_path(e, path)).await),
        }
    }

    async fn discard_now(&self, temp: &str, err: FsError) -> FsError {
        let _ = self.remove_file(temp).await;
        err
    }

    /// Rewrites `real` through one handle, never truncating by path: the handle must be the
    /// file `edit_target` saw, the new content is written over it, then the handle is cut to
    /// the new size. Keeps owner, mode and hard links; once writing started, a failure is
    /// `PartialWrite`. Used only when the temp route would change the file (other owner) or
    /// cannot be taken (directory not writable, name too long).
    async fn rewrite(
        &self,
        real: &str,
        body: &mut Body<'_>,
        original: &FileAttributes,
        path: &str,
    ) -> Result<Option<u32>, FsError> {
        let handle = self
            .raw
            .open(real, OpenFlags::WRITE, FileAttributes::empty())
            .await
            .map(|h| h.handle)
            .map_err(|e| self.fail(e, path))?;
        let result = async {
            let opened = self.handle_attrs(&handle, path).await?;
            if !same_file(original, &opened) {
                return Err(FsError::Changed(path.into()));
            }
            let partial = |_| FsError::PartialWrite(path.into());
            self.write_chunks(&handle, body, path)
                .await
                .map_err(partial)?;
            let size = FileAttributes {
                size: Some(body.sent),
                ..FileAttributes::empty()
            };
            self.raw
                .fsetstat(handle.as_str(), size)
                .await
                .map_err(|e| partial(self.fail(e, path)))?;
            self.sync(&handle, path).await.map_err(partial)?;
            let after = self.handle_attrs(&handle, path).await.map_err(partial)?;
            if after.size != Some(body.sent) {
                return Err(FsError::PartialWrite(path.into()));
            }
            Ok(after.mtime)
        }
        .await;
        let closed = self.close_handle(&handle, path).await;
        match (result, closed) {
            (Ok(m), Ok(())) => Ok(m),
            (Ok(_), Err(_)) => Err(FsError::PartialWrite(path.into())),
            (Err(e), _) => Err(e),
        }
    }

    async fn write_chunks(
        &self,
        handle: &str,
        body: &mut Body<'_>,
        path: &str,
    ) -> Result<(), FsError> {
        loop {
            let offset = body.sent;
            let Some(chunk) = body.next().await? else {
                return Ok(());
            };
            self.write_at(handle, offset, chunk, path).await?;
        }
    }

    async fn sync(&self, handle: &str, path: &str) -> Result<(), FsError> {
        if self.fsync {
            self.raw
                .fsync(handle)
                .await
                .map_err(|e| self.fail(e, path))?;
        }
        Ok(())
    }

    async fn handle_attrs(&self, handle: &str, path: &str) -> Result<FileAttributes, FsError> {
        self.raw
            .fstat(handle)
            .await
            .map(|a| a.attrs)
            .map_err(|e| self.fail(e, path))
    }
}

impl SftpManager {
    pub async fn read_text(
        &self,
        ssh: &SshManager,
        connection_id: &str,
        path: &str,
    ) -> Result<TextFile, FsError> {
        let path = normalize(path)?.ok_or_else(|| {
            FsError::invalid(crate::text!(
                "errors.files.pathRequired",
                "path is required"
            ))
        })?;
        self.remote(ssh, connection_id)
            .await?
            .read_text(&path)
            .await
    }

    pub async fn write_text(
        &self,
        ssh: &SshManager,
        connection_id: &str,
        req: WriteText<'_>,
    ) -> Result<Saved, FsError> {
        let path = normalize(req.path)?.ok_or_else(|| {
            FsError::invalid(crate::text!(
                "errors.files.pathRequired",
                "path is required"
            ))
        })?;
        if path == "/" {
            return Err(not_regular(&path));
        }
        self.remote(ssh, connection_id)
            .await?
            .write_text(WriteText { path: &path, ..req })
            .await
    }
}

#[cfg(test)]
mod tests;
