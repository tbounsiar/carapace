use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};

use super::disk::{self, Manifest, Slot};
use super::error::EditError;
use super::launch::{self, Launcher, Opener};
use super::rules::{self, Size};
use super::state::{self, ConflictKind, EditedFile, ErrorView, Failure, State, Trigger};
use super::watch::{self as watcher, Signal, Watch};
use crate::files::FsError;
use crate::sftp::{self, Body, Remote, Version};
use crate::ssh::SessionEnd;
use crate::transfer::Connections;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditEvent {
    Updated { file: EditedFile },
    Removed { id: String },
}

/// `false` when the event could not be delivered; the subscriber is dropped then.
pub type EditEmit = Arc<dyn Fn(EditEvent) -> bool + Send + Sync>;
/// Asks for the user's attention (the window decides whether it is needed).
pub type Attention = Arc<dyn Fn() + Send + Sync>;
/// The opener chosen in the settings, read at each launch.
pub type Settings = Arc<dyn Fn() -> Opener + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Choice {
    #[serde(rename = "overwrite")]
    Overwrite,
    #[serde(rename = "useServer", alias = "use_server")]
    UseServer,
}

pub struct OpenRequest<'a> {
    pub connection_id: &'a str,
    pub path: &'a str,
    /// Size from the listing, checked before any network call; the server's is checked too.
    pub size: Option<u64>,
    pub confirm_large: bool,
    pub confirm_sensitive: bool,
}

struct HostWatch {
    serial: u64,
    ended: watch::Receiver<Option<SessionEnd>>,
}

impl HostWatch {
    fn live(&self) -> bool {
        self.ended.borrow().is_none()
    }
}

struct Entry {
    slot: Slot,
    host_id: String,
    remote_path: String,
    name: String,
    token: String,
    target: Option<String>,
    synced_hash: String,
    synced_size: u64,
    opened_at: u64,
    synced_at: Option<u64>,
    uploaded_at: Option<u64>,
    recovered_at: Option<u64>,
    state: State,
    conflict: Option<ConflictKind>,
    error: Option<ErrorView>,
    /// A change was seen in the copy and not hashed yet.
    seen: bool,
    /// A save upload is waiting for the upload lock; later saves need no other task.
    queued: bool,
    /// Bumped by the watcher for every change it sees in the copy.
    changes: Arc<AtomicU64>,
    /// `changes` when the copy last matched `synced_hash`.
    synced_changes: u64,
    watch: Option<Watch>,
    upload: Arc<tokio::sync::Mutex<()>>,
    /// Host key fingerprint and endpoint the file was opened from; uploads require the same.
    host_key: String,
    endpoint: String,
    /// False for a recovered copy whose host no longer exists.
    can_upload: bool,
}

impl Entry {
    fn view(&self) -> EditedFile {
        EditedFile {
            id: self.slot.id.clone(),
            host_id: self.host_id.clone(),
            remote_path: self.remote_path.clone(),
            name: self.name.clone(),
            state: self.state,
            conflict: self.conflict.filter(|_| self.state == State::Conflict),
            error: self.error.clone().filter(|_| self.state == State::Failed),
            opened_at: self.opened_at,
            last_synced_at: self.synced_at,
            last_uploaded_at: self.uploaded_at,
            recovered_at: self.recovered_at.filter(|_| self.state == State::Recovered),
            size: self.synced_size,
            not_uploaded: self.state.not_uploaded() || self.seen,
            needs_attention: self.state.needs_attention(),
            watched: self.watch.is_some(),
            can_upload: self.can_upload,
        }
    }

    fn manifest(&self) -> Manifest {
        Manifest {
            version: 1,
            host_id: self.host_id.clone(),
            remote_path: self.remote_path.clone(),
            file_name: self.slot.name.clone(),
            token: self.token.clone(),
            target: self.target.clone(),
            synced_hash: self.synced_hash.clone(),
            synced_size: self.synced_size,
            opened_at: self.opened_at,
            synced_at: self.synced_at,
            uploaded_at: self.uploaded_at,
            host_key: self.host_key.clone(),
            endpoint: self.endpoint.clone(),
        }
    }

    fn not_uploaded(&self) -> bool {
        self.state.not_uploaded() || self.seen
    }
}

#[derive(Default)]
struct Inner {
    files: HashMap<String, Entry>,
    subscriber: Option<EditEmit>,
    attention: Option<Attention>,
    hosts: HashMap<String, HostWatch>,
    next_serial: u64,
    recovered_signalled: bool,
}

struct Shared {
    root: PathBuf,
    conns: Arc<dyn Connections>,
    launcher: Arc<dyn Launcher>,
    settings: Settings,
    quiet: Duration,
    inner: Mutex<Inner>,
}

/// Files of any host open in an external editor. Cheap to clone.
#[derive(Clone)]
pub struct ExternalEdits(Arc<Shared>);

