//! Crash reports from Rust panics. The hook maps the panic location, message and thread to
//! codes from closed lists; none of those strings is kept or sent. The only free-form values in
//! a report are the source line (checked to be `src/<path>.rs:<n>` of this crate) and a random
//! session id of its own, so a report cannot be joined with the usage events of the same launch.

use std::cell::Cell;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{self, Write};
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use super::client::{MAX_TRIES, Posted, SDK_VERSION, Transport, sending, while_sending};
use super::event::{Prop, Props};
use super::system::{self, SystemProps};
use super::{RecentEvent, next_seq};
use crate::fsutil;

/// Distinct reports per session; later ones are dropped until the next launch.
pub const MAX_DISTINCT: usize = 20;
pub const MAX_QUEUED: usize = 25;
/// How long a fatal crash may hold the dying process to send its report.
pub const FATAL_SEND: Duration = Duration::from_secs(2);
pub const PENDING_FILE: &str = "pending-crash.json";
const PENDING_TMP: &str = "pending-crash.json.tmp";
const MAX_PENDING_BYTES: u64 = 4096;
const MAX_LINE_CHARS: usize = 120;
const LOCK_POLL: Duration = Duration::from_millis(20);
/// How long a fatal crash waits for another use of the pending file to finish.
const FILE_WAIT: Duration = Duration::from_millis(200);
const PLATFORM: &str = "Tauri";

#[cfg(test)]
type FatalStep = Box<dyn Fn(&str) + Send>;

/// Top-level modules of this crate: `src/<name>.rs` or `src/<name>/`.
pub const OWN_AREAS: &[&str] = &[
    "analytics",
    "commands",
    "config",
    "data_transfer",
    "external",
    "files",
    "fsutil",
    "keys",
    "localfs",
    "quit",
    "secrets",
    "sftp",
    "ssh",
    "terminal",
    "transfer",
    "vars",
    "lib",
    "main",
];
pub const DEPENDENCY_AREAS: &[&str] = &[
    "russh",
    "russh-sftp",
    "tokio",
    "tauri",
    "ureq",
    "keyring",
    "serde",
    "ssh-key",
    "rustls",
    "notify",
];
pub const STD: &str = "std";
pub const DEPENDENCY: &str = "dependency";
pub const UNKNOWN: &str = "unknown";

pub const WHATS: &[&str] = &[
    "unwrap_none",
    "unwrap_err",
    "index",
    "overflow",
    "div_zero",
    "borrow",
    "poisoned",
    "capacity",
    "unreachable",
    "todo",
    "assert",
    "other",
];

/// Every area a report can name.
pub fn areas() -> impl Iterator<Item = &'static str> {
    OWN_AREAS
        .iter()
        .chain(DEPENDENCY_AREAS)
        .copied()
        .chain([STD, DEPENDENCY, UNKNOWN])
}

fn listed(list: &'static [&'static str], name: &str) -> Option<&'static str> {
    list.iter().copied().find(|a| *a == name)
}

/// `name-1.2.3` (registry) to `name`: the version starts at the first `-` followed by a digit.
fn without_version(dir: &str) -> &str {
    let b = dir.as_bytes();
    (0..b.len())
        .find(|&i| b[i] == b'-' && b.get(i + 1).is_some_and(u8::is_ascii_digit))
        .map_or(dir, |i| &dir[..i])
}

/// The crate a dependency path belongs to, from the cargo registry or git checkout layout.
fn dependency_crate(path: &str) -> Option<&str> {
    if let Some((_, rest)) = path.split_once("/registry/src/") {
        let mut parts = rest.split('/');
        parts.next()?;
        return Some(without_version(parts.next()?)).filter(|n| !n.is_empty());
    }
    let (_, rest) = path.split_once("/git/checkouts/")?;
    let dir = rest.split('/').next()?;
    let (name, _hash) = dir.rsplit_once('-')?;
    Some(name).filter(|n| !n.is_empty())
}

