use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::manager::{Ctl, MAX_FILES, Spec, Stop};
use super::names::{is_temp, numbered, temp_name};
use super::side::{
    Meta, Side, blocking, create_local_temp, dir_mode, file_mode, local_path, open_source,
    set_local_mode,
};
use super::types::{ConflictPolicy, Decision, Direction};
use crate::files::{EntryKind, FsError, MAX_DEPTH, MAX_PATH_BYTES};
use crate::localfs;
use crate::sftp::Remote;

/// Bytes per SFTP request.
pub const CHUNK: usize = 64 * 1024;
/// Requests kept in flight per file, so one job holds at most `CHUNK * (IN_FLIGHT + 1)` bytes.
pub const IN_FLIGHT: usize = 4;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const PLACE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RENAMES: u32 = 1000;
const MAX_ATTEMPTS: usize = 8;
/// Temp names tried per file (`.{name}.carapace-part`, `.{name}.1.carapace-part`...).
const MAX_TEMPS: u32 = 16;
/// Total bytes of paths a scan may hold, against a server listing huge trees of long names.
pub const MAX_PATH_TOTAL: usize = 64 * 1024 * 1024;
/// How far a download may read past the size the server reported (a file still growing).
pub const GROWTH_MARGIN: u64 = 64 * 1024 * 1024;

struct Item {
    parent: Option<usize>,
    name: String,
    src: String,
    /// Length of the destination path without renames.
    dest_len: usize,
    meta: Meta,
}

struct Plan {
    items: Vec<Item>,
    files: u64,
    bytes: u64,
    skipped: u64,
}

pub async fn run(ctl: &Ctl, spec: &Spec) -> Result<(), Stop> {
    let remote = ctl.check(ctl.conns().remote(&spec.connection_id)).await??;
    let remote_side = Side::Remote(remote.clone());
    let (src, dst) = match spec.direction {
        Direction::Upload => (Side::Local, remote_side),
        Direction::Download => (remote_side, Side::Local),
    };
    match ctl.check(dst.stat_dest(&spec.target_dir)).await?? {
        Some(m) if m.kind == EntryKind::Dir => {}
        Some(_) => {
            return Err(FsError::invalid(format!("{} is not a directory", spec.target_dir)).into());
        }
        None => return Err(FsError::NotFound(spec.target_dir.clone()).into()),
    }
    let plan = scan(ctl, &src, &dst, spec).await?;
    ctl.progress(|v| {
        v.total_files = Some(plan.files);
        v.total_bytes = Some(plan.bytes);
        v.skipped = plan.skipped;
    });
    let mut runner = Runner {
        ctl,
        dst,
        remote,
        direction: spec.direction,
        policy: spec.conflict,
        target: spec.target_dir.clone(),
    };
    runner.transfer(&plan).await
}

