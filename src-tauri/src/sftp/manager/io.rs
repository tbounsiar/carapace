//! File I/O on the shared channel for the transfer queue. Names and paths are built by the
//! caller from checked components; nothing here follows a symlink unless stated.

use russh_sftp::protocol::{OpenFlags, Packet};
use serde::Serialize;
use tokio::sync::watch;

use super::*;
use crate::ssh::SessionEnd;

pub const POSIX_RENAME: &str = "posix-rename@openssh.com";

/// What `lstat` says about a path; `kind` is `Symlink` for a link, never its target.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemoteMeta {
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub modified: Option<i64>,
    /// Permission bits (`0o7777`), when the server sent them.
    pub mode: Option<u32>,
}

/// Bounded attempts at a free backup name.
const MAX_BACKUPS: u32 = 16;

fn meta(attrs: &FileAttributes) -> RemoteMeta {
    RemoteMeta {
        kind: kind(attrs).unwrap_or(EntryKind::Other),
        size: attrs.size,
        modified: attrs.mtime.map(i64::from),
        mode: attrs.permissions.map(|p| p & 0o7777),
    }
}

/// `.{name}.carapace-old`, then `.{name}.1.carapace-old`...; `None` past 255 bytes.
pub fn backup_name(name: &str, n: u32) -> Option<String> {
    let backup = if n == 0 {
        format!(".{name}.carapace-old")
    } else {
        format!(".{name}.{n}.carapace-old")
    };
    (backup.len() <= 255).then_some(backup)
}

fn mode(bits: u32) -> FileAttributes {
    FileAttributes {
        permissions: Some(bits),
        ..FileAttributes::empty()
    }
}

#[derive(Serialize)]
struct RenamePaths<'a> {
    oldpath: &'a str,
    newpath: &'a str,
}

impl Remote {
    pub fn ended(&self) -> watch::Receiver<Option<SessionEnd>> {
        self.session.ended.clone()
    }

    /// Normalized absolute path, `""` being the home directory.
    pub fn absolute(&self, raw: &str) -> Result<String, FsError> {
        self.resolve(raw)
    }

