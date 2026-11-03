//! Opt-in usage analytics. Consent is enforced here: unless it is granted for the current
//! catalogue version, no event is built, logged, queued or sent.

mod client;
mod event;
mod system;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

pub use client::{Aptabase, Outbox, SDK_VERSION, Transport};
pub use event::{
    Auth, CATALOGUE_VERSION, Count, Counts, ErrorCode, Event, Files, GeneratedType, ImportedType,
    Outcome, Props, Scope, TestResult, Theme, Took, TransferDirection,
};
pub use system::SystemProps;

use crate::config::{AnalyticsConsent, Consent};
use client::{Envelope, WireSystem};

pub const MAX_RECENT: usize = 50;
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(60);
pub const EXIT_FLUSH: Duration = Duration::from_secs(3);
/// Budget of one periodic flush, so a slow endpoint never holds the sender for long.
pub const PERIODIC_FLUSH: Duration = Duration::from_secs(15);
/// Attempts held at once; the oldest is reported when a new one needs room.
pub const MAX_ATTEMPTS: usize = 64;
/// A failure the user may still retry with a typed secret is reported once this has passed
/// without a retry.
pub const ATTEMPT_TTL: Duration = Duration::from_secs(300);

/// Compiled in by the release workflow; forks have none and send nothing.
const APP_KEY: Option<&str> = option_env!("APTABASE_KEY");

/// Debug builds never send, even with a key in the environment (PRIVACY.md says so).
pub fn app_key() -> Option<&'static str> {
    if cfg!(debug_assertions) {
        None
    } else {
        APP_KEY
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsState {
    pub consent: Consent,
    pub ask_needed: bool,
    pub available: bool,
    /// False while the effective consent (a deny) could not be written to the config yet.
    pub persisted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecentEvent {
    pub time: String,
    pub name: &'static str,
    pub props: Props,
}

/// Everything sent with each event besides its name, time and props.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSystem {
    #[serde(flatten)]
    pub props: SystemProps,
    pub sdk_version: &'static str,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Recent {
    pub system: RecentSystem,
    pub events: Vec<RecentEvent>,
}

/// One user attempt that may span several calls (the credential prompt loop).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Attempt {
    Connect(String),
    Test(String),
}

struct Pending {
    event: Event,
    since: Instant,
}

#[derive(Default)]
struct State {
    stored: Option<AnalyticsConsent>,
    recent: VecDeque<RecentEvent>,
    started: bool,
    theme: Option<Theme>,
    attempts: HashMap<Attempt, Pending>,
    listed: HashSet<String>,
    /// The in-memory consent still has to be written (a deny whose save failed).
    unsaved: bool,
}

impl State {
    fn collecting(&self) -> bool {
        matches!(
            self.stored,
            Some(AnalyticsConsent { consent: Consent::Granted, catalogue_version }) if catalogue_version >= CATALOGUE_VERSION
        )
    }

    fn view(&self, available: bool) -> AnalyticsState {
        let consent = self.stored.map(|s| s.consent).unwrap_or_default();
        AnalyticsState {
            consent,
            ask_needed: consent == Consent::Unset
                || (consent == Consent::Granted && !self.collecting()),
            available,
            persisted: !self.unsaved,
        }
    }

    fn forget(&mut self) {
        self.recent.clear();
        self.attempts.clear();
        self.listed.clear();
    }
}

struct Inner {
    // Held across a whole consent change, the save included, so the last change wins both in
    // memory and on disk. Taken before `state`, never the other way.
    consent: Mutex<()>,
    state: Mutex<State>,
    system: SystemProps,
    session_id: String,
    outbox: Option<Outbox>,
}

#[derive(Clone)]
pub struct Analytics {
    inner: Arc<Inner>,
}

