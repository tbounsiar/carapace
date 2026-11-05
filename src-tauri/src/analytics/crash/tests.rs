use std::collections::VecDeque;
use std::thread;

use super::*;

fn system() -> SystemProps {
    SystemProps {
        app_version: "0.2.0".into(),
        os: "Windows".into(),
        os_version: "10.0.26300".into(),
        locale: "fr-FR".into(),
    }
}

/// Records each crash report body and answers from a script, then with `fallback`.
#[derive(Clone)]
struct Errors {
    bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    script: Arc<Mutex<VecDeque<Posted>>>,
    fallback: Posted,
}

impl Errors {
    fn new(fallback: Posted) -> Self {
        Self {
            bodies: Arc::default(),
            script: Arc::default(),
            fallback,
        }
    }

    fn then(self, answers: &[Posted]) -> Self {
        self.script.lock().unwrap().extend(answers);
        self
    }

    fn sent(&self) -> Vec<serde_json::Value> {
        self.bodies.lock().unwrap().clone()
    }
}

impl Transport for Errors {
    fn post(&self, _body: &[u8], _timeout: Duration) -> Posted {
        panic!("a crash report went to the events endpoint")
    }

    fn post_error(&self, body: &[u8], _timeout: Duration) -> Posted {
        self.bodies
            .lock()
            .unwrap()
            .push(serde_json::from_slice(body).unwrap());
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(self.fallback)
    }
}

fn armed(transport: Option<Errors>) -> Arc<Crashes> {
    let c = Arc::new(Crashes::new(
        system(),
        transport.map(|t| Arc::new(t) as Arc<dyn Transport>),
    ));
    c.set_armed(true);
    c
}

fn site<'a>(file: &'a str, line: u32, message: &'a str, thread: &'a str) -> Site<'a> {
    Site {
        file: Some(file),
        line,
        message: Some(message),
        thread: Some(thread),
    }
}

const UNWRAP_NONE: &str = "called `Option::unwrap()` on a `None` value";

fn later() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

#[test]
fn every_top_level_module_has_an_area() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = Vec::new();
    for entry in fs::read_dir(&src).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        let module = if entry.file_type().unwrap().is_dir() {
            name
        } else if let Some(stem) = name.strip_suffix(".rs") {
            stem.to_owned()
        } else {
            continue;
        };
        assert!(
            OWN_AREAS.contains(&module.as_str()),
            "src/{module} has no crash area: add it to OWN_AREAS"
        );
        found.push(module);
    }
    for area in OWN_AREAS {
        assert!(found.iter().any(|m| m == area), "{area} is not in src/");
    }
}