/// Events and attention requests collected under the lock, delivered after it.
#[derive(Default)]
struct Out {
    events: Vec<EditEvent>,
    attention: bool,
}

fn version_hash(token: &str) -> String {
    Version::parse(token).map(|v| v.hash).unwrap_or_default()
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T, EditError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| EditError::Local)?
        .map_err(|_| EditError::Local)
}

fn size_gate(size: u64, confirm: bool, name: &str) -> Result<(), EditError> {
    match rules::size_class(size) {
        Size::Refused => Err(EditError::TooLarge { name: name.into() }),
        Size::Confirm if !confirm => Err(EditError::LargeFile {
            name: name.into(),
            size,
        }),
        _ => Ok(()),
    }
}

fn order(state: State) -> u8 {
    match state {
        State::Conflict => 0,
        State::Failed => 1,
        State::Waiting => 2,
        State::Recovered => 3,
        _ => 4,
    }
}

impl ExternalEdits {
    /// Scans `home/edit` for leftovers first: synced ones are deleted, the others are listed
    /// as recovered.
    pub fn new(
        home: &Path,
        conns: Arc<dyn Connections>,
        launcher: Arc<dyn Launcher>,
        settings: Settings,
    ) -> Self {
        Self::with_quiet(home, conns, launcher, settings, watcher::QUIET)
    }

    pub fn with_quiet(
        home: &Path,
        conns: Arc<dyn Connections>,
        launcher: Arc<dyn Launcher>,
        settings: Settings,
        quiet: Duration,
    ) -> Self {
        let root = disk::root(home);
        let mut inner = Inner::default();
        for found in disk::scan(&root) {
            let m = found.manifest;
            inner.files.insert(
                found.slot.id.clone(),
                Entry {
                    name: sftp::file_name(&m.remote_path).to_owned(),
                    host_key: m.host_key,
                    endpoint: m.endpoint,
                    can_upload: true,
                    slot: found.slot,
                    host_id: m.host_id,
                    remote_path: m.remote_path,
                    token: m.token,
                    target: m.target,
                    synced_hash: m.synced_hash,
                    synced_size: found.size,
                    opened_at: m.opened_at,
                    synced_at: m.synced_at,
                    uploaded_at: m.uploaded_at,
                    recovered_at: found.modified_ms,
                    state: State::Recovered,
                    conflict: None,
                    error: None,
                    seen: false,
                    queued: false,
                    changes: Default::default(),
                    synced_changes: 0,
                    watch: None,
                    upload: Default::default(),
                },
            );
        }
        Self(Arc::new(Shared {
            root,
            conns,
            launcher,
            settings,
            quiet,
            inner: Mutex::new(inner),
        }))
    }

    /// Recovered copies of hosts that no longer exist can only be shown or discarded.
    pub fn retain_known_hosts(&self, known: impl Fn(&str) -> bool) {
        for e in self.0.lock().files.values_mut() {
            e.can_upload = known(&e.host_id);
        }
    }

    pub fn set_attention(&self, attention: Attention) {
        self.0.lock().attention = Some(attention);
    }

    /// Live events go to `emit` from now on; returns the current list under the same lock.
    pub fn subscribe(&self, emit: EditEmit) -> Vec<EditedFile> {
        let (list, attention) = {
            let mut inner = self.0.lock();
            inner.subscriber = Some(emit);
            let recovered = inner.files.values().any(|e| e.state == State::Recovered);
            let signal = recovered && !inner.recovered_signalled;
            inner.recovered_signalled |= recovered;
            (
                sorted(&inner),
                signal.then(|| inner.attention.clone()).flatten(),
            )
        };
        if let Some(a) = attention {
            a();
        }
        list
    }

    pub fn unsubscribe(&self) {
        self.0.lock().subscriber = None;
    }

    pub fn list(&self) -> Vec<EditedFile> {
        sorted(&self.0.lock())
    }

    /// Some edited file has changes that are not on the server (the quit check).
    pub fn has_unsynced(&self) -> bool {
        self.0.lock().files.values().any(Entry::not_uploaded)
    }

    /// Files of these hosts, for the delete confirmations.
    pub fn affected(&self, host_ids: &[String]) -> Vec<EditedFile> {
        sorted(&self.0.lock())
            .into_iter()
            .filter(|f| host_ids.contains(&f.host_id))
            .collect()
    }

    pub async fn open(&self, req: OpenRequest<'_>) -> Result<EditedFile, EditError> {
        self.0.clone().open(req).await
    }

    pub async fn upload_now(&self, id: &str) -> Result<EditedFile, EditError> {
        self.0.clone().upload(id, Trigger::Explicit).await
    }

