//! Minimal Aptabase ingestion client: batches of events POSTed as JSON with the `App-Key`
//! header. Memory only; a batch that keeps failing is dropped.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::event::Props;
use super::system::SystemProps;

pub const BATCH: usize = 25;
pub const MAX_QUEUED: usize = 500;
pub const MAX_TRIES: u8 = 3;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const EU: &str = "https://eu.aptabase.com";
const US: &str = "https://us.aptabase.com";
const PATH: &str = "/api/v0/events";
pub const SDK_VERSION: &str = concat!("carapace@", env!("CARGO_PKG_VERSION"));
const LOCK_POLL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Posted {
    Sent,
    /// Network error, timeout or server error.
    Retry,
    /// Refused by the server (4xx): sending it again would not help.
    Rejected,
}

pub trait Transport: Send + Sync {
    fn post(&self, body: &[u8], timeout: Duration) -> Posted;
}

/// What Aptabase receives for one event. `sdkVersion` is the only system property its API
/// requires beyond ours; it names this client, not the machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub timestamp: String,
    pub session_id: String,
    pub event_name: &'static str,
    pub system_props: WireSystem,
    pub props: Props,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireSystem {
    pub app_version: String,
    pub os_name: String,
    pub os_version: String,
    pub locale: Option<String>,
    pub sdk_version: &'static str,
}

impl WireSystem {
    pub fn from(system: &SystemProps) -> Self {
        Self {
            app_version: system.app_version.clone(),
            os_name: system.os.clone(),
            os_version: system.os_version.clone(),
            locale: (!system.locale.is_empty()).then(|| system.locale.clone()),
            sdk_version: SDK_VERSION,
        }
    }
}

/// The ingestion host, from the region in the key (`A-EU-…`, `A-US-…`). Development and
/// self-hosted keys are not supported: they make the build unavailable.
pub fn base_url(key: &str) -> Option<&'static str> {
    let parts: Vec<&str> = key.split('-').collect();
    if parts.len() != 3 || parts[0] != "A" || parts[2].is_empty() {
        return None;
    }
    if !parts[2].chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    match parts[1] {
        "EU" => Some(EU),
        "US" => Some(US),
        _ => None,
    }
}

pub struct Aptabase {
    agent: ureq::Agent,
    url: String,
    key: String,
}

impl Aptabase {
    pub fn from_key(key: &str) -> Option<Self> {
        base_url(key).map(|base| Self::new(base, key, true))
    }

    /// `env_proxy` reads the usual proxy variables; tests turn it off to reach a local server.
    pub fn new(base: &str, key: &str, env_proxy: bool) -> Self {
        let mut config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .user_agent("Carapace")
            .timeout_global(Some(REQUEST_TIMEOUT));
        if !env_proxy {
            config = config.proxy(None);
        }
        Self {
            agent: config.build().into(),
            url: format!("{base}{PATH}"),
            key: key.to_owned(),
        }
    }
}

impl Transport for Aptabase {
    fn post(&self, body: &[u8], timeout: Duration) -> Posted {
        let sent = self
            .agent
            .post(&self.url)
            .header("App-Key", &self.key)
            .content_type("application/json")
            .config()
            .timeout_global(Some(timeout.min(REQUEST_TIMEOUT)))
            .build()
            .send(body);
        match sent {
            Ok(r) if r.status().is_success() => Posted::Sent,
            Ok(r) if r.status().is_client_error() => Posted::Rejected,
            _ => Posted::Retry,
        }
    }
}

struct Queued {
    event: Envelope,
    tries: u8,
}

#[derive(Default)]
struct Queue {
    events: VecDeque<Queued>,
    /// Bumped by `discard`, so a batch in flight when consent is revoked is never put back.
    generation: u64,
}

pub struct Outbox {
    transport: Box<dyn Transport>,
    queue: Mutex<Queue>,
    // One flush at a time, so the periodic and the exit flush never send a batch twice.
    flushing: Mutex<()>,
    stopping: AtomicBool,
    /// Runs between taking a batch and posting it.
    #[cfg(test)]
    pub after_drain: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Outbox {
    pub fn new(transport: Box<dyn Transport>) -> Self {
        Self {
            transport,
            queue: Mutex::new(Queue::default()),
            flushing: Mutex::new(()),
            stopping: AtomicBool::new(false),
            #[cfg(test)]
            after_drain: Mutex::new(None),
        }
    }

    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn push(&self, event: Envelope) {
        let mut q = self.queue();
        if q.events.len() >= MAX_QUEUED {
            q.events.pop_front();
        }
        q.events.push_back(Queued { event, tries: 0 });
    }

    pub fn discard(&self) {
        let mut q = self.queue();
        q.events.clear();
        q.generation += 1;
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.queue().events.len()
    }

    /// Sends what is queued, in batches, until the queue is empty, a batch must wait for the
    /// next flush, `deadline` passes or a stop is asked. Waits for a running flush at most
    /// until `deadline`, then gives up.
    pub fn flush(&self, deadline: Instant) {
        let _one = loop {
            match self.flushing.try_lock() {
                Ok(g) => break g,
                Err(TryLockError::Poisoned(e)) => break e.into_inner(),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(LOCK_POLL);
                }
                Err(TryLockError::WouldBlock) => return,
            }
        };
        self.send(deadline);
    }

    /// The exit flush: a periodic flush still running stops after its current request.
    pub fn stop_and_flush(&self, deadline: Instant) {
        self.stopping.store(true, Ordering::SeqCst);
        self.flush(deadline);
    }

    fn send(&self, deadline: Instant) {
        let stopping = self.stopping.load(Ordering::SeqCst);
        let mut retry: Vec<Queued> = Vec::new();
        let mut generation = None;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            // A periodic flush yields to the exit flush between batches.
            if left.is_zero() || (!stopping && self.stopping.load(Ordering::SeqCst)) {
                break;
            }
            let (batch, g) = {
                let mut q = self.queue();
                let n = q.events.len().min(BATCH);
                (q.events.drain(..n).collect::<Vec<_>>(), q.generation)
            };
            if batch.is_empty() {
                break;
            }
            if generation.is_some_and(|old| old != g) {
                retry.clear();
            }
            generation = Some(g);
            let events: Vec<&Envelope> = batch.iter().map(|q| &q.event).collect();
            let Ok(body) = serde_json::to_vec(&events) else {
                continue;
            };
            #[cfg(test)]
            if let Some(hook) = self.after_drain.lock().unwrap().take() {
                hook();
            }
            // Consent revoked since the batch was taken: drop it unsent.
            if self.queue().generation != g {
                continue;
            }
            match self.transport.post(&body, left) {
                Posted::Sent | Posted::Rejected => {}
                Posted::Retry => {
                    retry.extend(
                        batch
                            .into_iter()
                            .map(|q| Queued {
                                tries: q.tries + 1,
                                ..q
                            })
                            .filter(|q| q.tries < MAX_TRIES),
                    );
                    // The endpoint is unreachable now; the rest waits for the next flush.
                    break;
                }
            }
        }
        if retry.is_empty() {
            return;
        }
        let mut q = self.queue();
        if generation != Some(q.generation) {
            return;
        }
        for item in retry.into_iter().rev() {
            if q.events.len() >= MAX_QUEUED {
                break;
            }
            q.events.push_front(item);
        }
    }
}