#[test]
fn areas_come_from_the_location() {
    let cases = [
        (Some("src/ssh/manager.rs"), "ssh"),
        (Some("src\\sftp\\manager\\edit.rs"), "sftp"),
        (Some("src/lib.rs"), "lib"),
        (Some("src/secrets.rs"), "secrets"),
        (Some("src/main.rs"), "main"),
        (Some("src/newmodule/x.rs"), UNKNOWN),
        (
            Some(
                "C:\\Users\\jdoe\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\russh-0.65.0\\src\\client\\mod.rs",
            ),
            "russh",
        ),
        (
            Some(
                "/home/jdoe/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/russh-sftp-3.0.1/src/client/mod.rs",
            ),
            "russh-sftp",
        ),
        (
            Some("/c/registry/src/i/tokio-1.54.1/src/runtime/task/harness.rs"),
            "tokio",
        ),
        (Some("/c/registry/src/i/tauri-2.12.5/src/app.rs"), "tauri"),
        (
            Some("/c/registry/src/i/tauri-runtime-wry-2.1.0/src/lib.rs"),
            "tauri",
        ),
        (Some("/c/registry/src/i/tao-0.34.0/src/lib.rs"), "tauri"),
        (Some("/c/registry/src/i/wry-0.53.0/src/lib.rs"), "tauri"),
        (
            Some("/c/registry/src/i/tauri-2.0.0-rc.1/src/app.rs"),
            "tauri",
        ),
        (Some("/c/registry/src/i/ureq-3.1.0/src/lib.rs"), "ureq"),
        (
            Some("/c/registry/src/i/keyring-4.2.0/src/lib.rs"),
            "keyring",
        ),
        (
            Some("/c/registry/src/i/serde_json-1.0.140/src/de.rs"),
            "serde",
        ),
        (Some("/c/registry/src/i/serde-1.0.228/src/de.rs"), "serde"),
        (
            Some("/c/registry/src/i/ssh-key-0.6.7/src/lib.rs"),
            "ssh-key",
        ),
        (Some("/c/registry/src/i/rustls-0.23.0/src/lib.rs"), "rustls"),
        (Some("/c/registry/src/i/notify-8.2.1/src/lib.rs"), "notify"),
        (
            Some("/c/registry/src/i/x25519-dalek-2.0.1/src/lib.rs"),
            DEPENDENCY,
        ),
        (Some("/c/registry/src/i/sha2-0.11.1/src/lib.rs"), DEPENDENCY),
        (
            Some("/c/git/checkouts/russh-0123456789abcdef/a1b2c3d/russh/src/lib.rs"),
            "russh",
        ),
        (
            Some("/rustc/17067e9ac6d7e98f18d4e1e4ad1b8f1b5e8f9a10/library/core/src/option.rs"),
            STD,
        ),
        (
            Some("/rustc/17067e9ac6d7e98f18d4e1e4ad1b8f1b5e8f9a10/library/std/src/thread/mod.rs"),
            STD,
        ),
        (
            Some(
                "C:\\Users\\jdoe\\.rustup\\toolchains\\stable\\lib\\rustlib\\src\\rust\\library\\alloc\\src\\vec.rs",
            ),
            STD,
        ),
        (Some("/rustc/abc/compiler/x.rs"), UNKNOWN),
        (Some("/home/jdoe/project/build/out/x.rs"), UNKNOWN),
        (Some(""), UNKNOWN),
        (None, UNKNOWN),
    ];
    for (file, area) in cases {
        assert_eq!(area_of(file), area, "{file:?}");
        assert!(areas().any(|a| a == area));
    }
}

#[test]
fn causes_come_from_a_closed_prefix_list() {
    let cases = [
        (UNWRAP_NONE, "unwrap_none"),
        (
            "called `Result::unwrap()` on an `Err` value: Os { code: 2 }",
            "unwrap_err",
        ),
        (
            "called `Result::unwrap()` on an `Err` value: PoisonError { .. }",
            "poisoned",
        ),
        (
            "index out of bounds: the len is 3 but the index is 7",
            "index",
        ),
        (
            "range end index 9 out of range for slice of length 3",
            "index",
        ),
        ("range start index 4 out of range", "index"),
        ("byte index 2 is not a char boundary", "index"),
        ("attempt to add with overflow", "overflow"),
        ("attempt to shift left with overflow", "overflow"),
        ("attempt to divide by zero", "div_zero"),
        (
            "attempt to calculate the remainder with a divisor of zero",
            "div_zero",
        ),
        ("already borrowed: BorrowMutError", "borrow"),
        ("already mutably borrowed: BorrowError", "borrow"),
        ("RefCell already borrowed", "borrow"),
        ("capacity overflow", "capacity"),
        ("internal error: entered unreachable code", "unreachable"),
        (
            "internal error: entered unreachable code: host srv01",
            "unreachable",
        ),
        ("not yet implemented", "todo"),
        ("assertion failed: x > 0", "assert"),
        ("assertion `left == right` failed", "assert"),
        ("connection to jdoe@srv01 lost", "other"),
        ("the key file C:\\Users\\jdoe\\.ssh\\id is bad", "other"),
        ("", "other"),
        (" index out of bounds", "other"),
    ];
    for (message, what) in cases {
        assert_eq!(what_of(Some(message)), what, "{message}");
        assert!(WHATS.contains(&what));
    }
    assert_eq!(what_of(None), "other");
}