    /// Only for a file in conflict. `confirm_large`: "use server version" may download more
    /// than the confirm threshold.
    pub async fn resolve(
        &self,
        id: &str,
        choice: Choice,
        confirm_large: bool,
    ) -> Result<EditedFile, EditError> {
        {
            let inner = self.0.lock();
            let e = inner.files.get(id).ok_or(EditError::UnknownId)?;
            if e.state != State::Conflict {
                return Err(EditError::NoConflict(e.remote_path.clone()));
            }
        }
        match choice {
            Choice::Overwrite => self.0.clone().upload(id, Trigger::Force).await,
            Choice::UseServer => self.0.clone().use_server(id, confirm_large).await,
        }
    }

    pub async fn stop(&self, id: &str, force: bool) -> Result<(), EditError> {
        self.0.stop(id, force, false).await
    }

    /// Stops every file; without `force`, nothing is stopped while one is not uploaded.
    pub async fn stop_all(&self, force: bool) -> Result<usize, EditError> {
        let ids: Vec<String> = {
            let inner = self.0.lock();
            if !force && let Some(e) = inner.files.values().find(|e| e.not_uploaded()) {
                return Err(EditError::NotUploaded(e.remote_path.clone()));
            }
            inner.files.keys().cloned().collect()
        };
        for id in &ids {
            self.0.stop(id, force, false).await?;
        }
        Ok(ids.len())
    }

    pub async fn discard(&self, id: &str) -> Result<(), EditError> {
        self.0.stop(id, true, true).await
    }

    pub async fn reveal(&self, id: &str) -> Result<(), EditError> {
        let slot = self.0.slot(id)?;
        let launcher = self.0.launcher.clone();
        tokio::task::spawn_blocking(move || {
            slot.check().map_err(|_| EditError::Local)?;
            launcher.reveal(&slot.file())
        })
        .await
        .map_err(|_| EditError::Local)?
    }

    /// The host connected again: synced files show it, waiting files upload in turn.
    pub async fn host_connected(&self, host_id: &str) {
        let shared = self.0.clone();
        let has_files = shared.lock().files.values().any(|e| e.host_id == host_id);
        if !has_files {
            return;
        }
        let Ok(remote) = shared.conns.remote(host_id).await else {
            return;
        };
        shared.watch_host(host_id, &remote);
        let mut out = Out::default();
        let waiting: Vec<String> = {
            let mut inner = shared.lock();
            for e in inner.files.values_mut().filter(|e| e.host_id == host_id) {
                let next = state::host_up(e.state);
                if next != e.state {
                    e.state = next;
                    out.events.push(EditEvent::Updated { file: e.view() });
                }
            }
            inner
                .files
                .values()
                .filter(|e| e.host_id == host_id && e.state == State::Waiting)
                .map(|e| e.slot.id.clone())
                .collect()
        };
        shared.deliver(out);
        tokio::spawn(async move {
            for id in waiting {
                let _ = shared.clone().upload(&id, Trigger::Drain).await;
            }
        });
    }

    /// The hosts were deleted: their files stop syncing and their copies are deleted.
    pub fn forget_hosts(&self, host_ids: &[String]) {
        let mut out = Out::default();
        let gone: Vec<Entry> = {
            let mut inner = self.0.lock();
            for h in host_ids {
                inner.hosts.remove(h);
            }
            let ids: Vec<String> = inner
                .files
                .values()
                .filter(|e| host_ids.contains(&e.host_id))
                .map(|e| e.slot.id.clone())
                .collect();
            ids.iter().filter_map(|id| inner.files.remove(id)).collect()
        };
        for e in gone {
            drop(e.watch);
            if e.slot.remove().is_err() {
                log::warn!("could not delete the copy of an edited file of a deleted host");
            }
            out.events.push(EditEvent::Removed { id: e.slot.id });
        }
        self.0.deliver(out);
    }

    /// At exit: copies equal to the server's are deleted; others stay for the next start.
    pub fn shutdown(&self) {
        let entries: Vec<Entry> = self.0.lock().files.drain().map(|(_, e)| e).collect();
        for mut e in entries {
            e.watch = None;
            if e.state.not_uploaded() || e.state == State::Opening {
                continue;
            }
            if e.slot.remove_if_synced(&e.synced_hash, || false).is_err() {
                log::warn!("could not check or delete the copy of an edited file at exit");
            }
        }
    }
}