fn dependency_area(name: &str) -> &'static str {
    let name = match name {
        "tao" | "wry" => "tauri",
        n if n.starts_with("tauri-") => "tauri",
        "serde_json" | "serde_core" => "serde",
        n => n,
    };
    listed(DEPENDENCY_AREAS, name).unwrap_or(DEPENDENCY)
}

fn is_std(path: &str) -> bool {
    let toolchain = path.starts_with("/rustc/") || path.contains("/rustlib/src/rust/");
    toolchain
        && ["/library/std/", "/library/core/", "/library/alloc/"]
            .iter()
            .any(|l| path.contains(l))
}

/// The area of a panic location: a module of this crate (its paths are relative to the crate),
/// a listed dependency, `std`, another `dependency`, or `unknown`.
pub fn area_of(file: Option<&str>) -> &'static str {
    let Some(file) = file else {
        return UNKNOWN;
    };
    let path = file.replace('\\', "/");
    if let Some(rest) = path.strip_prefix("src/") {
        let first = rest.split('/').next().unwrap_or("");
        let name = first.strip_suffix(".rs").unwrap_or(first);
        return listed(OWN_AREAS, name).unwrap_or(UNKNOWN);
    }
    if let Some(name) = dependency_crate(&path) {
        return dependency_area(name);
    }
    if is_std(&path) {
        return STD;
    }
    UNKNOWN
}

/// A fixed code for what went wrong, from the start of the panic message. The message itself
/// is never kept: custom texts (`expect("…")`, `panic!("…")`) are all `other`.
pub fn what_of(message: Option<&str>) -> &'static str {
    let Some(m) = message else {
        return "other";
    };
    if m.contains("PoisonError") {
        return "poisoned";
    }
    let starts = |prefixes: &[&str]| prefixes.iter().any(|p| m.starts_with(p));
    if starts(&["called `Option::unwrap()` on a `None` value"]) {
        "unwrap_none"
    } else if starts(&["called `Result::unwrap()` on an `Err` value"]) {
        "unwrap_err"
    } else if starts(&[
        "index out of bounds",
        "range end index",
        "range start index",
        "byte index",
    ]) {
        "index"
    } else if starts(&[
        "attempt to divide by zero",
        "attempt to calculate the remainder with a divisor of zero",
    ]) {
        "div_zero"
    } else if m.starts_with("attempt to ") && m.ends_with("with overflow") {
        "overflow"
    } else if starts(&[
        "already borrowed",
        "already mutably borrowed",
        "RefCell already",
    ]) {
        "borrow"
    } else if starts(&["capacity overflow"]) {
        "capacity"
    } else if starts(&["internal error: entered unreachable code"]) {
        "unreachable"
    } else if starts(&["not yet implemented"]) {
        "todo"
    } else if starts(&["assertion failed", "assertion `left"]) {
        "assert"
    } else {
        "other"
    }
}

/// `src/<dir>/<file>.rs:<n>` for a location in this crate, else nothing: dependency and std
/// paths name the build machine and are never sent.
pub fn line_of(file: Option<&str>, line: u32) -> Option<String> {
    let path = file?.replace('\\', "/");
    if !OWN_AREAS.contains(&area_of(Some(&path))) || !source_path(&path) || line == 0 {
        return None;
    }
    Some(format!("{path}:{line}")).filter(|l| l.len() <= MAX_LINE_CHARS)
}

fn source_path(path: &str) -> bool {
    let Some(rest) = path
        .strip_prefix("src/")
        .and_then(|r| r.strip_suffix(".rs"))
    else {
        return false;
    };
    rest.split('/').all(|seg| {
        !seg.is_empty()
            && seg
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
    })
}

