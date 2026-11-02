use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use uuid::Uuid;

use super::error::TerminalError;
use crate::ssh::{SessionEnd, SessionRef, SshManager};

pub const MAX_COLS: u32 = 1000;
pub const MAX_ROWS: u32 = 500;
pub const MAX_WRITE_BYTES: usize = 64 * 1024;
pub const MAX_PER_HOST: usize = 32;
/// Input bytes queued per terminal and not yet handed to the SSH channel.
pub const INPUT_BUDGET: usize = 1024 * 1024;
/// Output bytes read from the SSH channel and not yet handed to the emitter.
pub const OUTPUT_BUDGET: usize = 1024 * 1024;
/// Largest `data` event, before base64.
pub const MAX_CHUNK: usize = 64 * 1024;

const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const RESIZE_COST: u32 = 64;
const TERM: &str = "xterm-256color";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    Exited,
    Closed,
    ConnectionLost,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    /// Base64 of the raw output bytes.
    Data {
        data: String,
    },
    Exit {
        code: Option<u32>,
    },
    Closed {
        reason: CloseReason,
    },
}

/// Delivers an event; `false` means the receiver is gone and the terminal must close.
pub type Emit = Arc<dyn Fn(TerminalEvent) -> bool + Send + Sync>;

/// Each input holds its share of the input budget until it is written to the channel.
enum Input {
    Data(Vec<u8>, OwnedSemaphorePermit),
    Resize {
        cols: u32,
        rows: u32,
        _cost: OwnedSemaphorePermit,
    },
}

enum Output {
    Data(Vec<u8>, OwnedSemaphorePermit),
    Exit(Option<u32>),
}

struct Entry {
    host_id: String,
    input: mpsc::UnboundedSender<Input>,
    input_budget: Arc<Semaphore>,
    close: oneshot::Sender<()>,
    #[cfg(test)]
    output_budget: Arc<Semaphore>,
}

#[derive(Default)]
struct Registry {
    terminals: HashMap<String, Entry>,
    opening: HashMap<String, usize>,
}

type Shared = Arc<Mutex<Registry>>;

fn lock(registry: &Shared) -> MutexGuard<'_, Registry> {
    // Every critical section is a few map operations that cannot leave the maps half-updated.
    registry.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn check_size(cols: u32, rows: u32) -> Result<(), TerminalError> {
    if !(1..=MAX_COLS).contains(&cols) || !(1..=MAX_ROWS).contains(&rows) {
        return Err(TerminalError::InvalidInput(format!(
            "cols must be 1 to {MAX_COLS} and rows 1 to {MAX_ROWS}"
        )));
    }
    Ok(())
}

/// Counts an open in progress against the per-host limit until the terminal is registered.
struct Reservation {
    registry: Shared,
    host_id: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut reg = lock(&self.registry);
        if let Some(n) = reg.opening.get_mut(&self.host_id) {
            *n -= 1;
            if *n == 0 {
                reg.opening.remove(&self.host_id);
            }
        }
    }
}

#[derive(Default)]
pub struct TerminalManager {
    registry: Shared,
}

impl TerminalManager {
    /// Opens a PTY shell channel on the host's existing connection and returns its terminal id.
    pub async fn open(
        &self,
        ssh: &SshManager,
        host_id: &str,
        cols: u32,
        rows: u32,
        emit: Emit,
    ) -> Result<String, TerminalError> {
        check_size(cols, rows)?;
        let reservation = self.reserve(host_id)?;
        let session = ssh
            .session(host_id)
            .await
            .ok_or(TerminalError::NotConnected)?;
        let (channel, early) = start_shell(&session, cols, rows).await?;
        let (read, write) = channel.split();

        let id = Uuid::new_v4().to_string();
        let (input, inputs) = mpsc::unbounded_channel();
        let input_budget = Arc::new(Semaphore::new(INPUT_BUDGET));
        let output_budget = Arc::new(Semaphore::new(OUTPUT_BUDGET));
        let (close, close_rx) = oneshot::channel();
        lock(&self.registry).terminals.insert(
            id.clone(),
            Entry {
                host_id: host_id.to_owned(),
                input,
                input_budget,
                close,
                #[cfg(test)]
                output_budget: output_budget.clone(),
            },
        );
        drop(reservation);

        let (outputs, queued) = mpsc::unbounded_channel();
        let (failed, failed_rx) = oneshot::channel();
        let (reason, reason_rx) = oneshot::channel();
        tokio::spawn(deliver(queued, emit, failed, reason_rx));

        let write = Arc::new(write);
        let writer = tokio::spawn(apply_inputs(write.clone(), inputs));
        let done = Done {
            id: id.clone(),
            registry: self.registry.clone(),
            writer,
            reason: Some(reason),
            value: CloseReason::ConnectionLost,
        };
        let pump = Pump {
            read,
            write,
            outputs,
            budget: output_budget,
            stops: Stops {
                close: close_rx,
                failed: failed_rx,
                ended: session.ended,
            },
        };
        tokio::spawn(pump.run(done, early));
        Ok(id)
    }