fn sorted(inner: &Inner) -> Vec<EditedFile> {
    let mut list: Vec<EditedFile> = inner.files.values().map(Entry::view).collect();
    list.sort_by(|a, b| {
        (order(a.state), &a.host_id, &a.remote_path).cmp(&(
            order(b.state),
            &b.host_id,
            &b.remote_path,
        ))
    });
    list
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn deliver(&self, out: Out) {
        let (emit, attention) = {
            let inner = self.lock();
            (inner.subscriber.clone(), inner.attention.clone())
        };
        if let Some(emit) = emit {
            for event in out.events {
                if !emit(event) {
                    self.lock().subscriber = None;
                    break;
                }
            }
        }
        if out.attention
            && let Some(a) = attention
        {
            a();
        }
    }

    /// Applies `f` to the entry (if it still exists) and reports the change.
    fn update(&self, id: &str, f: impl FnOnce(&mut Entry)) -> Option<EditedFile> {
        let mut out = Out::default();
        let view = {
            let mut inner = self.lock();
            let e = inner.files.get_mut(id)?;
            let before = e.state;
            f(e);
            out.attention = e.state != before && e.state.wants_attention();
            let view = e.view();
            out.events.push(EditEvent::Updated { file: view.clone() });
            view
        };
        self.deliver(out);
        Some(view)
    }

    fn view(&self, id: &str) -> Result<EditedFile, EditError> {
        self.lock()
            .files
            .get(id)
            .map(Entry::view)
            .ok_or(EditError::UnknownId)
    }

    fn slot(&self, id: &str) -> Result<Slot, EditError> {
        self.lock()
            .files
            .get(id)
            .map(|e| e.slot.clone())
            .ok_or(EditError::UnknownId)
    }

    fn host_live(&self, host_id: &str) -> bool {
        self.lock().hosts.get(host_id).is_some_and(HostWatch::live)
    }

    fn save_manifest(&self, id: &str) {
        let Some((slot, manifest)) = self
            .lock()
            .files
            .get(id)
            .map(|e| (e.slot.clone(), e.manifest()))
        else {
            return;
        };
        if slot.write_manifest(&manifest).is_err() {
            log::warn!("could not write the manifest of an edited file");
        }
    }

    /// Follows the end of the host's current session.
    fn watch_host(self: &Arc<Self>, host_id: &str, remote: &Remote) {
        let ended = remote.ended();
        let serial = {
            let mut inner = self.lock();
            if inner.hosts.get(host_id).is_some_and(HostWatch::live) {
                return;
            }
            inner.next_serial += 1;
            let serial = inner.next_serial;
            inner.hosts.insert(
                host_id.to_owned(),
                HostWatch {
                    serial,
                    ended: ended.clone(),
                },
            );
            serial
        };
        let weak = Arc::downgrade(self);
        let host = host_id.to_owned();
        let mut ended = ended;
        tokio::spawn(async move {
            let _ = ended.wait_for(|e| e.is_some()).await;
            if let Some(shared) = weak.upgrade() {
                shared.host_down(&host, serial);
            }
        });
    }

    fn host_down(&self, host_id: &str, serial: u64) {
        let mut out = Out::default();
        {
            let mut inner = self.lock();
            if inner.hosts.get(host_id).map(|h| h.serial) != Some(serial) {
                return;
            }
            for e in inner.files.values_mut().filter(|e| e.host_id == host_id) {
                let next = state::host_down(e.state);
                if next != e.state {
                    e.state = next;
                    out.events.push(EditEvent::Updated { file: e.view() });
                }
            }
        }
        self.deliver(out);
    }

    fn start_watch(self: &Arc<Self>, id: &str) -> Result<(), EditError> {
        let slot = self.slot(id)?;
        let (tx, rx) = mpsc::unbounded_channel();
        let changes = self
            .lock()
            .files
            .get(id)
            .map(|e| e.changes.clone())
            .ok_or(EditError::UnknownId)?;
        let mut watch =
            watcher::watch(&slot.dir, &slot.name, changes, tx).map_err(|_| EditError::Local)?;
        let weak: Weak<Shared> = Arc::downgrade(self);
        let key = id.to_owned();
        let quiet = self.quiet;
        watch.attach(tokio::spawn(watcher::debounce(rx, quiet, move |signal| {
            let Some(shared) = weak.upgrade() else { return };
            match signal {
                Signal::Seen => {
                    if let Some(e) = shared.lock().files.get_mut(&key) {
                        e.seen = true;
                    }
                }
                Signal::Settled => shared.saved(&key),
            }
        })));
        let mut inner = self.lock();
        if let Some(e) = inner.files.get_mut(id) {
            e.watch = Some(watch);
        }
        Ok(())
    }

    fn saved(self: &Arc<Self>, id: &str) {
        {
            let mut inner = self.lock();
            let Some(e) = inner.files.get_mut(id) else {
                return;
            };
            if e.queued {
                return;
            }
            e.queued = true;
        }
        let shared = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let _ = shared.upload(&id, Trigger::Save).await;
        });
    }

    async fn open(self: Arc<Self>, req: OpenRequest<'_>) -> Result<EditedFile, EditError> {
        let host = req.connection_id;
        let path = sftp::normalize(req.path)?
            .filter(|p| p != "/")
            .ok_or_else(|| EditError::invalid("path must name a file"))?;
        let name = sftp::file_name(&path).to_owned();
        let opener = (self.settings)();
        if let Some(id) = self.find(host, &path) {
            return self.relaunch(&id, &opener).await;
        }
        if rules::is_sensitive(&path) && !req.confirm_sensitive {
            return Err(EditError::Sensitive { name });
        }
        let local_name = rules::local_name(&name);
        let (ln, how) = (local_name.clone(), opener.clone());
        tokio::task::spawn_blocking(move || {
            launch::check_type(&ln, None, &how)?;
            if let Opener::App(app) = &how {
                launch::check_app(app)?;
            }
            Ok::<(), EditError>(())
        })
        .await
        .map_err(|_| EditError::Local)??;
        if let Some(size) = req.size {
            size_gate(size, req.confirm_large, &name)?;
        }
        let remote = self.conns.remote(host).await?;
        let (size, real) = match remote.edit_size(&path).await {
            Ok((s, real)) => (s.unwrap_or(0), real),
            Err(FsError::InvalidInput(_)) => return Err(EditError::NotRegular(path)),
            Err(e) => return Err(e.into()),
        };
        // A link with an innocent name, or a linked parent directory, can lead to a key: the
        // server's full resolution counts too.
        let full = remote.canonical(&path).await?;
        if (rules::is_sensitive(&real) || rules::is_sensitive(&full)) && !req.confirm_sensitive {
            return Err(EditError::Sensitive { name });
        }
        size_gate(size, req.confirm_large, &name)?;
        let identity = remote.identity().clone();
        if identity.fingerprint.is_empty() {
            return Err(EditError::invalid(
                "the host key of this connection is unknown; connect again",
            ));
        }
        let root = self.root.clone();
        let slot = blocking(move || Slot::create(&root, &local_name)).await?;
        let id = slot.id.clone();
        let entry = Entry {
            slot: slot.clone(),
            host_id: host.to_owned(),
            remote_path: path.clone(),
            name: name.clone(),
            token: String::new(),
            target: None,
            synced_hash: String::new(),
            synced_size: 0,
            opened_at: disk::now_ms(),
            synced_at: None,
            uploaded_at: None,
            recovered_at: None,
            state: State::Opening,
            conflict: None,
            error: None,
            seen: false,
            queued: false,
            changes: Default::default(),
            synced_changes: 0,
            watch: None,
            upload: Default::default(),
            host_key: identity.fingerprint,
            endpoint: identity.endpoint,
            can_upload: true,
        };
        let duplicate = {
            let mut inner = self.lock();
            let dup = inner
                .files
                .values()
                .find(|e| e.host_id == host && e.remote_path == path)
                .map(|e| e.slot.id.clone());
            if dup.is_none() {
                inner.files.insert(id.clone(), entry);
            }
            dup
        };
        if let Some(other) = duplicate {
            let _ = slot.remove();
            return self.relaunch(&other, &opener).await;
        }
        self.deliver(Out {
            events: vec![EditEvent::Updated {
                file: self.view(&id)?,
            }],
            attention: false,
        });
        let max = if req.confirm_large {
            rules::MAX_BYTES
        } else {
            rules::CONFIRM_BYTES
        };
        let opened = async {
            let got = fetch(&slot, &remote, &path, max, false).await;
            let got = match got {
                Err(EditError::Fs(FsError::TooLarge(_))) if req.confirm_large => {
                    Err(EditError::TooLarge { name: name.clone() })
                }
                Err(EditError::Fs(FsError::TooLarge(_))) => Err(EditError::LargeFile {
                    name: name.clone(),
                    size,
                }),
                Err(EditError::Fs(FsError::InvalidInput(_))) => {
                    Err(EditError::NotRegular(path.clone()))
                }
                other => other,
            }?;
            if let Some(e) = self.lock().files.get_mut(&id) {
                e.synced_hash = version_hash(&got.version);
                e.token = got.version;
                e.target = got.target;
                e.synced_size = got.size;
                e.synced_at = Some(disk::now_ms());
            }
            let (s, m) = {
                let inner = self.lock();
                let e = inner.files.get(&id).ok_or(EditError::UnknownId)?;
                (e.slot.clone(), e.manifest())
            };
            blocking(move || s.write_manifest(&m)).await?;
            self.start_watch(&id)?;
            self.watch_host(host, &remote);
            self.launch(&id, &slot, &opener).await
        }
        .await;
        if let Err(e) = opened {
            let removed = self.lock().files.remove(&id);
            drop(removed);
            let _ = blocking(move || slot.remove()).await;
            self.deliver(Out {
                events: vec![EditEvent::Removed { id }],
                attention: false,
            });
            return Err(e);
        }
        let connected = self.host_live(host);
        self.update(&id, |e| {
            if e.state == State::Opening {
                e.state = state::unchanged(State::Synced, connected);
            }
        })
        .ok_or(EditError::UnknownId)
    }

    fn find(&self, host: &str, path: &str) -> Option<String> {
        self.lock()
            .files
            .values()
            .find(|e| e.host_id == host && e.remote_path == path)
            .map(|e| e.slot.id.clone())
    }

    fn upload_lock(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<()>>, EditError> {
        self.lock()
            .files
            .get(id)
            .map(|e| e.upload.clone())
            .ok_or(EditError::UnknownId)
    }

    /// Checks the copy as it is on disk (type, exec bit, content) and the app, then starts it,
    /// under the upload lock so "use server version" cannot swap the copy in between.
    async fn launch(&self, id: &str, slot: &Slot, opener: &Opener) -> Result<(), EditError> {
        let lock = self.upload_lock(id)?;
        let _held = lock.lock().await;
        let launcher = self.launcher.clone();
        let slot = slot.clone();
        let how = opener.clone();
        tokio::task::spawn_blocking(move || {
            slot.check().map_err(|_| EditError::Local)?;
            let file = slot.file();
            launch::check_type(&slot.name, Some(&file), &how)?;
            if let Opener::App(app) = &how {
                launch::check_app(app)?;
            }
            launcher.open(&file, &how)
        })
        .await
        .map_err(|_| EditError::AppFailed)?
    }

    fn fail(&self, id: &str, err: &EditError) {
        self.update(id, |e| {
            e.state = State::Failed;
            e.error = Some(ErrorView {
                code: err.code(),
                message: err.to_string(),
            });
        });
    }

    /// The copy was saved again while an upload read it: back to `before`, and a new save.
    fn requeue(self: &Arc<Self>, id: &str, before: State) -> Option<EditedFile> {
        let view = self.update(id, |e| e.state = before);
        let shared = self.clone();
        let key = id.to_owned();
        let quiet = self.quiet;
        tokio::spawn(async move {
            tokio::time::sleep(quiet).await;
            shared.saved(&key);
        });
        view
    }

    /// The live session reaches the server the file was opened from; otherwise the file is
    /// failed with `host_changed`, which no choice overrides.
    fn same_server(&self, id: &str, remote: &Remote) -> Result<(), EditError> {
        let now = remote.identity();
        let path = {
            let inner = self.lock();
            let e = inner.files.get(id).ok_or(EditError::UnknownId)?;
            if !now.fingerprint.is_empty()
                && e.host_key == now.fingerprint
                && e.endpoint == now.endpoint
            {
                return Ok(());
            }
            e.remote_path.clone()
        };
        let err = EditError::HostChanged(path);
        self.update(id, |e| {
            e.state = State::Failed;
            e.error = Some(ErrorView {
                code: err.code(),
                message: err.to_string(),
            });
        });
        Err(err)
    }

    /// Opens the existing copy again; a recovered copy is watched from now on.
    async fn relaunch(
        self: &Arc<Self>,
        id: &str,
        opener: &Opener,
    ) -> Result<EditedFile, EditError> {
        let (slot, watched, opening, can_upload, path) = {
            let inner = self.lock();
            let e = inner.files.get(id).ok_or(EditError::UnknownId)?;
            (
                e.slot.clone(),
                e.watch.is_some(),
                e.state == State::Opening,
                e.can_upload,
                e.remote_path.clone(),
            )
        };
        if opening {
            return self.view(id);
        }
        if !can_upload {
            return Err(EditError::HostGone(path));
        }
        if !watched {
            self.start_watch(id)?;
        }
        self.launch(id, &slot, opener).await?;
        let view = self.view(id)?;
        if !watched {
            self.deliver(Out {
                events: vec![EditEvent::Updated { file: view.clone() }],
                attention: false,
            });
        }
        Ok(view)
    }

    async fn upload(self: Arc<Self>, id: &str, trigger: Trigger) -> Result<EditedFile, EditError> {
        let lock = {
            let inner = self.lock();
            inner
                .files
                .get(id)
                .ok_or(EditError::UnknownId)?
                .upload
                .clone()
        };
        let _held = lock.lock().await;
        let (slot, host, path, token, target, synced, before, count) = {
            let mut inner = self.lock();
            let e = inner.files.get_mut(id).ok_or(EditError::UnknownId)?;
            if trigger == Trigger::Save {
                e.queued = false;
            }
            if !e.can_upload {
                return Err(EditError::HostGone(e.remote_path.clone()));
            }
            if trigger == Trigger::Force && e.state != State::Conflict {
                return Err(EditError::NoConflict(e.remote_path.clone()));
            }
            if !state::may_upload(e.state, trigger) {
                return Ok(e.view());
            }
            e.seen = false;
            (
                e.slot.clone(),
                e.host_id.clone(),
                e.remote_path.clone(),
                e.token.clone(),
                e.target.clone(),
                e.synced_hash.clone(),
                e.state,
                e.changes.load(Ordering::SeqCst),
            )
        };
        let s = slot.clone();
        let local = match blocking(move || s.local_state()).await {
            Ok(l) => l,
            Err(e) => {
                self.update(id, |x| {
                    x.state = State::Failed;
                    x.error = Some(ErrorView {
                        code: e.code(),
                        message: e.to_string(),
                    });
                });
                return Err(e);
            }
        };
        let explicit = matches!(trigger, Trigger::Explicit | Trigger::Force);
        if local.size > rules::MAX_BYTES {
            let err = EditError::TooLarge {
                name: sftp::file_name(&path).to_owned(),
            };
            self.update(id, |e| {
                e.state = State::Failed;
                e.error = Some(ErrorView {
                    code: err.code(),
                    message: err.to_string(),
                });
            });
            return Err(err);
        }
        if local.hash == synced && trigger != Trigger::Force && before != State::Conflict {
            let connected = self.host_live(&host);
            return self
                .update(id, |e| {
                    e.state = state::unchanged(e.state, connected);
                    e.error = None;
                    e.synced_changes = count;
                })
                .ok_or(EditError::UnknownId);
        }
        let remote = match self.conns.remote(&host).await {
            Ok(r) => r,
            Err(err) => {
                let view = self.update(id, |e| e.state = state::unreachable(e.state));
                return if explicit {
                    Err(err.into())
                } else {
                    view.ok_or(EditError::UnknownId)
                };
            }
        };
        self.watch_host(&host, &remote);
        self.same_server(id, &remote)?;
        self.update(id, |e| e.state = State::Uploading);
        let s = slot.clone();
        let mut snapshot = match blocking(move || s.snapshot(rules::MAX_BYTES)).await {
            Ok(disk::Snap::Ready(snapshot)) => snapshot,
            Ok(disk::Snap::Changed) => return self.requeue(id, before).ok_or(EditError::UnknownId),
            Ok(disk::Snap::TooLarge) => {
                let err = EditError::TooLarge {
                    name: sftp::file_name(&path).to_owned(),
                };
                self.fail(id, &err);
                return Err(err);
            }
            Err(e) => {
                self.fail(id, &e);
                return Err(e);
            }
        };
        let file = snapshot.take_file().ok_or(EditError::Local)?;
        let mut file = tokio::fs::File::from_std(file);
        let mut body = Body::file(&mut file, rules::MAX_BYTES, Box::new(|| true));
        let expected = (trigger != Trigger::Force).then_some(token.as_str());
        let saved = remote
            .write_body(&path, expected, target.as_deref(), &mut body)
            .await;
        drop(body);
        drop(file);
        drop(snapshot);
        let view = match saved {
            Ok(saved) => {
                let now = disk::now_ms();
                let view = self.update(id, |e| {
                    e.synced_hash = version_hash(&saved.version);
                    e.synced_changes = count;
                    e.token = saved.version;
                    e.synced_size = saved.size;
                    e.synced_at = Some(now);
                    e.uploaded_at = Some(now);
                    e.state = State::Synced;
                    e.conflict = None;
                    e.error = None;
                    e.recovered_at = None;
                });
                let shared = self.clone();
                let key = id.to_owned();
                let _ = tokio::task::spawn_blocking(move || shared.save_manifest(&key)).await;
                view
            }
            Err(FsError::SourceChanged) => self.requeue(id, before),
            Err(err) => {
                let connected = remote.ended().borrow().is_none();
                self.update(id, |e| match state::failure(&err, connected) {
                    Failure::Conflict(kind) => {
                        e.state = State::Conflict;
                        e.conflict = Some(kind);
                    }
                    Failure::Waiting => e.state = state::unreachable(before),
                    Failure::Failed => {
                        e.state = State::Failed;
                        e.error = Some(ErrorView {
                            code: err.code(),
                            message: err.to_string(),
                        });
                    }
                })
            }
        };
        view.ok_or(EditError::UnknownId)
    }

    async fn use_server(
        self: Arc<Self>,
        id: &str,
        confirm_large: bool,
    ) -> Result<EditedFile, EditError> {
        let lock = {
            let inner = self.lock();
            inner
                .files
                .get(id)
                .ok_or(EditError::UnknownId)?
                .upload
                .clone()
        };
        let _held = lock.lock().await;
        let (slot, host, path) = {
            let inner = self.lock();
            let e = inner.files.get(id).ok_or(EditError::UnknownId)?;
            if !e.can_upload {
                return Err(EditError::HostGone(e.remote_path.clone()));
            }
            if e.state != State::Conflict {
                return Err(EditError::NoConflict(e.remote_path.clone()));
            }
            (e.slot.clone(), e.host_id.clone(), e.remote_path.clone())
        };
        let remote = self.conns.remote(&host).await?;
        self.watch_host(&host, &remote);
        self.same_server(id, &remote)?;
        let name = sftp::file_name(&path).to_owned();
        let size = match remote.edit_size(&path).await {
            Ok((s, _)) => s.unwrap_or(0),
            Err(FsError::InvalidInput(_)) => return Err(EditError::NotRegular(path)),
            Err(e) => return Err(e.into()),
        };
        size_gate(size, confirm_large, &name)?;
        let max = if confirm_large {
            rules::MAX_BYTES
        } else {
            rules::CONFIRM_BYTES
        };
        let got = match fetch(&slot, &remote, &path, max, true).await {
            Err(EditError::Fs(FsError::TooLarge(_))) if confirm_large => {
                return Err(EditError::TooLarge { name });
            }
            Err(EditError::Fs(FsError::TooLarge(_))) => {
                return Err(EditError::LargeFile { name, size });
            }
            other => other?,
        };
        let now = disk::now_ms();
        let view = self.update(id, |e| {
            e.synced_hash = version_hash(&got.version);
            e.synced_changes = e.changes.load(Ordering::SeqCst);
            e.token = got.version;
            e.target = got.target;
            e.synced_size = got.size;
            e.synced_at = Some(now);
            e.state = State::Synced;
            e.conflict = None;
            e.error = None;
            e.recovered_at = None;
            e.seen = false;
        });
        let shared = self.clone();
        let key = id.to_owned();
        let _ = tokio::task::spawn_blocking(move || shared.save_manifest(&key)).await;
        // The new content may be a program the next launch must refuse.
        let opener = (self.settings)();
        let checked = slot.clone();
        let blocked = tokio::task::spawn_blocking(move || {
            launch::check_type(&checked.name, Some(&checked.file()), &opener)
        })
        .await
        .map_err(|_| EditError::Local)?;
        if let Err(e) = blocked {
            self.fail(id, &e);
            return Err(e);
        }
        view.ok_or(EditError::UnknownId)
    }

    async fn stop(
        self: &Arc<Self>,
        id: &str,
        force: bool,
        recovered_only: bool,
    ) -> Result<(), EditError> {
        let lock = self
            .lock()
            .files
            .get(id)
            .ok_or(EditError::UnknownId)?
            .upload
            .clone();
        // Uploads and "use server version" write the copy under this lock.
        let _held = lock.lock().await;
        let (slot, state, synced, path, changes, synced_changes, seen) = {
            let inner = self.lock();
            let e = inner.files.get(id).ok_or(EditError::UnknownId)?;
            (
                e.slot.clone(),
                e.state,
                e.synced_hash.clone(),
                e.remote_path.clone(),
                e.changes.clone(),
                e.synced_changes,
                e.seen,
            )
        };
        if recovered_only && state != State::Recovered {
            return Err(EditError::invalid("only a recovered file can be discarded"));
        }
        if force {
            let removed = self.lock().files.remove(id);
            drop(removed);
            if blocking(move || slot.remove()).await.is_err() {
                log::warn!("could not delete the copy of an edited file");
            }
        } else {
            if state.not_uploaded() {
                return Err(EditError::NotUploaded(path));
            }
            // A missing copy is unchanged only if nothing was seen since it last matched the
            // server: an editor that saves by delete then rename may be halfway.
            let missing_ok = move || !seen && changes.load(Ordering::SeqCst) == synced_changes;
            let judged = blocking(move || slot.remove_if_synced(&synced, missing_ok)).await?;
            match judged {
                disk::Judged::Removed => {
                    let removed = self.lock().files.remove(id);
                    drop(removed);
                }
                disk::Judged::Kept => return Err(EditError::NotUploaded(path)),
                disk::Judged::Recreated => {
                    self.saved(id);
                    return Err(EditError::NotUploaded(path));
                }
            }
        }
        self.deliver(Out {
            events: vec![EditEvent::Removed { id: id.to_owned() }],
            attention: false,
        });
        Ok(())
    }
}

/// Downloads `path` into a temp in the slot, then moves it into place.
async fn fetch(
    slot: &Slot,
    remote: &Remote,
    path: &str,
    max: u64,
    replace: bool,
) -> Result<sftp::Downloaded, EditError> {
    let s = slot.clone();
    let (temp, file) = blocking(move || s.create_temp()).await?;
    let mut out = tokio::fs::File::from_std(file);
    let got = remote.download(path, max, &mut out).await;
    let synced = out.sync_all().await;
    drop(out);
    let placed = match (got, synced) {
        (Ok(got), Ok(())) => {
            let s = slot.clone();
            let t = temp.clone();
            blocking(move || {
                disk::mark_downloaded(&t);
                s.place(&t, replace)
            })
            .await
            .map(|()| got)
        }
        (Err(e), _) => Err(e.into()),
        (_, Err(_)) => Err(EditError::Local),
    };
    if placed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    placed
}

#[cfg(test)]
mod tests;