impl Analytics {
    /// `transport: None` is an unavailable build: the gate and the recent log work, nothing
    /// is ever sent.
    pub fn new(
        stored: Option<AnalyticsConsent>,
        system: SystemProps,
        transport: Option<Box<dyn Transport>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                consent: Mutex::new(()),
                state: Mutex::new(State {
                    stored,
                    ..State::default()
                }),
                system,
                // Not numeric: Aptabase reads numeric session ids as timestamps.
                session_id: uuid::Uuid::new_v4().to_string(),
                outbox: transport.map(Outbox::new),
            }),
        }
    }

    /// The app's instance: the key compiled in, if any.
    pub fn for_app(stored: Option<AnalyticsConsent>, app_version: &str) -> Self {
        let key = app_key();
        let transport = key
            .and_then(Aptabase::from_key)
            .map(|c| Box::new(c) as Box<dyn Transport>);
        if key.is_some() && transport.is_none() {
            log::warn!("the analytics key is not a supported Aptabase key; nothing will be sent");
        }
        Self::new(stored, SystemProps::detect(app_version), transport)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn available(&self) -> bool {
        self.inner.outbox.is_some()
    }

    pub fn status(&self) -> AnalyticsState {
        self.state().view(self.available())
    }

    pub fn collecting(&self) -> bool {
        self.state().collecting()
    }

    fn record_in(&self, st: &mut State, event: Event) {
        if !st.collecting() {
            return;
        }
        let now = SystemTime::now();
        let time = system::iso_utc(now);
        let props = event.props();
        st.recent.push_front(RecentEvent {
            time: time.clone(),
            name: event.name(),
            props: props.clone(),
        });
        st.recent.truncate(MAX_RECENT);
        if let Some(outbox) = &self.inner.outbox {
            outbox.push(Envelope {
                timestamp: time,
                session_id: self.inner.session_id.clone(),
                event_name: event.name(),
                system_props: WireSystem::from(&self.inner.system),
                props,
            });
        }
    }

    pub fn record(&self, event: Event) {
        let mut st = self.state();
        self.record_in(&mut st, event);
    }

    /// Granting persists first and changes nothing if that fails. Denying takes effect in
    /// memory first (queue discarded, log cleared) and stays in effect for this session even if
    /// it cannot be saved; `retry_save` writes it later. Calls are serialized, save included.
    pub fn set_consent<E>(
        &self,
        granted: bool,
        persist: impl FnOnce(AnalyticsConsent) -> Result<(), E>,
        counts: impl FnOnce() -> Counts,
    ) -> Result<AnalyticsState, E> {
        let _one = self.inner.consent.lock().unwrap_or_else(|e| e.into_inner());
        let value = AnalyticsConsent {
            consent: if granted {
                Consent::Granted
            } else {
                Consent::Denied
            },
            catalogue_version: CATALOGUE_VERSION,
        };
        if !granted {
            {
                let mut st = self.state();
                st.stored = Some(value);
                st.unsaved = true;
                st.forget();
                if let Some(outbox) = &self.inner.outbox {
                    outbox.discard();
                }
            }
            persist(value)?;
            let mut st = self.state();
            st.unsaved = false;
            return Ok(st.view(self.available()));
        }
        let counts = (!self.state().started).then(counts);
        persist(value)?;
        let mut st = self.state();
        let was = st.collecting();
        st.stored = Some(value);
        st.unsaved = false;
        if !was {
            self.record_in(&mut st, Event::ConsentGranted);
        }
        if let (false, Some(theme), Some(counts)) = (st.started, st.theme, counts) {
            st.started = true;
            self.record_in(&mut st, Event::app_started(theme, counts));
        }
        Ok(st.view(self.available()))
    }

    /// Writes a consent whose save failed earlier; called on the flush tick and at exit.
    pub fn retry_save<E>(&self, persist: impl FnOnce(AnalyticsConsent) -> Result<(), E>) {
        let _one = self.inner.consent.lock().unwrap_or_else(|e| e.into_inner());
        let value = {
            let st = self.state();
            match (st.unsaved, st.stored) {
                (true, Some(v)) => v,
                _ => return,
            }
        };
        if persist(value).is_ok() {
            self.state().unsaved = false;
        }
    }

    /// Emits `app_started` once per session. Without consent only the theme is kept, so the
    /// event can follow a later grant.
    pub fn app_started(&self, theme: Theme, counts: impl FnOnce() -> Counts) {
        let needed = {
            let mut st = self.state();
            st.theme = Some(theme);
            !st.started && st.collecting()
        };
        if !needed {
            return;
        }
        // Read outside the lock: it loads the config file.
        let counts = counts();
        let mut st = self.state();
        if st.started || !st.collecting() {
            return;
        }
        st.started = true;
        self.record_in(&mut st, Event::app_started(theme, counts));
    }

    pub fn recent(&self) -> Recent {
        let st = self.state();
        let events = if st.collecting() {
            st.recent.iter().cloned().collect()
        } else {
            Vec::new()
        };
        Recent {
            system: RecentSystem {
                props: self.inner.system.clone(),
                sdk_version: SDK_VERSION,
                session_id: self.inner.session_id.clone(),
            },
            events,
        }
    }

    /// A first call (`retry: false`) means the previous attempt for this key was given up.
    pub fn attempt_started(&self, key: &Attempt, retry: bool) {
        if retry {
            return;
        }
        let mut st = self.state();
        if let Some(p) = st.attempts.remove(key) {
            self.record_in(&mut st, p.event);
        }
    }

    /// The attempt failed in a way the user may retry; `abandoned` is sent if no retry ends it.
    pub fn attempt_pending(&self, key: Attempt, abandoned: Event) {
        let mut st = self.state();
        if !st.collecting() {
            return;
        }
        if !st.attempts.contains_key(&key) && st.attempts.len() >= MAX_ATTEMPTS {
            let oldest = st
                .attempts
                .iter()
                .min_by_key(|(_, p)| p.since)
                .map(|(k, _)| k.clone());
            if let Some(p) = oldest.and_then(|k| st.attempts.remove(&k)) {
                self.record_in(&mut st, p.event);
            }
        }
        {
            st.attempts.insert(
                key,
                Pending {
                    event: abandoned,
                    since: Instant::now(),
                },
            );
        }
    }

    pub fn attempt_done(&self, key: &Attempt, event: Option<Event>) {
        let mut st = self.state();
        st.attempts.remove(key);
        if let Some(event) = event {
            self.record_in(&mut st, event);
        }
    }

    /// A new connection: its first remote listing is `files_opened` again.
    pub fn connection_opened(&self, connection_id: &str) {
        self.state().listed.remove(connection_id);
    }

    pub fn files_listed(&self, connection_id: &str) {
        let mut st = self.state();
        if st.collecting() && st.listed.insert(connection_id.to_owned()) {
            self.record_in(&mut st, Event::FilesOpened);
        }
    }

    /// Reports attempts nobody retried within `ttl` (all of them with `Duration::ZERO`).
    pub fn expire_attempts(&self, ttl: Duration) {
        let mut st = self.state();
        let now = Instant::now();
        let mut stale: Vec<(Attempt, Instant)> = st
            .attempts
            .iter()
            .filter(|(_, p)| now.duration_since(p.since) >= ttl)
            .map(|(k, p)| (k.clone(), p.since))
            .collect();
        stale.sort_by_key(|(_, since)| *since);
        for (key, _) in stale {
            if let Some(p) = st.attempts.remove(&key) {
                self.record_in(&mut st, p.event);
            }
        }
    }

    /// Blocking; call from a blocking thread.
    pub fn flush(&self, budget: Duration) {
        if let Some(outbox) = &self.inner.outbox {
            outbox.flush(Instant::now() + budget);
        }
    }

    /// Best effort at exit: pending attempts are reported, a running periodic flush is told
    /// to stop, then one flush bounded by `EXIT_FLUSH` overall (skipped if the running one does
    /// not let go in time).
    pub fn shutdown(&self) {
        self.expire_attempts(Duration::ZERO);
        if let Some(outbox) = &self.inner.outbox {
            outbox.stop_and_flush(Instant::now() + EXIT_FLUSH);
        }
    }

    /// Granted, keyless: what was recorded is read back with `recorded`.
    #[cfg(test)]
    pub fn granted_for_tests() -> Self {
        let stored = AnalyticsConsent {
            consent: Consent::Granted,
            catalogue_version: CATALOGUE_VERSION,
        };
        let system = SystemProps {
            app_version: "0".into(),
            os: "test".into(),
            os_version: "0".into(),
            locale: String::new(),
        };
        Self::new(Some(stored), system, None)
    }

    /// Oldest first, each with its properties as JSON.
    #[cfg(test)]
    pub fn recorded(&self) -> Vec<(&'static str, serde_json::Value)> {
        let mut out: Vec<_> = self
            .recent()
            .events
            .into_iter()
            .map(|e| (e.name, serde_json::to_value(&e.props).unwrap()))
            .collect();
        out.reverse();
        out
    }

    #[cfg(test)]
    fn outbox(&self) -> &Outbox {
        self.inner.outbox.as_ref().unwrap()
    }

    #[cfg(test)]
    fn attempts(&self) -> usize {
        self.state().attempts.len()
    }

    #[cfg(test)]
    fn queued(&self) -> usize {
        self.inner.outbox.as_ref().map_or(0, Outbox::len)
    }
}

#[cfg(test)]
mod tests;