    /// Never blocks: input is queued in call order, and a full queue is reported, not awaited.
    pub fn write(&self, terminal_id: &str, data: &str) -> Result<(), TerminalError> {
        if data.len() > MAX_WRITE_BYTES {
            return Err(TerminalError::InvalidInput(format!(
                "data must be at most {MAX_WRITE_BYTES} bytes per call"
            )));
        }
        let (input, budget) = self.input(terminal_id)?;
        if data.is_empty() {
            return Ok(());
        }
        let permit = take(&budget, data.len() as u32)?;
        input
            .send(Input::Data(data.as_bytes().to_vec(), permit))
            .map_err(|_| TerminalError::NotFound)
    }

    pub fn resize(&self, terminal_id: &str, cols: u32, rows: u32) -> Result<(), TerminalError> {
        check_size(cols, rows)?;
        let (input, budget) = self.input(terminal_id)?;
        let _cost = take(&budget, RESIZE_COST)?;
        input
            .send(Input::Resize { cols, rows, _cost })
            .map_err(|_| TerminalError::NotFound)
    }

    pub fn close(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let entry = lock(&self.registry)
            .terminals
            .remove(terminal_id)
            .ok_or(TerminalError::NotFound)?;
        let _ = entry.close.send(());
        Ok(())
    }

    /// Closes every terminal, e.g. when the page that received their events is gone.
    pub fn close_all(&self) {
        let entries: Vec<Entry> = lock(&self.registry)
            .terminals
            .drain()
            .map(|(_, e)| e)
            .collect();
        for entry in entries {
            let _ = entry.close.send(());
        }
    }

    #[cfg(test)]
    pub fn count(&self, host_id: &str) -> usize {
        lock(&self.registry)
            .terminals
            .values()
            .filter(|e| e.host_id == host_id)
            .count()
    }

    #[cfg(test)]
    pub fn queued_output(&self, terminal_id: &str) -> Option<usize> {
        lock(&self.registry)
            .terminals
            .get(terminal_id)
            .map(|e| OUTPUT_BUDGET - e.output_budget.available_permits())
    }

    fn reserve(&self, host_id: &str) -> Result<Reservation, TerminalError> {
        let mut reg = lock(&self.registry);
        let open = reg
            .terminals
            .values()
            .filter(|e| e.host_id == host_id)
            .count();
        let opening = reg.opening.get(host_id).copied().unwrap_or(0);
        if open + opening >= MAX_PER_HOST {
            return Err(TerminalError::InvalidInput(format!(
                "at most {MAX_PER_HOST} terminals can be open on a host"
            )));
        }
        *reg.opening.entry(host_id.to_owned()).or_default() += 1;
        Ok(Reservation {
            registry: self.registry.clone(),
            host_id: host_id.to_owned(),
        })
    }

    fn input(
        &self,
        terminal_id: &str,
    ) -> Result<(mpsc::UnboundedSender<Input>, Arc<Semaphore>), TerminalError> {
        lock(&self.registry)
            .terminals
            .get(terminal_id)
            .map(|e| (e.input.clone(), e.input_budget.clone()))
            .ok_or(TerminalError::NotFound)
    }
}

