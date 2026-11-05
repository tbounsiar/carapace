//! Usage analytics in three categories. Choices are enforced here: unless an event's category
//! is granted for its current catalogue version and DO_NOT_TRACK is not set, the event is not
//! built, logged, queued or sent.

mod client;
mod event;
mod system;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

pub use client::{Aptabase, Outbox, SDK_VERSION, Transport};
pub use event::{
    Auth, CATALOGUE_VERSION, Category, Count, Counts, ErrorCode, Event, Files, GeneratedType,
    ImportedType, Outcome, Props, Scope, TestResult, Theme, Took, TransferDirection, changed_in,
};
pub use system::SystemProps;

use crate::config::{AnalyticsSettings, CategoryChoice, CategoryChoices, Consent};
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

/// Any value except empty, `0` or `false` (trimmed, any case) asks for no tracking.
pub fn do_not_track(value: Option<&std::ffi::OsStr>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let value = value.to_string_lossy();
    let value = value.trim();
    !(value.is_empty() || value == "0" || value.eq_ignore_ascii_case("false"))
}

/// One switch per category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AnalyticsChoices {
    pub launch: bool,
    pub features: bool,
    pub connections: bool,
}

impl AnalyticsChoices {
    pub fn get(&self, category: Category) -> bool {
        match category {
            Category::Launch => self.launch,
            Category::Features => self.features,
            Category::Connections => self.connections,
        }
    }