fn valid_line(line: &str) -> bool {
    let Some((path, n)) = line.rsplit_once(':') else {
        return false;
    };
    let number = !n.is_empty() && n.len() <= 7 && n.bytes().all(|c| c.is_ascii_digit());
    number && n != "0" && line_of(Some(path), n.parse().unwrap_or(0)).as_deref() == Some(line)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Fatal,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Crash,
    Unhandled,
    TaskException,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fatal => "fatal",
            Self::Error => "error",
        }
    }
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Crash => "crash",
            Self::Unhandled => "unhandled",
            Self::TaskException => "taskException",
        }
    }
}

/// From the panicking thread: the main thread runs the event loop, and a panic there ends the
/// process; the async runtime's workers (named by tokio) catch it as a failed task.
pub fn kind_of(thread: Option<&str>) -> (Severity, Kind) {
    match thread {
        Some("main") => (Severity::Fatal, Kind::Crash),
        Some("tokio-runtime-worker") => (Severity::Error, Kind::TaskException),
        _ => (Severity::Error, Kind::Unhandled),
    }
}

/// What the hook reads from a panic; only the codes derived from it are kept.
#[derive(Debug, Clone, Copy, Default)]
pub struct Site<'a> {
    pub file: Option<&'a str>,
    pub line: u32,
    pub message: Option<&'a str>,
    pub thread: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub area: &'static str,
    pub what: &'static str,
    pub line: Option<String>,
    pub severity: Severity,
    pub kind: Kind,
    pub time: String,
    pub session_id: String,
    pub app_version: String,
    pub os: String,
    pub os_version: String,
}

/// The request body of `POST /api/v0/error`. The line goes in `stackTrace`, the only field
/// meant for a location; there is no locale, message or trace text.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Wire<'a> {
    error_type: String,
    error_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stack_trace: Option<&'a str>,
    timestamp: &'a str,
    session_id: &'a str,
    platform: &'static str,
    os_name: &'a str,
    os_version: &'a str,
    app_version: &'a str,
    sdk_version: &'static str,
    severity: Severity,
    kind: Kind,
    is_debug: bool,
}

/// `pending-crash.json`: the report of a fatal crash, sent at the next launch.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    #[serde(rename = "type")]
    error_type: String,
    message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    severity: Severity,
    kind: Kind,
    time: String,
    session: String,
    app_version: String,
    os: String,
    os_version: String,
}

/// `1.2.3` or `1.2.3-beta.1`: what the package version can be.
fn valid_app_version(v: &str) -> bool {
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let numbers = parts.len() == 3
        && parts
            .iter()
            .all(|p| (1..=5).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_digit()));
    let pre = pre.is_none_or(|p| {
        (1..=20).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.')
    });
    numbers && pre
}