#[test]
fn lines_are_sent_only_for_this_crate() {
    assert_eq!(
        line_of(Some("src/ssh/session.rs"), 214).as_deref(),
        Some("src/ssh/session.rs:214")
    );
    assert_eq!(
        line_of(Some("src\\sftp\\manager\\edit.rs"), 3).as_deref(),
        Some("src/sftp/manager/edit.rs:3")
    );
    assert_eq!(
        line_of(Some("src/lib.rs"), 1).as_deref(),
        Some("src/lib.rs:1")
    );
    for (file, line) in [
        (Some("src/ssh/session.rs"), 0),
        (Some("src/unknown/a.rs"), 3),
        (Some("src/ssh/Session.rs"), 3),
        (Some("src/ssh/../x.rs"), 3),
        (Some("src/ssh//x.rs"), 3),
        (Some("src/ssh/x.txt"), 3),
        (Some("/c/registry/src/i/russh-0.65.0/src/lib.rs"), 3),
        (Some("/rustc/abc/library/core/src/option.rs"), 3),
        (None, 3),
    ] {
        assert_eq!(line_of(file, line), None, "{file:?}");
    }
    let long = format!("src/ssh/{}.rs", "a".repeat(MAX_LINE_CHARS));
    assert_eq!(line_of(Some(&long), 1), None);
}

#[test]
fn severity_and_kind_come_from_the_thread() {
    assert_eq!(kind_of(Some("main")), (Severity::Fatal, Kind::Crash));
    assert_eq!(
        kind_of(Some("tokio-runtime-worker")),
        (Severity::Error, Kind::TaskException)
    );
    for other in [Some("notify-rs debouncer"), Some("jdoe"), Some(""), None] {
        assert_eq!(kind_of(other), (Severity::Error, Kind::Unhandled));
    }
}

#[test]
fn the_body_holds_codes_and_the_system_fields_only() {
    let c = armed(None);
    let report = c.report(&site(
        "src/ssh/session.rs",
        214,
        "called `Option::unwrap()` on a `None` value at jdoe@srv01",
        "tokio-runtime-worker",
    ));
    let body: serde_json::Value = serde_json::from_slice(&report.body()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "errorType": "panic:ssh",
            "errorMessage": "panic:ssh:unwrap_none",
            "stackTrace": "src/ssh/session.rs:214",
            "timestamp": report.time,
            "sessionId": report.session_id,
            "platform": "Tauri",
            "osName": "Windows",
            "osVersion": "10.0.26300",
            "appVersion": "0.2.0",
            "sdkVersion": SDK_VERSION,
            "severity": "error",
            "kind": "taskException",
            "isDebug": false,
        })
    );
    let text = String::from_utf8(report.body()).unwrap();
    assert!(!text.contains("srv01") && !text.contains("fr-FR"), "{text}");
    assert!(uuid::Uuid::parse_str(&report.session_id).is_ok());

    let dep = c.report(&site(
        "/home/jdoe/.cargo/registry/src/i/russh-0.65.0/src/lib.rs",
        9,
        "boom",
        "main",
    ));
    let body: serde_json::Value = serde_json::from_slice(&dep.body()).unwrap();
    assert!(body.get("stackTrace").is_none());
    assert_eq!(body["errorType"], "panic:russh");
    assert_eq!(body["errorMessage"], "panic:russh:other");
    assert_eq!(
        (body["severity"].clone(), body["kind"].clone()),
        ("fatal".into(), "crash".into())
    );
    assert!(!String::from_utf8(dep.body()).unwrap().contains("jdoe"));
}