fn take(budget: &Arc<Semaphore>, bytes: u32) -> Result<OwnedSemaphorePermit, TerminalError> {
    budget
        .clone()
        .try_acquire_many_owned(bytes)
        .map_err(|_| TerminalError::Busy)
}

fn not_connected_or(session: &SessionRef, other: TerminalError) -> TerminalError {
    if session.handle.is_closed() || session.ended.borrow().is_some() {
        TerminalError::NotConnected
    } else {
        other
    }
}

/// Returns the channel and the output received before the shell was confirmed.
async fn start_shell(
    session: &SessionRef,
    cols: u32,
    rows: u32,
) -> Result<(Channel<Msg>, Vec<u8>), TerminalError> {
    let mut channel = match timeout(OPEN_TIMEOUT, session.handle.channel_open_session()).await {
        Ok(Ok(c)) => c,
        _ => return Err(not_connected_or(session, TerminalError::Network)),
    };
    match timeout(OPEN_TIMEOUT, request_shell(&mut channel, cols, rows)).await {
        Ok(Ok(early)) => Ok((channel, early)),
        _ => {
            let _ = timeout(CLOSE_TIMEOUT, channel.close()).await;
            Err(not_connected_or(session, TerminalError::Network))
        }
    }
}

async fn request_shell(
    channel: &mut Channel<Msg>,
    cols: u32,
    rows: u32,
) -> Result<Vec<u8>, TerminalError> {
    let failed = |_| TerminalError::Network;
    channel
        .request_pty(false, TERM, cols, rows, 0, 0, &[])
        .await
        .map_err(failed)?;
    channel.request_shell(true).await.map_err(failed)?;
    let mut early = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(early),
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                if early.len() + data.len() > OUTPUT_BUDGET {
                    return Err(TerminalError::Network);
                }
                early.extend_from_slice(&data);
            }
            Some(ChannelMsg::Failure | ChannelMsg::Close) | None => {
                return Err(TerminalError::Network);
            }
            Some(_) => {}
        }
    }
}

async fn apply_inputs(
    write: Arc<ChannelWriteHalf<Msg>>,
    mut inputs: mpsc::UnboundedReceiver<Input>,
) {
    while let Some(input) = inputs.recv().await {
        let sent = match input {
            Input::Data(bytes, _permit) => write.data_bytes(bytes).await,
            Input::Resize { cols, rows, .. } => write.window_change(cols, rows, 0, 0).await,
        };
        if sent.is_err() {
            break;
        }
    }
}

/// Emits queued output in order, coalescing chunks up to `MAX_CHUNK`, then `closed` once the
/// pump is done. The only place that emits, so `closed` is last and sent exactly once.
async fn deliver(
    mut queued: mpsc::UnboundedReceiver<Output>,
    emit: Emit,
    failed: oneshot::Sender<()>,
    reason: oneshot::Receiver<CloseReason>,
) {
    let mut failed = Some(failed);
    let mut next = None;
    loop {
        let item = match next.take() {
            Some(item) => item,
            None => match queued.recv().await {
                Some(item) => item,
                None => break,
            },
        };
        let event = match item {
            Output::Exit(code) => TerminalEvent::Exit { code },
            Output::Data(mut bytes, permit) => {
                let mut permits = vec![permit];
                while let Ok(more) = queued.try_recv() {
                    match more {
                        Output::Data(b, p) if bytes.len() + b.len() <= MAX_CHUNK => {
                            bytes.extend_from_slice(&b);
                            permits.push(p);
                        }
                        other => {
                            next = Some(other);
                            break;
                        }
                    }
                }
                TerminalEvent::Data {
                    data: data_encoding::BASE64.encode(&bytes),
                }
            }
        };
        // After a failure the queue is still drained so the pump never waits on the budget.
        if failed.is_some() && !emit(event) {
            let _ = failed.take().map(|f| f.send(()));
        }
    }
    let reason = reason.await.unwrap_or(CloseReason::ConnectionLost);
    emit(TerminalEvent::Closed { reason });
}