/// Dot-separated numbers (at most 4 parts of at most 10 digits), `rolling` or `unknown`: the
/// only values `system::os_version` produces.
fn valid_os_version(v: &str) -> bool {
    if v == "rolling" || v == "unknown" {
        return true;
    }
    let parts: Vec<&str> = v.split('.').collect();
    v.len() <= 32
        && parts.len() <= 4
        && parts
            .iter()
            .all(|p| (1..=10).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_digit()))
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, as `system::iso_utc` writes it.
fn valid_time(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 24
        && b.iter().enumerate().all(|(i, &c)| match i {
            4 | 7 => c == b'-',
            10 => c == b'T',
            13 | 16 => c == b':',
            19 => c == b'.',
            23 => c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

impl Report {
    pub fn error_type(&self) -> String {
        format!("panic:{}", self.area)
    }

    pub fn error_message(&self) -> String {
        format!("panic:{}:{}", self.area, self.what)
    }

    fn key(&self) -> (&'static str, &'static str, Option<String>, Kind) {
        (self.area, self.what, self.line.clone(), self.kind)
    }

    pub fn body(&self) -> Vec<u8> {
        serde_json::to_vec(&Wire {
            error_type: self.error_type(),
            error_message: self.error_message(),
            stack_trace: self.line.as_deref(),
            timestamp: &self.time,
            session_id: &self.session_id,
            platform: PLATFORM,
            os_name: &self.os,
            os_version: &self.os_version,
            app_version: &self.app_version,
            sdk_version: SDK_VERSION,
            severity: self.severity,
            kind: self.kind,
            is_debug: false,
        })
        .unwrap_or_default()
    }

    /// The recent events row: the body's fields that are not in the shared system list.
    pub fn row(&self, previous_launch: bool, seq: u64) -> RecentEvent {
        let mut props = vec![
            ("type", Prop::Text(self.error_type())),
            ("message", Prop::Text(self.error_message())),
            ("kind", Prop::Str(self.kind.as_str())),
            ("severity", Prop::Str(self.severity.as_str())),
        ];
        if let Some(line) = &self.line {
            props.push(("line", Prop::Text(line.clone())));
        }
        props.push(("session", Prop::Text(self.session_id.clone())));
        RecentEvent {
            time: self.time.clone(),
            name: "crash",
            props: Props(props),
            previous_launch,
            seq,
        }
    }

    fn to_file(&self) -> Vec<u8> {
        serde_json::to_vec(&Saved {
            error_type: self.error_type(),
            message: self.error_message(),
            line: self.line.clone(),
            severity: self.severity,
            kind: self.kind,
            time: self.time.clone(),
            session: self.session_id.clone(),
            app_version: self.app_version.clone(),
            os: self.os.clone(),
            os_version: self.os_version.clone(),
        })
        .unwrap_or_default()
    }

    /// The file is outside the process: each field must come from a closed list (area, cause,
    /// severity, kind, and the OS name, which must be `os`, this machine's) or match a strict
    /// format (line, time, UUID, version numbers), so a hand-written file cannot make the app
    /// send any text of its own.
    pub fn from_file(raw: &[u8], os: &str) -> Option<Self> {
        let s: Saved = serde_json::from_slice(raw).ok()?;
        let area = areas().find(|a| s.error_type == format!("panic:{a}"))?;
        let what = WHATS
            .iter()
            .copied()
            .find(|w| s.message == format!("panic:{area}:{w}"))?;
        if let Some(line) = &s.line
            && (!valid_line(line) || area_of(line.rsplit_once(':').map(|(p, _)| p)) != area)
        {
            return None;
        }
        let session = uuid::Uuid::parse_str(&s.session)
            .ok()?
            .hyphenated()
            .to_string();
        let ok = valid_time(&s.time)
            && session == s.session
            && valid_app_version(&s.app_version)
            && s.os == os
            && valid_os_version(&s.os_version);
        ok.then_some(Self {
            area,
            what,
            line: s.line,
            severity: s.severity,
            kind: s.kind,
            time: s.time,
            session_id: s.session,
            app_version: s.app_version,
            os: s.os,
            os_version: s.os_version,
        })
    }
}

struct Queued {
    report: Report,
    /// `Log::generation` when queued; an older one means crash reports were turned off since.
    generation: u64,
    tries: u8,
    /// Read from `pending-crash.json`, which is removed once this report is done with.
    from_file: bool,
}

#[derive(Default)]
struct Log {
    seen: HashSet<(&'static str, &'static str, Option<String>, Kind)>,
    /// Oldest first, each with `true` for a report of the previous launch and its `next_seq`.
    rows: Vec<(Report, bool, u64)>,
    queue: VecDeque<Queued>,
    generation: u64,
}

impl Log {
    /// The first occurrence of each report, up to `MAX_DISTINCT` per session.
    fn admit(&mut self, report: &Report, queue: bool) -> bool {
        let key = report.key();
        if self.seen.contains(&key) || self.seen.len() >= MAX_DISTINCT {
            return false;
        }
        self.seen.insert(key);
        self.rows.push((report.clone(), false, next_seq()));
        if queue && self.queue.len() < MAX_QUEUED {
            self.queue.push_back(Queued {
                report: report.clone(),
                generation: self.generation,
                tries: 0,
                from_file: false,
            });
        }
        true
    }
}

pub struct Crashes {
    /// Crash reports granted and DO_NOT_TRACK unset, mirrored from the analytics state so the
    /// hook never takes its lock: the panic may have happened while it was held.
    armed: AtomicBool,
    log: Mutex<Log>,
    session_id: String,
    system: SystemProps,
    transport: Option<Arc<dyn Transport>>,
    dir: OnceLock<PathBuf>,
    flushing: Mutex<()>,
    stopping: AtomicBool,
    resumed: AtomicBool,
    /// Every use of the pending files; the hook only polls it with `try_lock`, for `FILE_WAIT`.
    files: Mutex<()>,
    /// Runs at each step of a fatal report (`"write"`, `"post"`), before its gate check.
    #[cfg(test)]
    pub fatal_step: Mutex<Option<FatalStep>>,
}

impl Crashes {
    pub fn new(system: SystemProps, transport: Option<Arc<dyn Transport>>) -> Self {
        Self {
            armed: AtomicBool::new(false),
            log: Mutex::default(),
            session_id: uuid::Uuid::new_v4().to_string(),
            system,
            transport,
            dir: OnceLock::new(),
            flushing: Mutex::new(()),
            stopping: AtomicBool::new(false),
            resumed: AtomicBool::new(false),
            files: Mutex::new(()),
            #[cfg(test)]
            fatal_step: Mutex::new(None),
        }
    }

    fn files(&self) -> MutexGuard<'_, ()> {
        self.files.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Removes the pending file and a temp file left by an interrupted write.
    fn remove_files(&self, dir: &Path) {
        let _ = fs::remove_file(dir.join(PENDING_FILE));
        let _ = fs::remove_file(dir.join(PENDING_TMP));
    }

    fn log(&self) -> MutexGuard<'_, Log> {
        self.log.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_armed(&self, on: bool) {
        self.armed.store(on, Ordering::SeqCst);
    }

    pub fn armed(&self) -> bool {
        self.armed.load(Ordering::SeqCst)
    }

    /// Where `pending-crash.json` lives; without it a fatal crash is only sent while dying.
    pub fn set_dir(&self, dir: PathBuf) {
        let _ = self.dir.set(dir);
    }

    fn pending_path(&self) -> Option<PathBuf> {
        self.dir.get().map(|d| d.join(PENDING_FILE))
    }

    pub fn report(&self, site: &Site<'_>) -> Report {
        let (severity, kind) = kind_of(site.thread);
        Report {
            area: area_of(site.file),
            what: what_of(site.message),
            line: line_of(site.file, site.line),
            severity,
            kind,
            time: system::iso_utc(SystemTime::now()),
            session_id: self.session_id.clone(),
            app_version: self.system.app_version.clone(),
            os: self.system.os.clone(),
            os_version: self.system.os_version.clone(),
        }
    }

    /// Called from the panic hook. Never blocks on a lock: on contention the report is lost.
    pub fn capture(&self, site: &Site<'_>) {
        if !self.armed() {
            return;
        }
        let report = self.report(site);
        let fatal = report.severity == Severity::Fatal;
        let log = match self.log.try_lock() {
            Ok(g) => Some(g),
            Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        };
        let Some(mut log) = log else {
            return;
        };
        // Checked again under the lock: turning crash reports off clears the gate before it
        // empties the log.
        if self.armed() && log.admit(&report, !fatal && self.transport.is_some()) && fatal {
            // The guard is held throughout, so a revoke waits for this report, then deletes
            // its file. The hook never takes the analytics state lock.
            self.fatal(&report);
        }
        drop(log);
    }

    #[cfg(test)]
    fn step(&self, name: &str) {
        if let Some(f) = self.fatal_step.lock().unwrap().as_ref() {
            f(name);
        }
    }

    #[cfg(not(test))]
    fn step(&self, _name: &str) {}

    /// The process ends right after the hook: the report is saved for the next launch, then
    /// one send is tried within `FATAL_SEND`. A panic inside a request (or during the exit
    /// flush) only saves it: the transport may be the thing that broke.
    fn fatal(&self, report: &Report) {
        let Some(transport) = &self.transport else {
            return;
        };
        let files = poll_lock(&self.files, Instant::now() + FILE_WAIT);
        self.step("write");
        if !self.armed() {
            return;
        }
        let saved = match (&files, self.dir.get()) {
            (Some(_), Some(dir)) => write_pending(dir, &report.to_file()).is_ok(),
            _ => false,
        };
        if sending() || self.stopping.load(Ordering::SeqCst) {
            return;
        }
        self.step("post");
        if !self.armed() {
            return;
        }
        let posted = while_sending(|| transport.post_error(&report.body(), FATAL_SEND));
        if saved && posted != Posted::Retry {
            self.remove_pending_locked(report);
        }
        drop(files);
    }

    /// Crash reports turned off: nothing captured so far is kept, sent or left on disk. The
    /// gate must be closed first.
    pub fn discard(&self) {
        {
            let mut log = self.log();
            log.seen.clear();
            log.rows.clear();
            log.queue.clear();
            log.generation += 1;
        }
        if let Some(dir) = self.dir.get() {
            let _files = self.files();
            self.remove_files(dir);
        }
    }

    /// Once per launch, when the choices are known: the report a fatal crash left is queued if
    /// crash reports are on (and this build can send), deleted otherwise.
    pub fn resume(&self) {
        let Some(path) = self.pending_path() else {
            return;
        };
        if self.resumed.swap(true, Ordering::SeqCst) {
            return;
        }
        let files = self.files();
        let read = fsutil::read_regular_capped(&path, MAX_PENDING_BYTES, false);
        let report = match read {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if let Some(dir) = self.dir.get() {
                    let _ = fs::remove_file(dir.join(PENDING_TMP));
                }
                return;
            }
            Err(_) => None,
            Ok(raw) => Report::from_file(&raw, &self.system.os),
        };
        drop(files);
        let mut log = self.log();
        match report {
            Some(report) if self.armed() && self.transport.is_some() => {
                log.rows.push((report.clone(), true, 0));
                let generation = log.generation;
                log.queue.push_back(Queued {
                    report,
                    generation,
                    tries: 0,
                    from_file: true,
                });
            }
            _ => {
                drop(log);
                if let Some(dir) = self.dir.get() {
                    let _files = self.files();
                    self.remove_files(dir);
                }
            }
        }
    }

    /// Removes the pending file only if it still holds this report: a later fatal crash may
    /// have replaced it. The file lock keeps a fatal crash of this process from writing in
    /// between.
    fn remove_pending_if(&self, report: &Report) {
        let _files = self.files();
        self.remove_pending_locked(report);
    }

    fn remove_pending_locked(&self, report: &Report) {
        let Some(path) = self.pending_path() else {
            return;
        };
        let held = fsutil::read_regular_capped(&path, MAX_PENDING_BYTES, false)
            .ok()
            .and_then(|raw| Report::from_file(&raw, &self.system.os));
        if held.as_ref() == Some(report) {
            let _ = fs::remove_file(&path);
        }
    }

    /// Newest first.
    pub fn rows(&self) -> Vec<RecentEvent> {
        self.log()
            .rows
            .iter()
            .rev()
            .map(|(r, previous, seq)| r.row(*previous, *seq))
            .collect()
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }

    /// One report per request until the queue is empty, one must wait, `deadline` passes or a
    /// stop is asked. 408, 429, 5xx and network errors are retried on a later flush (at most
    /// `MAX_TRIES` in all); anything else is final.
    pub fn flush(&self, deadline: Instant) {
        let Some(transport) = &self.transport else {
            return;
        };
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
        let stopping = self.stopping.load(Ordering::SeqCst);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || (!stopping && self.stopping.load(Ordering::SeqCst)) {
                break;
            }
            let (item, body) = {
                let mut log = self.log();
                let Some(item) = log.queue.pop_front() else {
                    break;
                };
                if item.generation != log.generation {
                    continue;
                }
                let body = item.report.body();
                (item, body)
            };
            match while_sending(|| transport.post_error(&body, left)) {
                Posted::Sent | Posted::Rejected => {
                    if item.from_file {
                        self.remove_pending_if(&item.report);
                    }
                }
                Posted::Retry => {
                    let tries = item.tries + 1;
                    if tries < MAX_TRIES {
                        let mut log = self.log();
                        if item.generation == log.generation {
                            log.queue.push_front(Queued { tries, ..item });
                        }
                    } else if item.from_file {
                        self.remove_pending_if(&item.report);
                    }
                    break;
                }
            }
        }
    }

    #[cfg(test)]
    pub fn queued(&self) -> usize {
        self.log().queue.len()
    }
}

/// The lock, polled until `deadline`; `None` if it stays taken (possibly by this very thread).
fn poll_lock<T>(m: &Mutex<T>, deadline: Instant) -> Option<MutexGuard<'_, T>> {
    loop {
        match m.try_lock() {
            Ok(g) => return Some(g),
            Err(TryLockError::Poisoned(e)) => return Some(e.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(LOCK_POLL);
            }
            Err(TryLockError::WouldBlock) => return None,
        }
    }
}