#[test]
fn the_row_shows_what_the_body_adds() {
    let c = armed(None);
    let r = c.report(&site("src/sftp/text.rs", 7, UNWRAP_NONE, "other"));
    let row = serde_json::to_value(r.row(false, 1)).unwrap();
    assert_eq!(
        row,
        serde_json::json!({
            "time": r.time,
            "name": "crash",
            "props": {
                "type": "panic:sftp",
                "message": "panic:sftp:unwrap_none",
                "kind": "unhandled",
                "severity": "error",
                "line": "src/sftp/text.rs:7",
                "session": r.session_id,
            },
        })
    );
    let keys: Vec<&str> = r.row(false, 1).props.0.iter().map(|(k, _)| *k).collect();
    assert_eq!(
        keys,
        ["type", "message", "kind", "severity", "line", "session"]
    );
    let dep = c.report(&site("/rustc/a/library/core/src/x.rs", 1, "", "main"));
    let row = serde_json::to_value(dep.row(true, 0)).unwrap();
    assert!(row["props"].get("line").is_none());
    assert_eq!(row["previousLaunch"], true);
}

#[test]
fn reports_are_deduplicated_and_capped_per_session() {
    let c = armed(Some(Errors::new(Posted::Sent)));
    for _ in 0..3 {
        c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    }
    assert_eq!((c.rows().len(), c.queued()), (1, 1));
    // Another line, cause or kind is another report.
    c.capture(&site("src/ssh/a.rs", 2, UNWRAP_NONE, "w"));
    c.capture(&site("src/ssh/a.rs", 1, "boom", "w"));
    c.capture(&site(
        "src/ssh/a.rs",
        1,
        UNWRAP_NONE,
        "tokio-runtime-worker",
    ));
    assert_eq!(c.rows().len(), 4);
    for line in 10..40 {
        c.capture(&site("src/keys/file.rs", line, UNWRAP_NONE, "w"));
    }
    assert_eq!(c.rows().len(), MAX_DISTINCT);
    assert_eq!(c.queued(), MAX_DISTINCT);
    assert_eq!(
        c.rows()[0].props.0[4].1,
        Prop::Text("src/keys/file.rs:25".into())
    );
}

#[test]
fn a_closed_gate_or_a_held_lock_captures_nothing() {
    let c = armed(Some(Errors::new(Posted::Sent)));
    c.set_armed(false);
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    assert!(c.rows().is_empty());
    c.set_armed(true);
    {
        let _held = c.log();
        // Same thread: a blocking lock would deadlock here.
        c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    }
    assert!(c.rows().is_empty());
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    assert_eq!(c.rows().len(), 1);
}

#[test]
fn a_keyless_build_lists_reports_but_queues_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let c = armed(None);
    c.set_dir(dir.path().to_path_buf());
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "main"));
    assert_eq!(c.rows().len(), 2);
    assert_eq!(c.queued(), 0);
    assert!(!dir.path().join(PENDING_FILE).exists());
    c.flush(later());
}

#[test]
fn flush_sends_one_report_per_request_with_bounded_retries() {
    let t = Errors::new(Posted::Retry);
    let c = armed(Some(t.clone()));
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    c.capture(&site("src/sftp/a.rs", 1, UNWRAP_NONE, "w"));
    for _ in 0..MAX_TRIES {
        c.flush(later());
    }
    // Each flush stops at the first report that must wait; the first is dropped after
    // `MAX_TRIES`, the second has been tried once.
    assert_eq!(t.sent().len(), usize::from(MAX_TRIES));
    assert_eq!(c.queued(), 1);
    assert!(t.sent().iter().all(|b| b["errorType"] == "panic:ssh"));

    let t = Errors::new(Posted::Sent).then(&[Posted::Rejected]);
    let c = armed(Some(t.clone()));
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    c.capture(&site("src/sftp/a.rs", 1, UNWRAP_NONE, "w"));
    c.flush(later());
    assert_eq!(t.sent().len(), 2);
    assert!(t.sent().iter().all(|b| b.is_object()));
    assert_eq!(c.queued(), 0);
    c.flush(later());
    assert_eq!(t.sent().len(), 2);
}

