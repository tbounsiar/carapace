use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use russh::ChannelMsg;
use russh_sftp::client::RawSftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, StatusCode};
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::path::{file_name, join, normalize, parent};
use crate::files::{self, EntryKind, FileEntry, FsError, Listing, MAX_DEPTH, MAX_ENTRIES};
use crate::ssh::{SessionRef, SshManager};

pub use io::RemoteMeta;

const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT_SECS: u64 = 30;
const MAX_NAME_BYTES: usize = 255;

type Slot = Arc<tokio::sync::Mutex<Option<Arc<Remote>>>>;
type Entries = Vec<(String, FileAttributes)>;

/// One SFTP subsystem channel per connection, opened on first use on that connection.
#[derive(Default)]
pub struct SftpManager {
    slots: Mutex<HashMap<String, Slot>>,
}

pub struct Remote {
    raw: RawSftpSession,
    session: SessionRef,
    home: String,
    broken: AtomicBool,
    /// The server announced `posix-rename@openssh.com` (rename that replaces the target).
    posix_rename: bool,
    /// Dropped with the `Remote`, which ends its watcher task.
    _alive: oneshot::Sender<()>,
}

fn kind(attrs: &FileAttributes) -> Option<EntryKind> {
    Some(match attrs.permissions? & 0o170000 {
        0o040000 => EntryKind::Dir,
        0o100000 => EntryKind::File,
        0o120000 => EntryKind::Symlink,
        _ => EntryKind::Other,
    })
}

fn entry(dir: &str, name: String, attrs: &FileAttributes) -> FileEntry {
    let kind = kind(attrs).unwrap_or(EntryKind::Other);
    FileEntry {
        path: join(dir, &name),
        hidden: name.starts_with('.'),
        name,
        kind,
        size: if kind == EntryKind::File {
            attrs.size
        } else {
            None
        },
        modified: attrs.mtime.map(i64::from),
        permissions: attrs.permissions.map(files::mode_string),
    }
}

impl Remote {
    fn connected(&self) -> bool {
        !self.session.handle.is_closed() && self.session.ended.borrow().is_none()
    }

    fn usable(&self) -> bool {
        !self.broken.load(Ordering::SeqCst) && self.connected()
    }

    /// Protocol statuses map to file errors; anything else means the channel is unusable.
    fn fail(&self, e: SftpError, path: &str) -> FsError {
        match e {
            SftpError::Status(s) => match s.status_code {
                StatusCode::NoSuchFile => FsError::NotFound(path.into()),
                StatusCode::PermissionDenied => FsError::PermissionDenied(path.into()),
                _ => FsError::Io(path.into()),
            },
            _ => {
                self.broken.store(true, Ordering::SeqCst);
                if self.connected() {
                    FsError::Network
                } else {
                    FsError::NotConnected
                }
            }
        }
    }

    async fn lstat(&self, path: &str) -> Result<FileAttributes, FsError> {
        self.raw
            .lstat(path)
            .await
            .map(|a| a.attrs)
            .map_err(|e| self.fail(e, path))
    }

