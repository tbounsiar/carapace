use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::{oneshot, watch};
use uuid::Uuid;

use super::job;
use super::side::Meta;
use super::types::{
    ConflictPolicy, Decision, Direction, EnqueueRequest, TransferError, TransferEvent,
    TransferState, TransferView,
};
use crate::files::{self, FsError};
use crate::localfs;
use crate::sftp::{self, Remote};
use crate::ssh::SessionEnd;

pub const MAX_RUNNING: usize = 3;
/// Jobs not finished yet (queued, running or waiting for a decision).
pub const MAX_PENDING: usize = 1000;
/// Finished jobs kept for display; the oldest go first.
pub const MAX_FINISHED: usize = 1000;
pub const MAX_SOURCES: usize = 500;
pub const MAX_FILES: usize = 100_000;
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Delivers an event; `false` means the receiver is gone and the subscription is dropped.
/// Called with the queue locked, so it must not call back into the manager.
pub type Emit = Arc<dyn Fn(TransferEvent) -> bool + Send + Sync>;

pub type RemoteFuture<'a> = Pin<Box<dyn Future<Output = Result<Arc<Remote>, FsError>> + Send + 'a>>;

/// Hands out the shared SFTP channel of a live connection (`NotConnected` otherwise).
pub trait Connections: Send + Sync + 'static {
    fn remote<'a>(&'a self, connection_id: &'a str) -> RemoteFuture<'a>;
}

pub struct TransferManager {
    inner: Arc<Inner>,
}

pub(super) struct Inner {
    pub(super) conns: Arc<dyn Connections>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    jobs: Vec<Job>,
    emit: Option<Emit>,
    running: usize,
    queued: VecDeque<String>,
    /// Jobs coming back from a conflict decision; served before new ones.
    resuming: VecDeque<String>,
    /// Temporary files being written, with the job writing each, so two jobs never share one.
    temps: HashMap<String, String>,
}

struct Job {
    view: TransferView,
    cancel: watch::Sender<bool>,
    go: Option<oneshot::Sender<()>>,
    answer: Option<oneshot::Sender<Answer>>,
    conflict: Option<TransferEvent>,
    /// Id of the latest conflict, which an answer must name.
    conflict_seq: u64,
    holds_slot: bool,
    last_emit: Option<Instant>,
}

#[derive(Debug, Clone, Copy)]
pub struct Answer {
    pub decision: Decision,
    pub apply_to_all: bool,
}

/// Why a job stopped before completing.
#[derive(Debug)]
pub enum Stop {
    Cancelled,
    Failed(FsError),
}

impl From<FsError> for Stop {
    fn from(e: FsError) -> Self {
        Self::Failed(e)
    }
}

pub struct Spec {
    pub connection_id: String,
    pub direction: Direction,
    pub source: String,
    pub target_dir: String,
    pub name: String,
    pub conflict: ConflictPolicy,
}

pub fn progress_due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|t| now.duration_since(t) >= PROGRESS_INTERVAL)
}

fn lock(inner: &Inner) -> MutexGuard<'_, State> {
    // Critical sections only update in-memory bookkeeping and cannot leave it half-done.
    inner.state.lock().unwrap_or_else(|e| e.into_inner())
}

impl State {
    fn job(&mut self, id: &str) -> Option<&mut Job> {
        self.jobs.iter_mut().find(|j| j.view.id == id)
    }

    fn emit(&mut self, event: TransferEvent) {
        if let Some(emit) = &self.emit
            && !emit(event)
        {
            self.emit = None;
        }
    }

    fn emit_job(&mut self, id: &str) {
        let Some(job) = self.job(id) else { return };
        job.last_emit = Some(Instant::now());
        let transfer = job.view.clone();
        self.emit(TransferEvent::Updated { transfer });
    }

    fn pump(&mut self) {
        while self.running < MAX_RUNNING {
            let Some(id) = self
                .resuming
                .pop_front()
                .or_else(|| self.queued.pop_front())
            else {
                return;
            };
            let Some(job) = self.job(&id) else { continue };
            let Some(go) = job.go.take() else { continue };
            if go.send(()).is_err() {
                continue;
            }
            job.holds_slot = true;
            job.view.state = TransferState::Running;
            self.running += 1;
            self.emit_job(&id);
        }
    }