/// Runs when the pump ends, whatever the way: unregisters the terminal and hands the reason to
/// `deliver`, which emits `closed` after the output still queued.
struct Done {
    id: String,
    registry: Shared,
    writer: JoinHandle<()>,
    reason: Option<oneshot::Sender<CloseReason>>,
    value: CloseReason,
}

impl Drop for Done {
    fn drop(&mut self) {
        self.writer.abort();
        lock(&self.registry).terminals.remove(&self.id);
        if let Some(tx) = self.reason.take() {
            let _ = tx.send(self.value);
        }
    }
}

fn reason_for(ended: &watch::Receiver<Option<SessionEnd>>) -> CloseReason {
    match *ended.borrow() {
        Some(SessionEnd::Disconnected) => CloseReason::Closed,
        _ => CloseReason::ConnectionLost,
    }
}

enum Stop {
    /// Close the remote channel, then report `closed`.
    CloseChannel,
    Finished(CloseReason),
}

struct Stops {
    close: oneshot::Receiver<()>,
    failed: oneshot::Receiver<()>,
    ended: watch::Receiver<Option<SessionEnd>>,
}

impl Stops {
    /// Cancel safe, so it can sit in a `select!` that may pick another branch.
    async fn next(&mut self) -> Stop {
        tokio::select! {
            biased;
            _ = &mut self.close => Stop::CloseChannel,
            _ = &mut self.failed => Stop::CloseChannel,
            // An error means every sender is gone, which only happens once the connection is.
            _ = self.ended.changed() => Stop::Finished(reason_for(&self.ended)),
        }
    }
}

struct Pump {
    read: ChannelReadHalf,
    write: Arc<ChannelWriteHalf<Msg>>,
    outputs: mpsc::UnboundedSender<Output>,
    budget: Arc<Semaphore>,
    stops: Stops,
}

impl Pump {
    async fn run(mut self, mut done: Done, early: Vec<u8>) {
        let stop = self.pump(early).await;
        done.value = match stop {
            Stop::CloseChannel => {
                let _ = timeout(CLOSE_TIMEOUT, async {
                    let _ = self.write.eof().await;
                    let _ = self.write.close().await;
                })
                .await;
                CloseReason::Closed
            }
            Stop::Finished(reason) => reason,
        };
    }

    async fn pump(&mut self, early: Vec<u8>) -> Stop {
        // The connection may have ended between `session()` and `subscribe()` seeing the change.
        if self.stops.ended.borrow_and_update().is_some() {
            return Stop::Finished(reason_for(&self.stops.ended));
        }
        if let Err(stop) = self.queue(&early).await {
            return stop;
        }
        let mut exited = false;
        loop {
            let msg = tokio::select! {
                biased;
                stop = self.stops.next() => return stop,
                msg = self.read.wait() => msg,
            };
            match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if let Err(stop) = self.queue(&data).await {
                        return stop;
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exited = true;
                    let _ = self.outputs.send(Output::Exit(Some(exit_status)));
                }
                Some(ChannelMsg::ExitSignal { .. }) => {
                    exited = true;
                    let _ = self.outputs.send(Output::Exit(None));
                }
                Some(ChannelMsg::Close) => return Stop::Finished(CloseReason::Exited),
                Some(_) => {}
                None if exited => return Stop::Finished(CloseReason::Exited),
                None => return Stop::Finished(reason_for(&self.stops.ended)),
            }
        }
    }

    /// Waits for room in the output budget; while it waits the channel is not read, so the
    /// connection stops accepting data instead of memory growing.
    async fn queue(&mut self, bytes: &[u8]) -> Result<(), Stop> {
        for chunk in bytes.chunks(MAX_CHUNK) {
            let permit = tokio::select! {
                biased;
                stop = self.stops.next() => return Err(stop),
                permit = self.budget.clone().acquire_many_owned(chunk.len() as u32) => permit,
            };
            let Ok(permit) = permit else {
                return Err(Stop::Finished(CloseReason::ConnectionLost));
            };
            let _ = self.outputs.send(Output::Data(chunk.to_vec(), permit));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod e2e_tests;
