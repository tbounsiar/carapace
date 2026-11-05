//! Minimal Aptabase ingestion client: batches of events POSTed as JSON with the `App-Key`
//! header, and crash reports one per request on the error endpoint. Memory only; a batch that
//! keeps failing is dropped.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::event::{Category, Props};
use super::system::SystemProps;

pub const BATCH: usize = 25;
pub const MAX_QUEUED: usize = 500;
pub const MAX_TRIES: u8 = 3;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const EU: &str = "https://eu.aptabase.com";
const US: &str = "https://us.aptabase.com";
const PATH: &str = "/api/v0/events";
const ERROR_PATH: &str = "/api/v0/error";
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
    /// A batch of events.
    fn post(&self, body: &[u8], timeout: Duration) -> Posted;
    /// One crash report.
    fn post_error(&self, body: &[u8], timeout: Duration) -> Posted;
}

/// The events endpoint: any 4xx is final.
pub fn event_outcome(status: Option<u16>) -> Posted {
    match status {
        Some(200..=299) => Posted::Sent,
        Some(400..=499) => Posted::Rejected,
        _ => Posted::Retry,
    }
}

/// The error endpoint: a timeout or rate limit is retried; 403 (quota exhausted) and any other
/// 4xx are final, as is anything else that is not a server error.
pub fn error_outcome(status: Option<u16>) -> Posted {
    match status {
        None | Some(408 | 429 | 500..=599) => Posted::Retry,
        Some(200..=299) => Posted::Sent,
        Some(_) => Posted::Rejected,
    }
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
    error_url: String,
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
            error_url: format!("{base}{ERROR_PATH}"),
            key: key.to_owned(),
        }
    }

    /// The status, or `None` for a network error or timeout.
    fn send(&self, url: &str, body: &[u8], timeout: Duration) -> Option<u16> {
        self.agent
            .post(url)
            .header("App-Key", &self.key)
            .content_type("application/json")
            .config()
            .timeout_global(Some(timeout.min(REQUEST_TIMEOUT)))
            .build()
            .send(body)
            .ok()
            .map(|r| r.status().as_u16())
    }
}

impl Transport for Aptabase {
    fn post(&self, body: &[u8], timeout: Duration) -> Posted {
        event_outcome(self.send(&self.url, body, timeout))
    }

    fn post_error(&self, body: &[u8], timeout: Duration) -> Posted {
        error_outcome(self.send(&self.error_url, body, timeout))
    }
}

struct Queued {
    event: Envelope,
    category: Category,
    /// The category's generation when queued; an older one means it was turned off since.
    generation: u64,
    tries: u8,
}

#[derive(Default)]
struct Queue {
    events: VecDeque<Queued>,
    /// Per category, bumped by `discard`, so an event in flight when its category is turned off
    /// is never posted nor put back.
    generation: [u64; Category::COUNT],
}

impl Queue {
    fn current(&self, item: &Queued) -> bool {
        self.generation[item.category.index()] == item.generation
    }
}

pub struct Outbox {
    transport: Arc<dyn Transport>,
    queue: Mutex<Queue>,
    // One flush at a time, so the periodic and the exit flush never send a batch twice.
    flushing: Mutex<()>,
    stopping: AtomicBool,
    /// Runs between taking a batch and posting it.
    #[cfg(test)]
    pub after_drain: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Runs after a batch is serialized, right before the last check.
    #[cfg(test)]
    pub before_post: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Outbox {
    pub fn new(transport: Arc<dyn Transport>) -> Self {
        Self {
            transport,
            queue: Mutex::new(Queue::default()),
            flushing: Mutex::new(()),
            stopping: AtomicBool::new(false),
            #[cfg(test)]
            after_drain: Mutex::new(None),
            #[cfg(test)]
            before_post: Mutex::new(None),
        }
    }

    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn push(&self, event: Envelope, category: Category) {
        let mut q = self.queue();
        if q.events.len() >= MAX_QUEUED {
            q.events.pop_front();
        }
        let generation = q.generation[category.index()];
        q.events.push_back(Queued {
            event,
            category,
            generation,
            tries: 0,
        });
    }

    /// Drops the unsent events of one category; the others stay queued.
    pub fn discard(&self, category: Category) {
        let mut q = self.queue();
        q.events.retain(|e| e.category != category);
        q.generation[category.index()] += 1;
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

    /// Asked before the exit flush: a periodic flush still running stops after its current
    /// request.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }

    /// Drops the events of categories turned off since they were queued and serializes the
    /// rest. The check is repeated after serializing, so the body posted holds only events that
    /// were current right before the request; one already in flight cannot be recalled.
    fn body_of_current(&self, batch: &mut Vec<Queued>) -> Option<Vec<u8>> {
        loop {
            {
                let q = self.queue();
                batch.retain(|e| q.current(e));
            }
            if batch.is_empty() {
                return None;
            }
            let events: Vec<&Envelope> = batch.iter().map(|q| &q.event).collect();
            let body = serde_json::to_vec(&events).ok()?;
            #[cfg(test)]
            if let Some(hook) = self.before_post.lock().unwrap().take() {
                hook();
            }
            let q = self.queue();
            if batch.iter().all(|e| q.current(e)) {
                return Some(body);
            }
        }
    }

    fn send(&self, deadline: Instant) {
        let stopping = self.stopping.load(Ordering::SeqCst);
        let mut retry: Vec<Queued> = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            // A periodic flush yields to the exit flush between batches.
            if left.is_zero() || (!stopping && self.stopping.load(Ordering::SeqCst)) {
                break;
            }
            let mut batch = {
                let mut q = self.queue();
                let n = q.events.len().min(BATCH);
                q.events.drain(..n).collect::<Vec<_>>()
            };
            if batch.is_empty() {
                break;
            }
            #[cfg(test)]
            if let Some(hook) = self.after_drain.lock().unwrap().take() {
                hook();
            }
            let Some(body) = self.body_of_current(&mut batch) else {
                continue;
            };
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
        retry.retain(|e| q.current(e));
        for item in retry.into_iter().rev() {
            if q.events.len() >= MAX_QUEUED {
                break;
            }
            q.events.push_front(item);
        }
    }
}