async fn scan(ctl: &Ctl, src: &Side, dst: &Side, spec: &Spec) -> Result<Plan, Stop> {
    let mut plan = Plan {
        items: Vec::new(),
        files: 0,
        bytes: 0,
        skipped: 0,
    };
    let root = ctl
        .check(src.stat_source(&spec.source))
        .await??
        .ok_or_else(|| FsError::NotFound(spec.source.clone()))?;
    match root.kind {
        EntryKind::File => {
            plan.files = 1;
            plan.bytes = root.size.unwrap_or(0);
        }
        EntryKind::Dir => {}
        _ => {
            plan.skipped = 1;
            return Ok(plan);
        }
    }
    plan.items.push(Item {
        parent: None,
        name: spec.name.clone(),
        src: spec.source.clone(),
        dest_len: spec.target_dir.len() + 1 + spec.name.len(),
        meta: root,
    });
    let mut path_bytes = spec.source.len();
    let mut stack = if root.kind == EntryKind::Dir {
        vec![(0usize, 0usize)]
    } else {
        Vec::new()
    };
    while let Some((idx, depth)) = stack.pop() {
        if depth >= MAX_DEPTH {
            return Err(FsError::TooLarge(plan.items[idx].src.clone()).into());
        }
        let dir = ctl
            .check(src.enter(&plan.items[idx].src, idx == 0))
            .await??;
        let (mut children, dropped) = ctl.check(src.children(&dir)).await??;
        plan.skipped = plan.skipped.saturating_add(dropped);
        children.sort_by(|a, b| a.name.cmp(&b.name));
        plan.items[idx].src = dir.clone();
        let parent_len = plan.items[idx].dest_len;
        for child in children {
            let Some(name) = child.name else {
                plan.skipped += 1;
                continue;
            };
            let wanted = matches!(child.meta.kind, EntryKind::File | EntryKind::Dir);
            if !wanted || is_temp(&name) || !dst.valid_name(&name) {
                plan.skipped += 1;
                continue;
            }
            let path = src.join(&dir, &name);
            let dest_len = parent_len + 1 + name.len();
            if path.len() > MAX_PATH_BYTES || dest_len > MAX_PATH_BYTES {
                plan.skipped += 1;
                continue;
            }
            path_bytes = path_bytes.saturating_add(path.len() + name.len());
            if plan.items.len() > MAX_FILES * 2 || path_bytes > MAX_PATH_TOTAL {
                return Err(FsError::TooLarge(spec.source.clone()).into());
            }
            if child.meta.kind == EntryKind::File {
                plan.files += 1;
                plan.bytes = plan.bytes.saturating_add(child.meta.size.unwrap_or(0));
                if plan.files > MAX_FILES as u64 {
                    return Err(FsError::TooLarge(spec.source.clone()).into());
                }
            }
            plan.items.push(Item {
                parent: Some(idx),
                src: path,
                name,
                dest_len,
                meta: child.meta,
            });
            if child.meta.kind == EntryKind::Dir {
                stack.push((plan.items.len() - 1, depth + 1));
            }
        }
    }
    Ok(plan)
}

/// Aborts the task when dropped, so a stopped job leaves no request behind.
struct Task<T>(JoinHandle<T>);

impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl<T> Future for Task<T> {
    type Output = Result<T, FsError>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0)
            .poll(cx)
            .map(|r| r.map_err(|_| FsError::Network))
    }
}

type ReadResult = Result<Option<Vec<u8>>, FsError>;

enum Placed {
    Done,
    Skipped,
}

struct Runner<'a> {
    ctl: &'a Ctl,
    dst: Side,
    remote: Arc<Remote>,
    direction: Direction,
    policy: ConflictPolicy,
    /// The job's target directory, below which local files are created only in real
    /// directories.
    target: String,
}