    fn release(&mut self, id: &str) {
        if let Some(job) = self.job(id)
            && std::mem::take(&mut job.holds_slot)
        {
            self.running -= 1;
        }
    }

    fn evict(&mut self) {
        let finished = self.jobs.iter().filter(|j| j.view.state.finished()).count();
        if finished <= MAX_FINISHED {
            return;
        }
        let mut excess = finished - MAX_FINISHED;
        let mut removed = Vec::new();
        self.jobs.retain(|j| {
            if excess > 0 && j.view.state.finished() {
                excess -= 1;
                removed.push(j.view.id.clone());
                return false;
            }
            true
        });
        self.emit(TransferEvent::Removed { job_ids: removed });
    }
}

/// A running job's handle on the queue: progress, conflict prompts, and stop signals.
pub struct Ctl {
    pub id: String,
    inner: Arc<Inner>,
    cancel: watch::Receiver<bool>,
    ended: watch::Receiver<Option<SessionEnd>>,
}

impl Ctl {
    /// Runs `fut` unless the job is cancelled or its connection ends first.
    pub async fn check<F: Future>(&self, fut: F) -> Result<F::Output, Stop> {
        let mut cancel = self.cancel.clone();
        let mut ended = self.ended.clone();
        tokio::select! {
            biased;
            _ = cancel.wait_for(|c| *c) => Err(Stop::Cancelled),
            // An error means the sender is gone, which also means the connection is.
            _ = ended.wait_for(|e| e.is_some()) => Err(Stop::Failed(FsError::NotConnected)),
            v = fut => Ok(v),
        }
    }

    /// The stop a `check` would report now, for code that awaits without `check` because
    /// dropping its future would leave something behind.
    pub fn stopped(&self) -> Result<(), Stop> {
        if *self.cancel.borrow() {
            return Err(Stop::Cancelled);
        }
        if self.ended.borrow().is_some() || self.ended.has_changed().is_err() {
            return Err(Stop::Failed(FsError::NotConnected));
        }
        Ok(())
    }

    pub fn conns(&self) -> &Arc<dyn Connections> {
        &self.inner.conns
    }

    /// Applies `f` to the job's view and emits it, at most every `PROGRESS_INTERVAL`.
    pub fn progress(&self, f: impl FnOnce(&mut TransferView)) {
        let mut st = lock(&self.inner);
        let Some(job) = st.job(&self.id) else { return };
        f(&mut job.view);
        if progress_due(job.last_emit, Instant::now()) {
            st.emit_job(&self.id);
        }
    }

    /// Claims a temporary file name; `false` if another job writes it.
    pub fn claim_temp(&self, key: String) -> bool {
        let mut st = lock(&self.inner);
        if st.temps.contains_key(&key) {
            return false;
        }
        st.temps.insert(key, self.id.clone());
        true
    }

    pub fn release_temp(&self, key: &str) {
        lock(&self.inner).temps.remove(key);
    }

    pub fn temp_claimed(&self, key: &str) -> bool {
        lock(&self.inner).temps.contains_key(key)
    }

    /// Pauses the job until the user decides, giving its slot to the queue meanwhile.
    pub async fn ask(&self, path: &str, existing: &Meta, incoming: &Meta) -> Result<Answer, Stop> {
        let (tx, rx) = oneshot::channel();
        {
            let mut st = lock(&self.inner);
            st.release(&self.id);
            let Some(job) = st.job(&self.id) else {
                return Err(Stop::Cancelled);
            };
            job.conflict_seq += 1;
            let event = TransferEvent::Conflict {
                job_id: self.id.clone(),
                conflict_id: job.conflict_seq,
                path: path.to_owned(),
                existing_size: existing.size,
                existing_modified: existing.modified,
                incoming_size: incoming.size,
                incoming_modified: incoming.modified,
            };
            job.view.state = TransferState::WaitingConflict;
            job.answer = Some(tx);
            job.conflict = Some(event.clone());
            st.emit_job(&self.id);
            st.emit(event);
            st.pump();
        }
        let answer = self.check(rx).await?.map_err(|_| Stop::Cancelled)?;
        let (go_tx, go_rx) = oneshot::channel();
        {
            let mut st = lock(&self.inner);
            if let Some(job) = st.job(&self.id) {
                job.go = Some(go_tx);
            }
            st.resuming.push_back(self.id.clone());
            st.pump();
        }
        self.check(go_rx).await?.map_err(|_| Stop::Cancelled)?;
        Ok(answer)
    }
}