#[test]
fn discarding_drops_queue_rows_and_the_pending_file() {
    let dir = tempfile::tempdir().unwrap();
    let t = Errors::new(Posted::Retry);
    let c = armed(Some(t.clone()));
    c.set_dir(dir.path().to_path_buf());
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "main"));
    assert!(dir.path().join(PENDING_FILE).exists());
    c.set_armed(false);
    c.discard();
    assert!(c.rows().is_empty() && c.queued() == 0);
    assert!(!dir.path().join(PENDING_FILE).exists());
    let sent = t.sent().len();
    c.flush(later());
    assert_eq!(t.sent().len(), sent);
    // The same crash is a new report once crash reports are on again.
    c.set_armed(true);
    c.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "w"));
    assert_eq!(c.rows().len(), 1);
}

fn fatal_report(dir: &Path, answer: Posted) -> (Arc<Crashes>, Errors) {
    let t = Errors::new(answer);
    let c = armed(Some(t.clone()));
    c.set_dir(dir.to_path_buf());
    c.capture(&site("src/commands/app.rs", 42, UNWRAP_NONE, "main"));
    (c, t)
}

#[test]
fn a_fatal_crash_is_saved_then_sent() {
    let dir = tempfile::tempdir().unwrap();
    let (c, t) = fatal_report(dir.path(), Posted::Sent);
    assert_eq!(t.sent().len(), 1);
    assert_eq!(t.sent()[0]["severity"], "fatal");
    assert_eq!(t.sent()[0]["stackTrace"], "src/commands/app.rs:42");
    assert!(!dir.path().join(PENDING_FILE).exists());
    assert_eq!(c.queued(), 0, "a fatal report is sent once, never queued");
    let (_, _) = fatal_report(dir.path(), Posted::Rejected);
    assert!(!dir.path().join(PENDING_FILE).exists());
}

#[test]
fn an_unsent_fatal_crash_is_left_owner_only_for_the_next_launch() {
    let dir = tempfile::tempdir().unwrap();
    let (first, _) = fatal_report(dir.path(), Posted::Retry);
    let path = dir.path().join(PENDING_FILE);
    let file = fs::File::open(&path).unwrap();
    #[cfg(unix)]
    assert!(fsutil::is_owner_only(&file));
    #[cfg(windows)]
    assert!(!fsutil::readable_by_others(&file).unwrap());
    drop(file);
    assert!(!dir.path().join(PENDING_TMP).exists());
    let raw = fs::read(&path).unwrap();
    let saved = Report::from_file(&raw).unwrap();
    assert_eq!(saved.session_id, first.report(&Site::default()).session_id);
    let text = String::from_utf8(raw).unwrap();
    assert!(text.contains("\"type\":\"panic:commands\""), "{text}");

    // Next launch, crash reports still on.
    let t = Errors::new(Posted::Sent);
    let next = armed(Some(t.clone()));
    next.set_dir(dir.path().to_path_buf());
    next.resume();
    let rows = serde_json::to_value(next.rows()).unwrap();
    assert_eq!(rows[0]["previousLaunch"], true);
    assert_eq!(rows[0]["time"], saved.time);
    assert_eq!(rows[0]["props"]["session"], saved.session_id);
    assert_eq!(next.queued(), 1);
    assert!(path.exists(), "kept until it is sent");
    next.resume();
    assert_eq!(next.queued(), 1, "once per launch");
    next.flush(later());
    assert_eq!(t.sent().len(), 1);
    assert_eq!(t.sent()[0]["sessionId"], saved.session_id);
    assert_eq!(t.sent()[0]["appVersion"], "0.2.0");
    assert!(!path.exists());
}