impl Runner<'_> {
    async fn transfer(&mut self, plan: &Plan) -> Result<(), Stop> {
        let mut dests: Vec<Option<String>> = Vec::with_capacity(plan.items.len());
        for item in &plan.items {
            let parent = match item.parent {
                None => Some(self.target.clone()),
                Some(p) => dests[p].clone(),
            };
            let Some(parent) = parent else {
                if item.meta.kind == EntryKind::File {
                    self.skip_file(&item.meta);
                }
                dests.push(None);
                continue;
            };
            if item.meta.kind == EntryKind::Dir {
                let dest = self.place_dir(&parent, item).await?;
                dests.push(dest);
            } else {
                self.file(&parent, item).await?;
                dests.push(None);
            }
        }
        Ok(())
    }

    fn skip_file(&self, meta: &Meta) {
        let size = meta.size.unwrap_or(0);
        self.ctl.progress(|v| {
            v.skipped += 1;
            v.total_files = v.total_files.map(|t| t.saturating_sub(1));
            v.total_bytes = v.total_bytes.map(|t| t.saturating_sub(size));
        });
    }

    async fn decide(
        &mut self,
        dest: &str,
        existing: &Meta,
        incoming: &Meta,
    ) -> Result<Decision, Stop> {
        Ok(match self.policy {
            ConflictPolicy::Overwrite => Decision::Overwrite,
            ConflictPolicy::Skip => Decision::Skip,
            ConflictPolicy::Rename => Decision::Rename,
            ConflictPolicy::Ask => {
                let answer = self.ctl.ask(dest, existing, incoming).await?;
                if answer.apply_to_all {
                    self.policy = answer.decision.into();
                }
                answer.decision
            }
        })
    }

    fn temp_key(&self, temp: &str) -> String {
        // Not keyed by connection: two connections may reach the same server path.
        match self.dst {
            Side::Local => format!("local:{temp}"),
            Side::Remote(_) => format!("remote:{temp}"),
        }
    }

    /// The first free `name (n)` in `parent`.
    async fn free_name(
        &self,
        parent: &str,
        name: &str,
        is_dir: bool,
    ) -> Result<(String, String), Stop> {
        for n in 1..=MAX_RENAMES {
            let candidate = numbered(name, n, is_dir);
            if !self.dst.valid_name(&candidate) {
                return Err(FsError::invalid(format!("no free name for {name}")).into());
            }
            let path = self.dst.join(parent, &candidate);
            let busy = match temp_name(&candidate, 0) {
                Ok(t) => self
                    .ctl
                    .temp_claimed(&self.temp_key(&self.dst.join(parent, &t))),
                Err(_) => false,
            };
            if !busy && self.ctl.check(self.dst.stat_dest(&path)).await??.is_none() {
                return Ok((path, candidate));
            }
        }
        Err(FsError::AlreadyExists(self.dst.join(parent, name)).into())
    }

    /// Destination of a directory, `None` when it is skipped with its content. Existing
    /// directories are merged.
    async fn place_dir(&mut self, parent: &str, item: &Item) -> Result<Option<String>, Stop> {
        let mut dest = self.dst.join(parent, &item.name);
        let mode = dir_mode(item.meta.mode);
        for _ in 0..MAX_ATTEMPTS {
            match self.ctl.check(self.dst.stat_dest(&dest)).await?? {
                Some(m) if m.kind == EntryKind::Dir => return Ok(Some(dest)),
                None => match self
                    .ctl
                    .check(self.dst.mkdir(&dest, mode, &self.target))
                    .await?
                {
                    Ok(()) => return Ok(Some(dest)),
                    Err(FsError::AlreadyExists(_)) => {}
                    Err(e) => return Err(e.into()),
                },
                Some(existing) => match self.decide(&dest, &existing, &item.meta).await? {
                    Decision::Overwrite => self.ctl.check(self.dst.remove(&dest)).await??,
                    Decision::Skip => return Ok(None),
                    Decision::Rename => dest = self.free_name(parent, &item.name, true).await?.0,
                },
            }
        }
        Err(FsError::Io(dest).into())
    }

    async fn file(&mut self, parent: &str, item: &Item) -> Result<(), Stop> {
        let mut dest = self.dst.join(parent, &item.name);
        let mut name = item.name.clone();
        let mut replaced = None;
        if let Some(existing) = self.ctl.check(self.dst.stat_dest(&dest)).await?? {
            match self.decide(&dest, &existing, &item.meta).await? {
                Decision::Overwrite if existing.kind == EntryKind::Dir => {
                    return Err(FsError::AlreadyExists(dest).into());
                }
                Decision::Overwrite => replaced = Some(existing),
                Decision::Skip => {
                    self.skip_file(&item.meta);
                    return Ok(());
                }
                Decision::Rename => {
                    (dest, name) = self.free_name(parent, &item.name, false).await?
                }
            }
        }
        let mode = file_mode(replaced.as_ref(), item.meta.mode);
        // A temp that exists without our claim belongs to an interrupted run or to another
        // instance still writing it: it is left alone and the next name is tried.
        for n in 0..MAX_TEMPS {
            let temp = self.dst.join(parent, &temp_name(&name, n)?);
            let key = self.temp_key(&temp);
            if !self.ctl.claim_temp(key.clone()) {
                continue;
            }
            let mut created = false;
            let result = self
                .write_and_place(
                    item,
                    parent,
                    &temp,
                    dest.clone(),
                    replaced.is_some(),
                    mode,
                    &mut created,
                )
                .await;
            if created && !matches!(result, Ok(Placed::Done)) {
                let _ = timeout(CLEANUP_TIMEOUT, self.dst.remove(&temp)).await;
            }
            self.ctl.release_temp(&key);
            match result {
                Err(Stop::Failed(FsError::AlreadyExists(p))) if !created && p == temp => continue,
                Ok(Placed::Done) => self.ctl.progress(|v| v.done_files += 1),
                Ok(Placed::Skipped) => self.skip_file(&item.meta),
                Err(stop) => return Err(stop),
            }
            return Ok(());
        }
        Err(FsError::AlreadyExists(self.dst.join(parent, &temp_name(&name, 0)?)).into())
    }

    /// Sets `created` once the temp file exists, so cleanup never removes one it did not make.
    #[allow(clippy::too_many_arguments)]
    async fn write_and_place(
        &mut self,
        item: &Item,
        parent: &str,
        temp: &str,
        mut dest: String,
        mut replace: bool,
        mode: u32,
        created: &mut bool,
    ) -> Result<Placed, Stop> {
        if self.ctl.check(self.dst.stat_dest(temp)).await??.is_some() {
            return Err(FsError::AlreadyExists(temp.to_owned()).into());
        }
        let copied = match self.direction {
            Direction::Upload => self.upload(&item.src, temp, mode, created).await?,
            Direction::Download => self.download(item, temp, mode, created).await?,
        };
        if !copied {
            return Ok(Placed::Skipped);
        }
        for _ in 0..MAX_ATTEMPTS {
            // Not interruptible: dropped midway, a replace could lose the original file (and a
            // local rename keeps running on the blocking pool while cleanup removes the temp).
            // A cancel is honoured before this point; once placed, the file is done.
            let placed = timeout(PLACE_TIMEOUT, self.dst.rename(temp, &dest, replace))
                .await
                .unwrap_or_else(|_| Err(FsError::Io(dest.clone())));
            match placed {
                Ok(()) => return Ok(Placed::Done),
                // Something appeared at the destination while the data was copied.
                Err(FsError::AlreadyExists(_)) if !replace => {
                    let Some(existing) = self.ctl.check(self.dst.stat_dest(&dest)).await?? else {
                        continue;
                    };
                    match self.decide(&dest, &existing, &item.meta).await? {
                        Decision::Overwrite if existing.kind == EntryKind::Dir => {
                            return Err(FsError::AlreadyExists(dest).into());
                        }
                        Decision::Overwrite => replace = true,
                        Decision::Skip => return Ok(Placed::Skipped),
                        Decision::Rename => {
                            dest = self.free_name(parent, &item.name, false).await?.0
                        }
                    }
                }
                Err(e) => return Err(e.into()),
            }
        }
        Err(FsError::AlreadyExists(dest).into())
    }

    /// `false` when the source is no longer a regular file.
    async fn upload(
        &self,
        src: &str,
        temp: &str,
        mode: u32,
        created: &mut bool,
    ) -> Result<bool, Stop> {
        let ctl = self.ctl;
        let path = local_path(src);
        let Some(file) = ctl.check(blocking(move || open_source(&path))).await?? else {
            return Ok(false);
        };
        let mut file = tokio::fs::File::from_std(file);
        // Not under `check`: dropped, the open could leave a handle on the server. It has its
        // own request timeout.
        let handle = self.remote.create_new(temp).await?;
        *created = true;
        let result = async {
            ctl.stopped()?;
            self.send(&mut file, src, &handle, temp).await?;
            self.remote.set_handle_mode(&handle, mode, temp).await?;
            Ok::<_, Stop>(())
        }
        .await;
        let closed = timeout(CLEANUP_TIMEOUT, self.remote.close_handle(&handle, temp)).await;
        result?;
        match closed {
            Ok(Ok(())) => Ok(true),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(FsError::Network.into()),
        }
    }

    async fn send(
        &self,
        file: &mut tokio::fs::File,
        src: &str,
        handle: &str,
        temp: &str,
    ) -> Result<(), Stop> {
        let ctl = self.ctl;
        let mut inflight: VecDeque<Task<Result<u64, FsError>>> = VecDeque::new();
        let mut offset = 0u64;
        loop {
            let mut buf = vec![0u8; CHUNK];
            let mut n = 0;
            while n < CHUNK {
                let read = ctl
                    .check(file.read(&mut buf[n..]))
                    .await?
                    .map_err(|e| localfs::fail(e, &local_path(src)))?;
                if read == 0 {
                    break;
                }
                n += read;
            }
            if n > 0 {
                buf.truncate(n);
                let (r, h, p) = (self.remote.clone(), handle.to_owned(), temp.to_owned());
                inflight.push_back(Task(tokio::spawn(async move {
                    r.write_at(&h, offset, buf, &p).await.map(|()| n as u64)
                })));
                offset = offset.saturating_add(n as u64);
            }
            let last = n < CHUNK;
            while inflight.len() >= IN_FLIGHT || (last && !inflight.is_empty()) {
                let Some(task) = inflight.pop_front() else {
                    break;
                };
                let written = ctl.check(task).await???;
                ctl.progress(|v| v.done_bytes = v.done_bytes.saturating_add(written));
            }
            if last {
                return Ok(());
            }
        }
    }

    /// `false` when the source is no longer a regular file.
    async fn download(
        &self,
        item: &Item,
        temp: &str,
        mode: u32,
        created: &mut bool,
    ) -> Result<bool, Stop> {
        let ctl = self.ctl;
        let src = item.src.as_str();
        match ctl.check(self.remote.stat_link(src)).await?? {
            Some(m) if m.kind == EntryKind::File => {}
            _ => return Ok(false),
        }
        // Not under `check`: dropped, the open could leave a handle on the server.
        let handle = self.remote.open_read(src).await?;
        let result = async {
            ctl.stopped()?;
            // `open` follows links; the handle shows what was actually opened.
            let opened = ctl.check(self.remote.stat_handle(&handle, src)).await??;
            if opened.kind != EntryKind::File {
                return Ok(false);
            }
            let limit = opened
                .size
                .or(item.meta.size)
                .unwrap_or(0)
                .saturating_add(GROWTH_MARGIN);
            let (root, path) = (local_path(&self.target), local_path(temp));
            // Not under `check`: a cancel would leave the blocking create running and its file
            // behind, with `created` never set.
            let file = blocking(move || create_local_temp(&root, &path)).await?;
            *created = true;
            ctl.stopped()?;
            let mut file = tokio::fs::File::from_std(file);
            let received = self.receive(&mut file, src, &handle, temp, limit).await;
            let flushed = file.flush().await;
            received?;
            flushed.map_err(|e| localfs::fail(e, &local_path(temp)))?;
            set_local_mode(&file, mode, temp).await?;
            Ok(true)
        }
        .await;
        let _ = timeout(CLEANUP_TIMEOUT, self.remote.close_handle(&handle, src)).await;
        result
    }

    /// Fails with `too_large` past `limit` bytes, so a server cannot fill the disk.
    async fn receive(
        &self,
        file: &mut tokio::fs::File,
        src: &str,
        handle: &str,
        temp: &str,
        limit: u64,
    ) -> Result<(), Stop> {
        let ctl = self.ctl;
        let mut inflight: VecDeque<(u64, Task<ReadResult>)> = VecDeque::new();
        let mut next = 0u64;
        let mut received = 0u64;
        loop {
            while inflight.len() < IN_FLIGHT {
                let (r, h, p) = (self.remote.clone(), handle.to_owned(), src.to_owned());
                let offset = next;
                inflight.push_back((
                    offset,
                    Task(tokio::spawn(async move {
                        r.read_at(&h, offset, CHUNK as u32, &p).await
                    })),
                ));
                next = next.saturating_add(CHUNK as u64);
            }
            let Some((offset, task)) = inflight.pop_front() else {
                return Ok(());
            };
            let Some(data) = ctl.check(task).await??? else {
                return Ok(());
            };
            if data.is_empty() {
                return Ok(());
            }
            let len = data.len() as u64;
            received = received.saturating_add(len);
            if received > limit {
                return Err(FsError::TooLarge(src.to_owned()).into());
            }
            ctl.check(file.write_all(&data))
                .await?
                .map_err(|e| localfs::fail(e, &local_path(temp)))?;
            ctl.progress(|v| v.done_bytes = v.done_bytes.saturating_add(len));
            if data.len() < CHUNK {
                // A short read leaves a gap before the requests already sent; ask again from
                // the end of what arrived.
                inflight.clear();
                next = offset.saturating_add(len);
            }
        }
    }
}