/// Atomic and owner-only from creation: a temp file created exclusively, synced, then renamed
/// over the previous report.
fn write_pending(dir: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = dir.join(PENDING_TMP);
    let _ = fs::remove_file(&tmp);
    let written = fsutil::create_owner_only(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    });
    let done = written.and_then(|()| fs::rename(&tmp, dir.join(PENDING_FILE)));
    if done.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    done
}

thread_local! {
    static IN_HOOK: Cell<bool> = const { Cell::new(false) };
}

/// Reads the panic and hands it to `f`, unless this thread is already inside the hook.
fn observe(info: &PanicHookInfo<'_>, f: impl FnOnce(&Site<'_>)) {
    if IN_HOOK.try_with(|c| c.replace(true)).unwrap_or(true) {
        return;
    }
    let thread = std::thread::current();
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str));
    let site = Site {
        file: info.location().map(|l| l.file()),
        line: info.location().map_or(0, |l| l.line()),
        message,
        thread: thread.name(),
    };
    f(&site);
    let _ = IN_HOOK.try_with(|c| c.set(false));
}

/// Installs the hook once for the process, in front of the one already set (the default hook
/// still prints the panic locally).
pub fn install(crashes: Arc<Crashes>) {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        observe(info, |site| crashes.capture(site));
        previous(info);
    }));
}

#[cfg(test)]
thread_local! {
    static TEST_TARGET: std::cell::RefCell<Option<Arc<Crashes>>> = const {
        std::cell::RefCell::new(None)
    };
}

/// The test binary's hook: a panic goes to the `Crashes` the panicking thread named with
/// `target_for_tests`, so tests running in parallel never see each other's panics.
#[cfg(test)]
pub fn install_for_tests() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let target = TEST_TARGET.try_with(|t| t.borrow().clone()).ok().flatten();
            if let Some(crashes) = target {
                observe(info, |site| crashes.capture(site));
            }
            previous(info);
        }));
    });
}

#[cfg(test)]
pub fn target_for_tests(crashes: Arc<Crashes>) {
    TEST_TARGET.with(|t| *t.borrow_mut() = Some(crashes));
}

#[cfg(test)]
mod tests;