#[test]
fn a_leftover_report_is_deleted_without_consent_or_a_key() {
    for (on, key) in [(false, true), (true, false), (false, false)] {
        let dir = tempfile::tempdir().unwrap();
        fatal_report(dir.path(), Posted::Retry);
        let path = dir.path().join(PENDING_FILE);
        assert!(path.exists());
        let t = Errors::new(Posted::Sent);
        let next = armed(key.then(|| t.clone()));
        next.set_armed(on);
        next.set_dir(dir.path().to_path_buf());
        next.resume();
        assert!(!path.exists(), "on {on}, key {key}");
        assert!(next.rows().is_empty());
        next.flush(later());
        assert!(t.sent().is_empty());
    }
}

#[test]
fn a_later_fatal_crash_is_not_deleted_with_the_earlier_one() {
    let dir = tempfile::tempdir().unwrap();
    fatal_report(dir.path(), Posted::Retry);
    let t = Errors::new(Posted::Retry).then(&[Posted::Retry]);
    let next = armed(Some(t.clone()));
    next.set_dir(dir.path().to_path_buf());
    next.resume();
    next.capture(&site("src/ssh/a.rs", 1, UNWRAP_NONE, "main"));
    let newer = fs::read(dir.path().join(PENDING_FILE)).unwrap();
    for _ in 0..MAX_TRIES {
        next.flush(later());
    }
    assert_eq!(next.queued(), 0);
    assert_eq!(fs::read(dir.path().join(PENDING_FILE)).unwrap(), newer);
}

#[test]
fn a_pending_file_holding_anything_else_is_deleted_unsent() {
    let good = || {
        serde_json::json!({
            "type": "panic:ssh",
            "message": "panic:ssh:unwrap_none",
            "line": "src/ssh/session.rs:214",
            "severity": "fatal",
            "kind": "crash",
            "time": "2026-11-05T10:00:00.000Z",
            "session": "5b0e7c1e-6d1f-4d55-9a43-0c8f9f0a1b2c",
            "appVersion": "0.2.0",
            "os": "Windows",
            "osVersion": "10.0.26300",
        })
    };
    assert!(Report::from_file(good().to_string().as_bytes()).is_some());
    let mut no_line = good();
    no_line.as_object_mut().unwrap().remove("line");
    assert!(Report::from_file(no_line.to_string().as_bytes()).is_some());
    let bad: &[(&str, serde_json::Value)] = &[
        ("type", "panic:jdoe".into()),
        ("type", "ssh".into()),
        ("message", "panic:ssh:connection to srv01 lost".into()),
        ("message", "panic:sftp:unwrap_none".into()),
        ("line", "C:/Users/jdoe/src/ssh/session.rs:214".into()),
        ("line", "src/sftp/text.rs:214".into()),
        ("line", "src/ssh/session.rs:0".into()),
        ("line", "src/ssh/session.rs:12345678".into()),
        ("line", "src/ssh/session.rs".into()),
        ("severity", "warning".into()),
        ("kind", "handled".into()),
        ("time", "yesterday".into()),
        ("time", "2026-11-05T10:00:00Z".into()),
        ("session", "jdoe".into()),
        ("session", "5B0E7C1E-6D1F-4D55-9A43-0C8F9F0A1B2C".into()),
        ("appVersion", "0.2.0 jdoe@srv01".into()),
        ("os", "Windows/jdoe".into()),
        ("osVersion", "22.04 LTS (Jammy)".into()),
        ("extra", "x".into()),
    ];
    for (key, value) in bad {
        let mut v = good();
        v[*key] = value.clone();
        assert!(
            Report::from_file(v.to_string().as_bytes()).is_none(),
            "{key} = {value}"
        );
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(PENDING_FILE), v.to_string()).unwrap();
        let t = Errors::new(Posted::Sent);
        let c = armed(Some(t.clone()));
        c.set_dir(dir.path().to_path_buf());
        c.resume();
        assert!(!dir.path().join(PENDING_FILE).exists(), "{key}");
        assert_eq!(c.queued(), 0);
    }
    for raw in [&b"not json"[..], b"", &[b'{'; 5000][..]] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(PENDING_FILE), raw).unwrap();
        let c = armed(Some(Errors::new(Posted::Sent)));
        c.set_dir(dir.path().to_path_buf());
        c.resume();
        assert!(!dir.path().join(PENDING_FILE).exists());
    }
}