    async fn exists(&self, path: &str) -> Result<bool, FsError> {
        match self.lstat(path).await {
            Ok(_) => Ok(true),
            Err(FsError::NotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn kind_of(&self, path: &str, attrs: &FileAttributes) -> Result<EntryKind, FsError> {
        match kind(attrs) {
            Some(k) => Ok(k),
            None => Ok(kind(&self.lstat(path).await?).unwrap_or(EntryKind::Other)),
        }
    }

    async fn realpath(&self, path: &str) -> Result<String, FsError> {
        let name = self
            .raw
            .realpath(path)
            .await
            .map_err(|e| self.fail(e, path))?;
        let real = name.files.into_iter().next().map(|f| f.filename);
        // The server's answer is used as a path later on, so it gets the same checks as input.
        real.and_then(|r| normalize(&r).ok().flatten())
            .ok_or_else(|| FsError::Io(path.into()))
    }

    /// Entries of `path` without `.`/`..`; more than `cap` of them -> `too_large`.
    async fn read_dir(&self, path: &str, cap: usize) -> Result<Entries, FsError> {
        Ok(self.read_dir_counted(path, cap).await?.0)
    }

    /// `read_dir`, plus how many entries were dropped for an unusable name (they count towards
    /// `cap`).
    async fn read_dir_counted(&self, path: &str, cap: usize) -> Result<(Entries, u64), FsError> {
        let handle = self
            .raw
            .opendir(path)
            .await
            .map_err(|e| self.fail(e, path))?
            .handle;
        let result = self.read_handle(&handle, path, cap).await;
        if !self.broken.load(Ordering::SeqCst) {
            let _ = self.raw.close(handle).await;
        }
        result
    }

    async fn read_handle(
        &self,
        handle: &str,
        path: &str,
        cap: usize,
    ) -> Result<(Entries, u64), FsError> {
        let mut out = Vec::new();
        let mut dropped = 0usize;
        loop {
            match self.raw.readdir(handle).await {
                Ok(name) => {
                    for f in name.files {
                        if f.filename == "." || f.filename == ".." {
                            continue;
                        }
                        if out.len() + dropped >= cap {
                            return Err(FsError::TooLarge(path.into()));
                        }
                        // A hostile server could send names that address other paths, or names
                        // long enough to exhaust memory.
                        if f.filename.is_empty()
                            || f.filename.len() > MAX_NAME_BYTES
                            || f.filename.contains(['/', '\0'])
                        {
                            dropped += 1;
                            continue;
                        }
                        out.push((f.filename, f.attrs));
                    }
                }
                Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => {
                    return Ok((out, dropped as u64));
                }
                Err(e) => return Err(self.fail(e, path)),
            }
        }
    }

    async fn is_empty(&self, path: &str) -> Result<bool, FsError> {
        match self.read_dir(path, 0).await {
            Ok(_) => Ok(true),
            Err(FsError::TooLarge(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn remove_file(&self, path: &str) -> Result<(), FsError> {
        self.raw
            .remove(path)
            .await
            .map(|_| ())
            .map_err(|e| self.fail(e, path))
    }

    async fn rmdir(&self, path: &str) -> Result<(), FsError> {
        match self.raw.rmdir(path).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let err = self.fail(e, path);
                // SFTP v3 has no "not empty" status; OpenSSH reports a generic failure.
                if matches!(err, FsError::Io(_)) && !self.is_empty(path).await.unwrap_or(true) {
                    return Err(FsError::NotEmpty(path.into()));
                }
                Err(err)
            }
        }
    }

    /// Depth-first on `real`, a path the server resolved itself. Never follows symlinks: each
    /// child is `lstat`ed again (readdir attributes are not trusted) and a directory is entered
    /// only if the server resolves it to itself, which narrows a swap-for-a-link race to the
    /// time between that check and its listing.
    fn remove_tree<'a>(
        &'a self,
        real: String,
        depth: usize,
    ) -> Pin<Box<dyn Future<Output = Result<(), FsError>> + Send + 'a>> {
        Box::pin(async move {
            if depth >= MAX_DEPTH {
                return Err(FsError::TooLarge(real));
            }
            for (name, _) in self.read_dir(&real, MAX_ENTRIES).await? {
                let child = join(&real, &name);
                let attrs = self.lstat(&child).await?;
                if kind(&attrs) != Some(EntryKind::Dir) {
                    self.remove_file(&child).await?;
                    continue;
                }
                if self.realpath(&child).await? != child {
                    return Err(FsError::Io(child));
                }
                self.remove_tree(child, depth + 1).await?;
            }
            self.rmdir(&real).await
        })
    }

    async fn entry_at(&self, path: &str) -> Result<FileEntry, FsError> {
        let attrs = self.lstat(path).await?;
        let dir = parent(path).unwrap_or_else(|| "/".into());
        Ok(entry(&dir, file_name(path).to_owned(), &attrs))
    }

    fn resolve(&self, raw: &str) -> Result<String, FsError> {
        Ok(normalize(raw)?.unwrap_or_else(|| self.home.clone()))
    }
}

async fn open(session: SessionRef) -> Result<(Remote, oneshot::Receiver<()>), FsError> {
    let lost = |session: &SessionRef| {
        if session.handle.is_closed() || session.ended.borrow().is_some() {
            FsError::NotConnected
        } else {
            FsError::Network
        }
    };
    let mut channel = match timeout(OPEN_TIMEOUT, session.handle.channel_open_session()).await {
        Ok(Ok(c)) => c,
        _ => return Err(lost(&session)),
    };
    let accepted = timeout(OPEN_TIMEOUT, async {
        channel.request_subsystem(true, "sftp").await.ok()?;
        loop {
            match channel.wait().await? {
                ChannelMsg::Success => return Some(()),
                ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof => return None,
                _ => {}
            }
        }
    })
    .await;
    if !matches!(accepted, Ok(Some(()))) {
        let _ = timeout(Duration::from_secs(2), channel.close()).await;
        return Err(lost(&session));
    }
    let raw = RawSftpSession::new_with_config(
        channel.into_stream(),
        russh_sftp::client::Config {
            request_timeout_secs: REQUEST_TIMEOUT_SECS,
            ..Default::default()
        },
    );
    let version = match timeout(OPEN_TIMEOUT, raw.init()).await {
        Ok(Ok(v)) => v,
        _ => return Err(lost(&session)),
    };
    let (alive, gone) = oneshot::channel();
    let mut remote = Remote {
        raw,
        session,
        home: String::new(),
        broken: AtomicBool::new(false),
        posix_rename: version.extensions.contains_key(io::POSIX_RENAME),
        _alive: alive,
    };
    remote.home = remote.realpath(".").await.map_err(|e| match e {
        FsError::NotConnected | FsError::Network => e,
        _ => FsError::Network,
    })?;
    Ok((remote, gone))
}

impl SftpManager {
    fn slot(&self, connection_id: &str) -> Slot {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.entry(connection_id.to_owned()).or_default().clone()
    }

    async fn remote(&self, ssh: &SshManager, connection_id: &str) -> Result<Arc<Remote>, FsError> {
        // Checked before `slot` so unknown or disconnected connection ids never get a map entry.
        let session = ssh
            .session(connection_id)
            .await
            .ok_or(FsError::NotConnected)?;
        let slot = self.slot(connection_id);
        let mut current = slot.lock().await;
        if let Some(r) = current.as_ref().filter(|r| r.usable()) {
            return Ok(r.clone());
        }
        *current = None;
        let (remote, gone) = open(session).await?;
        let remote = Arc::new(remote);
        watch_end(Arc::downgrade(&slot), &remote, gone);
        *current = Some(remote.clone());
        Ok(remote)
    }

    /// The connection's shared SFTP channel, for modules doing their own file I/O on it.
    pub async fn channel(
        &self,
        ssh: &SshManager,
        connection_id: &str,
    ) -> Result<Arc<Remote>, FsError> {
        self.remote(ssh, connection_id).await
    }

    #[cfg(test)]
    async fn is_open(&self, connection_id: &str) -> bool {
        let slot = self.slots.lock().unwrap().get(connection_id).cloned();
        match slot {
            Some(s) => s.lock().await.is_some(),
            None => false,
        }
    }

    #[cfg(test)]
    fn slot_count(&self) -> usize {
        self.slots.lock().unwrap().len()
    }

    pub async fn list(
        &self,
        ssh: &SshManager,
        connection_id: &str,
        path: &str,
    ) -> Result<Listing, FsError> {
        let r = self.remote(ssh, connection_id).await?;
        let target = r.resolve(path)?;
        let canonical = r.realpath(&target).await?;
        if r.lstat(&canonical).await.map(|a| kind(&a))? != Some(EntryKind::Dir) {
            return Err(FsError::invalid(format!("{canonical} is not a directory")));
        }
        let entries = r
            .read_dir(&canonical, MAX_ENTRIES)
            .await?
            .into_iter()
            .map(|(name, attrs)| entry(&canonical, name, &attrs))
            .collect();
        Ok(Listing {
            parent: parent(&canonical),
            path: canonical,
            entries,
        })
    }

    pub async fn mkdir(
        &self,
        ssh: &SshManager,
        connection_id: &str,
        parent_dir: &str,
        name: &str,
    ) -> Result<FileEntry, FsError> {
        files::name(name)?;
        let r = self.remote(ssh, connection_id).await?;
        let path = join(&r.resolve(parent_dir)?, name);
        if r.exists(&path).await? {
            return Err(FsError::AlreadyExists(path));
        }
        if let Err(e) = r.raw.mkdir(path.as_str(), FileAttributes::empty()).await {
            let err = r.fail(e, &path);
            if matches!(err, FsError::Io(_)) && r.exists(&path).await? {
                return Err(FsError::AlreadyExists(path));
            }
            return Err(err);
        }
        r.entry_at(&path).await
    }

    pub async fn rename(
        &self,
        ssh: &SshManager,
        connection_id: &str,
        path: &str,
        new_name: &str,
    ) -> Result<FileEntry, FsError> {
        files::name(new_name)?;
        let source = normalize(path)?.ok_or_else(|| FsError::invalid("path is required"))?;
        let dir = parent(&source).ok_or_else(|| FsError::invalid("cannot rename /"))?;
        let r = self.remote(ssh, connection_id).await?;
        let target = join(&dir, new_name);
        if target == source {
            return r.entry_at(&source).await;
        }
        r.lstat(&source).await?;
        if r.exists(&target).await? {
            return Err(FsError::AlreadyExists(target));
        }
        if let Err(e) = r.raw.rename(source.as_str(), target.as_str()).await {
            let err = r.fail(e, &source);
            if matches!(err, FsError::Io(_)) && r.exists(&target).await? {
                return Err(FsError::AlreadyExists(target));
            }
            return Err(err);
        }
        r.entry_at(&target).await
    }

    pub async fn delete(
        &self,
        ssh: &SshManager,
        connection_id: &str,
        path: &str,
        recursive: bool,
    ) -> Result<(), FsError> {
        let target = normalize(path)?
            .ok_or_else(|| FsError::invalid("refusing to delete the home directory"))?;
        if target == "/" {
            return Err(FsError::invalid("refusing to delete /"));
        }
        let r = self.remote(ssh, connection_id).await?;
        let attrs = r.lstat(&target).await?;
        if r.kind_of(&target, &attrs).await? != EntryKind::Dir {
            return r.remove_file(&target).await;
        }
        let real = r.realpath(&target).await?;
        if real == "/" || real == r.home || target == r.home {
            return Err(FsError::invalid(format!("refusing to delete {target}")));
        }
        if recursive {
            r.remove_tree(real, 0).await
        } else if !r.is_empty(&target).await? {
            Err(FsError::NotEmpty(target))
        } else {
            r.rmdir(&target).await
        }
    }
}

/// Forgets the channel as soon as the connection ends, so nothing keeps a dead channel around.
fn watch_end(
    slot: Weak<tokio::sync::Mutex<Option<Arc<Remote>>>>,
    remote: &Arc<Remote>,
    gone: oneshot::Receiver<()>,
) {
    let mut ended = remote.session.ended.clone();
    let weak = Arc::downgrade(remote);
    tokio::spawn(async move {
        tokio::select! {
            _ = ended.wait_for(|e| e.is_some()) => {}
            _ = gone => return,
        }
        let Some(slot) = slot.upgrade() else { return };
        let mut current = slot.lock().await;
        if let Some(r) = weak.upgrade()
            && current.as_ref().is_some_and(|c| Arc::ptr_eq(c, &r))
        {
            *current = None;
        }
    });
}

#[cfg(test)]
mod e2e_tests;
mod io;
#[cfg(test)]
mod tests;