    /// `None` when nothing exists at `path`.
    pub async fn stat_link(&self, path: &str) -> Result<Option<RemoteMeta>, FsError> {
        match self.lstat(path).await {
            Ok(a) => Ok(Some(meta(&a))),
            Err(FsError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn canonical(&self, path: &str) -> Result<String, FsError> {
        self.realpath(path).await
    }

    /// Children of `path` with their readdir attributes (callers re-check directories before
    /// entering them), and how many entries were dropped for an unusable name.
    pub async fn children(
        &self,
        path: &str,
        cap: usize,
    ) -> Result<(Vec<(String, RemoteMeta)>, u64), FsError> {
        let (entries, dropped) = self.read_dir_counted(path, cap).await?;
        let entries = entries
            .into_iter()
            .map(|(name, attrs)| (name, meta(&attrs)))
            .collect();
        Ok((entries, dropped))
    }

    /// `mkdir` with `bits` (the server's umask applies); an existing entry is `AlreadyExists`.
    pub async fn make_dir(&self, path: &str, bits: u32) -> Result<(), FsError> {
        if let Err(e) = self.raw.mkdir(path, mode(bits)).await {
            let err = self.fail(e, path);
            if matches!(err, FsError::Io(_)) && self.exists(path).await? {
                return Err(FsError::AlreadyExists(path.into()));
            }
            return Err(err);
        }
        Ok(())
    }

    /// Opens for reading. The server resolves links here, so callers `lstat` first.
    pub async fn open_read(&self, path: &str) -> Result<String, FsError> {
        self.raw
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await
            .map(|h| h.handle)
            .map_err(|e| self.fail(e, path))
    }

    /// Creates a new owner-only (0o600) file. `O_EXCL` semantics: an existing entry, a symlink
    /// included, fails with `AlreadyExists` instead of being opened or followed.
    pub async fn create_new(&self, path: &str) -> Result<String, FsError> {
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE;
        match self.raw.open(path, flags, mode(0o600)).await {
            Ok(h) => Ok(h.handle),
            Err(e) => {
                let err = self.fail(e, path);
                if matches!(err, FsError::Io(_)) && self.exists(path).await? {
                    return Err(FsError::AlreadyExists(path.into()));
                }
                Err(err)
            }
        }
    }

    pub async fn stat_handle(&self, handle: &str, path: &str) -> Result<RemoteMeta, FsError> {
        self.raw
            .fstat(handle)
            .await
            .map(|a| meta(&a.attrs))
            .map_err(|e| self.fail(e, path))
    }

    /// At most `len` bytes at `offset`; `None` at end of file.
    pub async fn read_at(
        &self,
        handle: &str,
        offset: u64,
        len: u32,
        path: &str,
    ) -> Result<Option<Vec<u8>>, FsError> {
        match self.raw.read(handle, offset, len).await {
            Ok(d) if d.data.len() > len as usize => Err(FsError::Io(path.into())),
            Ok(d) => Ok(Some(d.data)),
            Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => Ok(None),
            Err(e) => Err(self.fail(e, path)),
        }
    }

    pub async fn write_at(
        &self,
        handle: &str,
        offset: u64,
        data: Vec<u8>,
        path: &str,
    ) -> Result<(), FsError> {
        self.raw
            .write(handle, offset, data)
            .await
            .map(|_| ())
            .map_err(|e| self.fail(e, path))
    }

    /// Sets permission bits through the handle, never by path (which could be swapped for a
    /// link). A server refusing it leaves the file owner-only, which is not an error.
    pub async fn set_handle_mode(
        &self,
        handle: &str,
        bits: u32,
        path: &str,
    ) -> Result<(), FsError> {
        match self.raw.fsetstat(handle, mode(bits)).await {
            Ok(_) | Err(SftpError::Status(_)) => Ok(()),
            Err(e) => Err(self.fail(e, path)),
        }
    }

    pub async fn close_handle(&self, handle: &str, path: &str) -> Result<(), FsError> {
        if self.broken.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.raw
            .close(handle)
            .await
            .map(|_| ())
            .map_err(|e| self.fail(e, path))
    }

    /// Removes a file or a symlink (the link itself), never a directory.
    pub async fn remove_entry(&self, path: &str) -> Result<(), FsError> {
        self.remove_file(path).await
    }

    /// Never replaces: SFTP v3 rename fails on an existing target (OpenSSH links and unlinks).
    pub async fn rename_new(&self, from: &str, to: &str) -> Result<(), FsError> {
        if let Err(e) = self.raw.rename(from, to).await {
            let err = self.fail(e, from);
            if matches!(err, FsError::Io(_)) && self.exists(to).await? {
                return Err(FsError::AlreadyExists(to.into()));
            }
            return Err(err);
        }
        Ok(())
    }

    /// Replaces `to` (a file or the link itself), atomically when the server supports
    /// `posix-rename@openssh.com`. Otherwise `to` is first moved to a backup sibling, so the
    /// original is never lost: it is put back if the second rename fails.
    pub async fn rename_replace(&self, from: &str, to: &str) -> Result<(), FsError> {
        if !self.posix_rename {
            let Some(backup) = self.move_aside(to).await? else {
                return self.rename_new(from, to).await;
            };
            return match self.rename_new(from, to).await {
                Ok(()) => {
                    let _ = self.remove_file(&backup).await;
                    Ok(())
                }
                Err(e) => {
                    let _ = self.rename_new(&backup, to).await;
                    Err(e)
                }
            };
        }
        let data = russh_sftp::ser::to_bytes(&RenamePaths {
            oldpath: from,
            newpath: to,
        })
        .map_err(|_| FsError::Io(to.into()))?;
        match self.raw.extended(POSIX_RENAME, data.to_vec()).await {
            Ok(Packet::Status(s)) if s.status_code == StatusCode::Ok => Ok(()),
            Ok(Packet::Status(s)) => Err(self.fail(SftpError::Status(s), to)),
            Ok(_) => Err(self.fail(SftpError::UnexpectedPacket, to)),
            Err(e) => Err(self.fail(e, to)),
        }
    }

    /// Renames `path` to a free backup sibling (never replacing one); `None` when `path` does
    /// not exist.
    async fn move_aside(&self, path: &str) -> Result<Option<String>, FsError> {
        let dir = parent(path).ok_or_else(|| FsError::Io(path.into()))?;
        for n in 0..MAX_BACKUPS {
            let Some(name) = backup_name(file_name(path), n) else {
                break;
            };
            let backup = join(&dir, &name);
            match self.rename_new(path, &backup).await {
                Ok(()) => return Ok(Some(backup)),
                Err(FsError::NotFound(_)) => return Ok(None),
                Err(FsError::AlreadyExists(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Err(FsError::AlreadyExists(path.into()))
    }
}