/// Panics on a thread with this name, its hook target set to `c`; `guarded` marks the thread
/// as already inside the hook first.
fn panic_on(c: &Arc<Crashes>, name: &str, guarded: bool) -> u32 {
    install_for_tests();
    let c = c.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let joined = thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            target_for_tests(c);
            if guarded {
                IN_HOOK.with(|f| f.set(true));
            }
            tx.send(line!() + 1).unwrap();
            let none: Option<u8> = std::hint::black_box(None);
            none.unwrap();
        })
        .unwrap()
        .join();
    assert!(joined.is_err());
    rx.recv().unwrap()
}

#[test]
fn the_hook_reports_real_panics_with_codes_only() {
    let t = Errors::new(Posted::Sent);
    let c = armed(Some(t.clone()));
    let line = panic_on(&c, "crash-test worker", false);
    let rows = serde_json::to_value(c.rows()).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    let props = &rows[0]["props"];
    assert_eq!(props["type"], "panic:analytics");
    assert_eq!(props["message"], "panic:analytics:unwrap_none");
    assert_eq!(props["kind"], "unhandled");
    assert_eq!(props["severity"], "error");
    assert_eq!(
        props["line"],
        format!("src/analytics/crash/tests.rs:{}", line + 1)
    );

    let line = panic_on(&c, "tokio-runtime-worker", false);
    assert_eq!(c.rows().len(), 2);
    assert_eq!(c.rows()[0].props.0[2].1, Prop::Str("taskException"));
    assert!(line > 0);
    c.flush(later());
    assert_eq!(t.sent().len(), 2);
}

#[test]
fn the_hook_reports_a_main_thread_panic_as_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let t = Errors::new(Posted::Retry);
    let c = armed(Some(t.clone()));
    c.set_dir(dir.path().to_path_buf());
    panic_on(&c, "main", false);
    assert_eq!(t.sent().len(), 1);
    assert_eq!(t.sent()[0]["kind"], "crash");
    let saved = Report::from_file(&fs::read(dir.path().join(PENDING_FILE)).unwrap()).unwrap();
    assert_eq!(saved.area, "analytics");
    assert_eq!(c.queued(), 0);
}

#[test]
fn the_hook_does_not_reenter_and_respects_the_gate() {
    let c = armed(Some(Errors::new(Posted::Sent)));
    panic_on(&c, "crash-test guarded", true);
    assert!(c.rows().is_empty());
    c.set_armed(false);
    panic_on(&c, "crash-test closed", false);
    assert!(c.rows().is_empty());
}

#[test]
fn panics_of_threads_without_a_target_are_ignored() {
    install_for_tests();
    let c = armed(Some(Errors::new(Posted::Sent)));
    let joined = thread::Builder::new()
        .name("crash-test untargeted".into())
        .spawn(|| panic!("no target"))
        .unwrap()
        .join();
    assert!(joined.is_err());
    assert!(c.rows().is_empty());
}

#[test]
fn the_hook_reads_formatted_and_static_messages() {
    install_for_tests();
    let c = armed(None);
    for (name, formatted) in [("crash-test formatted", true), ("crash-test static", false)] {
        let target = c.clone();
        let joined = thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                target_for_tests(target);
                let n = std::hint::black_box(7);
                if formatted {
                    panic!("index out of bounds: the index is {n} at srv01");
                }
                panic!("capacity overflow");
            })
            .unwrap()
            .join();
        assert!(joined.is_err());
    }
    let messages: Vec<Prop> = c.rows().iter().map(|r| r.props.0[1].1.clone()).collect();
    assert_eq!(
        messages,
        [
            Prop::Text("panic:analytics:capacity".into()),
            Prop::Text("panic:analytics:index".into()),
        ]
    );
}