impl TransferManager {
    pub fn new(conns: Arc<dyn Connections>) -> Self {
        Self {
            inner: Arc::new(Inner {
                conns,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Replaces the subscription (a reloaded page subscribes again) and returns every job.
    /// Pending conflicts are sent again so the new page can answer them.
    pub fn subscribe(&self, emit: Emit) -> Vec<TransferView> {
        let mut st = lock(&self.inner);
        st.emit = Some(emit);
        let views = st.jobs.iter().map(|j| j.view.clone()).collect();
        let pending: Vec<TransferEvent> =
            st.jobs.iter().filter_map(|j| j.conflict.clone()).collect();
        for event in pending {
            st.emit(event);
        }
        views
    }

    pub fn unsubscribe(&self) {
        lock(&self.inner).emit = None;
    }

    #[cfg(test)]
    pub fn list(&self) -> Vec<TransferView> {
        lock(&self.inner)
            .jobs
            .iter()
            .map(|j| j.view.clone())
            .collect()
    }

    pub async fn enqueue(&self, req: EnqueueRequest) -> Result<Vec<String>, FsError> {
        if req.connection_id.trim().is_empty() {
            return Err(FsError::invalid("connectionId is required"));
        }
        if req.sources.is_empty() || req.sources.len() > MAX_SOURCES {
            return Err(FsError::invalid(format!(
                "a transfer takes 1 to {MAX_SOURCES} sources"
            )));
        }
        let mut sources = Vec::with_capacity(req.sources.len());
        for raw in &req.sources {
            sources.push(source(req.direction, raw)?);
        }
        let local_target = match req.direction {
            Direction::Download => Some(local_dir(&req.target_dir)?),
            Direction::Upload => {
                sftp::normalize(&req.target_dir)?;
                None
            }
        };
        let remote = self.inner.conns.remote(&req.connection_id).await?;
        let ended = remote.ended();
        if ended.borrow().is_some() {
            return Err(FsError::NotConnected);
        }
        let target_dir = match local_target {
            Some(t) => t,
            None => remote.absolute(&req.target_dir)?,
        };
        drop(remote);

        let mut st = lock(&self.inner);
        let pending = st.jobs.iter().filter(|j| !j.view.state.finished()).count();
        if pending + sources.len() > MAX_PENDING {
            return Err(FsError::TooLarge("the transfer queue".into()));
        }
        let mut ids = Vec::with_capacity(sources.len());
        for (path, name) in sources {
            let id = Uuid::new_v4().to_string();
            let (cancel, cancel_rx) = watch::channel(false);
            let (go, go_rx) = oneshot::channel();
            let view = TransferView {
                id: id.clone(),
                connection_id: req.connection_id.clone(),
                direction: req.direction,
                source: path.clone(),
                target_dir: target_dir.clone(),
                name: name.clone(),
                state: TransferState::Queued,
                total_bytes: None,
                done_bytes: 0,
                total_files: None,
                done_files: 0,
                skipped: 0,
                error: None,
            };
            st.jobs.push(Job {
                view,
                cancel,
                go: Some(go),
                answer: None,
                conflict: None,
                conflict_seq: 0,
                holds_slot: false,
                last_emit: None,
            });
            st.queued.push_back(id.clone());
            st.emit_job(&id);
            let ctl = Ctl {
                id: id.clone(),
                inner: self.inner.clone(),
                cancel: cancel_rx,
                ended: ended.clone(),
            };
            let spec = Spec {
                connection_id: req.connection_id.clone(),
                direction: req.direction,
                source: path,
                target_dir: target_dir.clone(),
                name,
                conflict: req.conflict,
            };
            tokio::spawn(run_job(ctl, spec, go_rx));
            ids.push(id);
        }
        st.pump();
        Ok(ids)
    }

    /// Unknown ids are `not_found`; cancelling a finished job does nothing.
    pub fn cancel(&self, id: &str) -> Result<(), FsError> {
        let st = lock(&self.inner);
        let job = st
            .jobs
            .iter()
            .find(|j| j.view.id == id)
            .ok_or_else(|| FsError::NotFound("the transfer".into()))?;
        if !job.view.state.finished() {
            job.cancel.send_replace(true);
        }
        Ok(())
    }

    /// `conflict_id` must name the conflict the job is waiting on, so a late answer to an
    /// earlier prompt never decides a later one.
    pub fn answer(
        &self,
        id: &str,
        conflict_id: u64,
        decision: Decision,
        apply_to_all: bool,
    ) -> Result<(), FsError> {
        let mut st = lock(&self.inner);
        let job = st
            .job(id)
            .ok_or_else(|| FsError::NotFound("the transfer".into()))?;
        let Some(tx) = job.answer.take_if(|_| job.conflict_seq == conflict_id) else {
            return Err(FsError::invalid(
                "the transfer is not waiting for this decision",
            ));
        };
        job.conflict = None;
        job.view.state = TransferState::Queued;
        let _ = tx.send(Answer {
            decision,
            apply_to_all,
        });
        st.emit_job(id);
        Ok(())
    }

    pub fn clear_finished(&self) {
        let mut st = lock(&self.inner);
        let mut removed = Vec::new();
        st.jobs.retain(|j| {
            let finished = j.view.state.finished();
            if finished {
                removed.push(j.view.id.clone());
            }
            !finished
        });
        if !removed.is_empty() {
            st.emit(TransferEvent::Removed { job_ids: removed });
        }
    }
}

/// Checked source path and its name, which becomes the name at the destination.
fn source(direction: Direction, raw: &str) -> Result<(String, String), FsError> {
    match direction {
        Direction::Upload => {
            let path =
                localfs::resolve(raw)?.ok_or_else(|| FsError::invalid("source is required"))?;
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| FsError::invalid("cannot transfer a root"))?
                .to_owned();
            files::name(&name)?;
            Ok((localfs::display(&path)?, name))
        }
        Direction::Download => {
            let path =
                sftp::normalize(raw)?.ok_or_else(|| FsError::invalid("source is required"))?;
            if path == "/" {
                return Err(FsError::invalid("cannot transfer /"));
            }
            let name = sftp::file_name(&path).to_owned();
            localfs::name(&name)?;
            Ok((path, name))
        }
    }
}

fn local_dir(raw: &str) -> Result<String, FsError> {
    let path = localfs::resolve(raw)?.ok_or_else(|| FsError::invalid("targetDir is required"))?;
    localfs::display(&path)
}

async fn run_job(ctl: Ctl, spec: Spec, go: oneshot::Receiver<()>) {
    let (inner, id) = (ctl.inner.clone(), ctl.id.clone());
    let body = tokio::spawn(async move {
        match ctl.check(go).await {
            Ok(Ok(())) => job::run(&ctl, &spec).await,
            Ok(Err(_)) => Err(Stop::Cancelled),
            Err(stop) => Err(stop),
        }
    });
    // Run separately so a panic in the job still frees its slot and temp names below.
    let result = body
        .await
        .unwrap_or_else(|_| Err(Stop::Failed(FsError::Io("the transfer".into()))));
    let mut st = lock(&inner);
    st.release(&id);
    st.queued.retain(|i| *i != id);
    st.resuming.retain(|i| *i != id);
    st.temps.retain(|_, owner| *owner != id);
    if let Some(job) = st.job(&id) {
        job.go = None;
        job.answer = None;
        job.conflict = None;
        match result {
            Ok(()) => job.view.state = TransferState::Done,
            Err(Stop::Cancelled) => job.view.state = TransferState::Cancelled,
            Err(Stop::Failed(e)) => {
                job.view.state = TransferState::Failed;
                job.view.error = Some(TransferError::from(&e));
            }
        }
    }
    st.emit_job(&id);
    st.pump();
    st.evict();
}

#[cfg(test)]
pub(super) fn running_count(m: &TransferManager) -> usize {
    lock(&m.inner).running
}