    fn set(&mut self, category: Category, on: bool) {
        match category {
            Category::Launch => self.launch = on,
            Category::Features => self.features = on,
            Category::Connections => self.connections = on,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsState {
    /// Granted for the current catalogue, as stored; DO_NOT_TRACK is not applied here.
    pub categories: AnalyticsChoices,
    /// Unset, or granted for an older catalogue: what the dialog asks.
    pub pending: Vec<Category>,
    pub do_not_track: bool,
    pub ask_needed: bool,
    pub available: bool,
    /// False while a refusal could not be written to the config yet.
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

fn answer(granted: bool) -> CategoryChoice {
    CategoryChoice {
        consent: if granted {
            Consent::Granted
        } else {
            Consent::Denied
        },
        version: CATALOGUE_VERSION,
    }
}

fn unsaved_writes(st: &State) -> Vec<(Category, CategoryChoice)> {
    Category::ALL
        .into_iter()
        .filter(|c| st.unsaved[c.index()])
        .map(|c| (c, answer(false)))
        .collect()
}

fn current(category: Category, choice: CategoryChoice) -> bool {
    choice.consent == Consent::Granted && choice.version >= changed_in(category)
}

#[derive(Default)]
struct State {
    stored: CategoryChoices,
    recent: VecDeque<(Category, RecentEvent)>,
    session_started: bool,
    started: bool,
    theme: Option<Theme>,
    attempts: HashMap<Attempt, Pending>,
    listed: HashSet<String>,
    /// Refusals in effect in memory whose save failed; written by the next save.
    unsaved: [bool; 3],
    /// The stored choices could not be read: nothing is known, so every gate stays closed and
    /// nothing is asked until a read succeeds.
    unread: bool,
}

impl State {
    fn granted(&self, category: Category) -> bool {
        !self.unread && current(category, self.stored.get(category))
    }

    fn pending(&self) -> Vec<Category> {
        if self.unread {
            return Vec::new();
        }
        Category::ALL
            .into_iter()
            .filter(|&c| {
                let choice = self.stored.get(c);
                choice.consent == Consent::Unset
                    || (choice.consent == Consent::Granted && !current(c, choice))
            })
            .collect()
    }

    /// Everything kept in memory for one category, so turning it off leaves nothing behind.
    fn forget(&mut self, category: Category) {
        self.recent.retain(|(c, _)| *c != category);
        self.attempts.retain(|_, p| p.event.category() != category);
        if category == Category::Features {
            self.listed.clear();
        }
    }
}

struct Inner {
    // Held across a whole change of choices, the save included, so the last change wins both
    // in memory and on disk. Taken before `state`, never the other way.
    consent: Mutex<()>,
    state: Mutex<State>,
    do_not_track: bool,
    system: SystemProps,
    session_id: String,
    outbox: Option<Outbox>,
}

#[derive(Clone)]
pub struct Analytics {
    inner: Arc<Inner>,
}

impl Analytics {
    /// `transport: None` is an unavailable build: the gates and the recent log work, nothing
    /// is ever sent. `do_not_track` closes every gate for the life of this instance.
    pub fn new(
        stored: Option<AnalyticsSettings>,
        system: SystemProps,
        transport: Option<Box<dyn Transport>>,
        do_not_track: bool,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                consent: Mutex::new(()),
                state: Mutex::new(State {
                    stored: stored.unwrap_or_default().categories,
                    ..State::default()
                }),
                do_not_track,
                system,
                // Not numeric: Aptabase reads numeric session ids as timestamps.
                session_id: uuid::Uuid::new_v4().to_string(),
                outbox: transport.map(Outbox::new),
            }),
        }
    }

    /// The stored choices could not be read: see `State::unread`.
    pub fn unread(self) -> Self {
        self.state().unread = true;
        self
    }

    /// The app's instance: the key compiled in, if any, and DO_NOT_TRACK read once. An error
    /// is a config that could not be read, which is not the same as no answer.
    pub fn for_app<E>(stored: Result<Option<AnalyticsSettings>, E>, app_version: &str) -> Self {
        let key = app_key();
        let transport = key
            .and_then(Aptabase::from_key)
            .map(|c| Box::new(c) as Box<dyn Transport>);
        if key.is_some() && transport.is_none() {
            log::warn!("the analytics key is not a supported Aptabase key; nothing will be sent");
        }
        let dnt = do_not_track(std::env::var_os("DO_NOT_TRACK").as_deref());
        if dnt {
            log::info!("DO_NOT_TRACK is set; usage analytics are off for this launch");
        }
        let unread = stored.is_err();
        let analytics = Self::new(
            stored.unwrap_or_default(),
            SystemProps::detect(app_version),
            transport,
            dnt,
        );
        if unread {
            log::warn!("analytics choices could not be read; analytics stay off until they are");
            analytics.unread()
        } else {
            analytics
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn available(&self) -> bool {
        self.inner.outbox.is_some()
    }

    fn open(&self, st: &State, category: Category) -> bool {
        !self.inner.do_not_track && st.granted(category)
    }

    fn view(&self, st: &State) -> AnalyticsState {
        let mut categories = AnalyticsChoices::default();
        for c in Category::ALL {
            categories.set(c, st.granted(c));
        }
        let pending = st.pending();
        AnalyticsState {
            categories,
            ask_needed: !pending.is_empty() && !self.inner.do_not_track,
            pending,
            do_not_track: self.inner.do_not_track,
            available: self.available(),
            persisted: !st.unsaved.contains(&true),
        }
    }

    pub fn status(&self) -> AnalyticsState {
        self.view(&self.state())
    }

    /// Whether events of this category are built right now.
    pub fn collecting(&self, category: Category) -> bool {
        self.open(&self.state(), category)
    }

    fn record_in(&self, st: &mut State, event: Event) {
        let category = event.category();
        if !self.open(st, category) {
            return;
        }
        let now = SystemTime::now();
        let time = system::iso_utc(now);
        let props = event.props();
        st.recent.push_front((
            category,
            RecentEvent {
                time: time.clone(),
                name: event.name(),
                props: props.clone(),
            },
        ));
        st.recent.truncate(MAX_RECENT);
        if let Some(outbox) = &self.inner.outbox {
            outbox.push(
                Envelope {
                    timestamp: time,
                    session_id: self.inner.session_id.clone(),
                    event_name: event.name(),
                    system_props: WireSystem::from(&self.inner.system),
                    props,
                },
                category,
            );
        }
    }

    pub fn record(&self, event: Event) {
        let mut st = self.state();
        self.record_in(&mut st, event);
    }

    /// `session_started` once per launch, as soon as the launch category is open.
    fn session_in(&self, st: &mut State) {
        if !st.session_started && self.open(st, Category::Launch) {
            st.session_started = true;
            self.record_in(st, Event::SessionStarted);
        }
    }

    /// Called once at startup, after the stored choices are known.
    pub fn launched(&self) {
        let mut st = self.state();
        self.session_in(&mut st);
    }

    /// Takes what was read from disk as the stored choices. A category that closes because of
    /// it leaves nothing behind, as if it had been turned off; launch opening starts the
    /// session.
    fn adopt(&self, st: &mut State, stored: AnalyticsSettings) {
        let was = Category::ALL.map(|c| self.open(st, c));
        st.stored = stored.categories;
        st.unread = false;
        for (c, was) in Category::ALL.into_iter().zip(was) {
            if was && !self.open(st, c) {
                st.forget(c);
                if let Some(outbox) = &self.inner.outbox {
                    outbox.discard(c);
                }
            }
        }
        if !was[Category::Launch.index()] {
            self.session_in(st);
        }
    }

    pub fn is_unread(&self) -> bool {
        self.state().unread
    }

    /// Reads the stored choices again if the startup read failed; nothing otherwise.
    pub fn reload<E>(&self, load: impl FnOnce() -> Result<Option<AnalyticsSettings>, E>) {
        let _one = self.inner.consent.lock().unwrap_or_else(|e| e.into_inner());
        if !self.state().unread {
            return;
        }
        if let Ok(stored) = load() {
            let mut st = self.state();
            self.adopt(&mut st, stored.unwrap_or_default());
        }
    }

    /// The dialog: all three answered in one write, each stamped with the current version.
    pub fn set_choices<E>(
        &self,
        choices: AnalyticsChoices,
        persist: impl FnOnce(&[(Category, CategoryChoice)]) -> Result<AnalyticsSettings, E>,
        counts: impl FnOnce() -> Counts,
    ) -> Result<AnalyticsState, E> {
        let changes = Category::ALL.map(|c| (c, choices.get(c)));
        self.change(&changes, persist, counts)
    }

    /// Settings: one category only, so the others keep their answer and its version.
    pub fn set_category<E>(
        &self,
        category: Category,
        granted: bool,
        persist: impl FnOnce(&[(Category, CategoryChoice)]) -> Result<AnalyticsSettings, E>,
        counts: impl FnOnce() -> Counts,
    ) -> Result<AnalyticsState, E> {
        self.change(&[(category, granted)], persist, counts)
    }

    /// Refusals take effect in memory first (log entries, held attempts and unsent events of
    /// that category dropped) and stay in effect for this launch even if they cannot be saved;
    /// `retry_save` writes them later. Grants are saved first and change nothing if that
    /// fails. `persist` applies only the categories it is given on top of what the file holds
    /// and returns the result, which becomes the in-memory value: a category not asked about
    /// is never overwritten with what memory believed. Calls are serialized, save included.
    fn change<E>(
        &self,
        changes: &[(Category, bool)],
        persist: impl FnOnce(&[(Category, CategoryChoice)]) -> Result<AnalyticsSettings, E>,
        counts: impl FnOnce() -> Counts,
    ) -> Result<AnalyticsState, E> {
        let _one = self.inner.consent.lock().unwrap_or_else(|e| e.into_inner());
        let writes = {
            let mut st = self.state();
            for &(category, granted) in changes {
                if !granted {
                    st.stored.set(category, answer(false));
                    st.unsaved[category.index()] = true;
                    st.forget(category);
                    if let Some(outbox) = &self.inner.outbox {
                        outbox.discard(category);
                    }
                }
            }
            let mut writes = unsaved_writes(&st);
            writes.retain(|(c, _)| !changes.iter().any(|(asked, _)| asked == c));
            writes.extend(changes.iter().map(|&(c, granted)| (c, answer(granted))));
            writes
        };
        let grants = |category| changes.iter().any(|&(c, g)| g && c == category);
        let counts = (grants(Category::Features) && !self.state().started).then(counts);
        let saved = persist(&writes)?;
        let mut st = self.state();
        st.unsaved = [false; 3];
        self.adopt(&mut st, saved);
        if let (false, Some(theme), Some(counts)) = (st.started, st.theme, counts)
            && self.open(&st, Category::Features)
        {
            st.started = true;
            self.record_in(&mut st, Event::app_started(theme, counts));
        }
        Ok(self.view(&st))
    }

    /// Writes refusals whose save failed earlier; called on the flush tick and at exit.
    pub fn retry_save<E>(
        &self,
        persist: impl FnOnce(&[(Category, CategoryChoice)]) -> Result<AnalyticsSettings, E>,
    ) {
        let _one = self.inner.consent.lock().unwrap_or_else(|e| e.into_inner());
        let writes = unsaved_writes(&self.state());
        if writes.is_empty() {
            return;
        }
        if let Ok(saved) = persist(&writes) {
            let mut st = self.state();
            st.unsaved = [false; 3];
            self.adopt(&mut st, saved);
        }
    }

    /// Emits `app_started` once per launch. While feature usage is off only the theme is kept,
    /// so the event can follow a later grant.
    pub fn app_started(&self, theme: Theme, counts: impl FnOnce() -> Counts) {
        let needed = {
            let mut st = self.state();
            st.theme = Some(theme);
            !st.started && self.open(&st, Category::Features)
        };
        if !needed {
            return;
        }
        // Read outside the lock: it loads the config file.
        let counts = counts();
        let mut st = self.state();
        if st.started || !self.open(&st, Category::Features) {
            return;
        }
        st.started = true;
        self.record_in(&mut st, Event::app_started(theme, counts));
    }

    pub fn recent(&self) -> Recent {
        let st = self.state();
        let events = st
            .recent
            .iter()
            .filter(|(c, _)| self.open(&st, *c))
            .map(|(_, e)| e.clone())
            .collect();
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
        if !self.open(&st, abandoned.category()) {
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
        if self.open(&st, Category::Features) && st.listed.insert(connection_id.to_owned()) {
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

    /// Every category granted, keyless: what was recorded is read back with `recorded`.
    #[cfg(test)]
    pub fn granted_for_tests() -> Self {
        let stored = AnalyticsSettings {
            categories: CategoryChoices::all(CategoryChoice {
                consent: Consent::Granted,
                version: CATALOGUE_VERSION,
            }),
        };
        let system = SystemProps {
            app_version: "0".into(),
            os: "test".into(),
            os_version: "0".into(),
            locale: String::new(),
        };
        Self::new(Some(stored), system, None, false)
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
    fn stored_for_tests(&self) -> CategoryChoices {
        self.state().stored
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
