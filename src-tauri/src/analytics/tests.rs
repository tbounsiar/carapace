use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;

use super::client::{BATCH, MAX_TRIES, Posted};
use super::*;

fn system() -> SystemProps {
    SystemProps {
        app_version: "0.1.0".into(),
        os: "Windows".into(),
        os_version: "10.0.26300".into(),
        locale: "fr-FR".into(),
    }
}

/// Records every body it is given and answers from a script, then with `fallback`.
#[derive(Clone)]
struct Sink {
    bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    script: Arc<Mutex<VecDeque<Posted>>>,
    fallback: Posted,
}

impl Sink {
    fn new(fallback: Posted) -> Self {
        Self {
            bodies: Arc::default(),
            script: Arc::default(),
            fallback,
        }
    }

    fn sent(&self) -> Vec<serde_json::Value> {
        self.bodies.lock().unwrap().clone()
    }

    fn names(&self) -> Vec<String> {
        self.sent()
            .iter()
            .flat_map(|b| b.as_array().unwrap().clone())
            .map(|e| e["eventName"].as_str().unwrap().to_owned())
            .collect()
    }
}

impl Transport for Sink {
    fn post(&self, body: &[u8], _timeout: Duration) -> Posted {
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

fn consent(consent: Consent, catalogue_version: u32) -> Option<AnalyticsConsent> {
    Some(AnalyticsConsent {
        consent,
        catalogue_version,
    })
}

fn granted() -> Option<AnalyticsConsent> {
    consent(Consent::Granted, CATALOGUE_VERSION)
}

fn with_sink(stored: Option<AnalyticsConsent>) -> (Analytics, Sink) {
    let sink = Sink::new(Posted::Sent);
    (
        Analytics::new(stored, system(), Some(Box::new(sink.clone()))),
        sink,
    )
}

fn names(a: &Analytics) -> Vec<&'static str> {
    a.recent().events.iter().map(|e| e.name).collect()
}

const COUNTS: Counts = Counts {
    hosts: 7,
    projects: 1,
    keys: 0,
};

fn ok(_: AnalyticsConsent) -> Result<(), ()> {
    Ok(())
}

#[test]
fn nothing_is_recorded_without_consent() {
    for stored in [
        None,
        consent(Consent::Unset, CATALOGUE_VERSION),
        consent(Consent::Denied, CATALOGUE_VERSION),
        consent(Consent::Granted, CATALOGUE_VERSION - 1),
    ] {
        let (a, sink) = with_sink(stored);
        a.record(Event::TerminalOpened);
        a.app_started(Theme::Dark, || panic!("counts read without consent"));
        a.files_listed("c");
        a.attempt_pending(
            Attempt::Connect("h".into()),
            Event::ConnectFailed {
                auth: Auth::Key,
                code: ErrorCode::Timeout,
            },
        );
        a.expire_attempts(Duration::ZERO);
        assert!(a.recent().events.is_empty());
        assert_eq!(a.queued(), 0);
        a.flush(Duration::from_secs(1));
        assert!(sink.sent().is_empty());
        assert!(!a.collecting());
    }
}

#[test]
fn state_asks_when_unset_or_granted_for_an_older_catalogue() {
    let view = |stored| Analytics::new(stored, system(), None).status();
    let s = view(None);
    assert_eq!(
        (s.consent, s.ask_needed, s.available),
        (Consent::Unset, true, false)
    );
    let s = view(consent(Consent::Granted, 0));
    assert_eq!((s.consent, s.ask_needed), (Consent::Granted, true));
    let s = view(granted());
    assert_eq!((s.consent, s.ask_needed), (Consent::Granted, false));
    let s = view(consent(Consent::Denied, 0));
    assert_eq!((s.consent, s.ask_needed), (Consent::Denied, false));
    assert!(with_sink(None).0.status().available);
    let json = serde_json::to_value(view(None)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"consent": "unset", "askNeeded": true, "available": false, "persisted": true})
    );
}

#[test]
fn granting_emits_consent_then_app_started_once() {
    let (a, _) = with_sink(None);
    a.app_started(Theme::System, || COUNTS);
    assert!(a.recent().events.is_empty());
    let mut saved = Vec::new();
    let s = a
        .set_consent(
            true,
            |v| {
                saved.push(v);
                Ok::<_, ()>(())
            },
            || COUNTS,
        )
        .unwrap();
    assert_eq!(saved, vec![granted().unwrap()]);
    assert_eq!((s.consent, s.ask_needed), (Consent::Granted, false));
    assert_eq!(names(&a), ["app_started", "consent_granted"]);
    let started = &a.recent().events[0];
    assert_eq!(
        serde_json::to_value(&started.props).unwrap(),
        serde_json::json!({"theme": "system", "hosts": "6-20", "projects": "1", "keys": "0"})
    );
    a.app_started(Theme::Dark, || COUNTS);
    a.set_consent(true, ok, || COUNTS).unwrap();
    assert_eq!(names(&a), ["app_started", "consent_granted"]);
}

#[test]
fn app_started_follows_a_grant_made_before_the_theme_is_known() {
    let (a, _) = with_sink(None);
    a.set_consent(true, ok, || COUNTS).unwrap();
    assert_eq!(names(&a), ["consent_granted"]);
    a.app_started(Theme::Light, || COUNTS);
    a.app_started(Theme::Light, || COUNTS);
    assert_eq!(names(&a), ["app_started", "consent_granted"]);
}

#[test]
fn regranting_an_older_catalogue_emits_consent_again() {
    let (a, _) = with_sink(consent(Consent::Granted, 0));
    a.set_consent(true, ok, || COUNTS).unwrap();
    assert_eq!(names(&a), ["consent_granted"]);
}

#[test]
fn a_failed_save_of_a_grant_changes_nothing() {
    let (a, sink) = with_sink(None);
    a.app_started(Theme::Dark, || COUNTS);
    assert_eq!(a.set_consent(true, |_| Err("io"), || COUNTS), Err("io"));
    assert_eq!(a.status().consent, Consent::Unset);
    assert!(a.recent().events.is_empty());
    a.flush(Duration::from_secs(1));
    assert!(sink.sent().is_empty());
}

#[test]
fn denying_discards_the_queue_and_the_log_and_sends_nothing_about_it() {
    let (a, sink) = with_sink(granted());
    a.record(Event::TerminalOpened);
    a.files_listed("c");
    assert_eq!(a.queued(), 2);
    let mut saved = Vec::new();
    let s = a
        .set_consent(
            false,
            |v| {
                saved.push(v);
                Ok::<_, ()>(())
            },
            || panic!("counts read on deny"),
        )
        .unwrap();
    assert_eq!(
        saved,
        vec![consent(Consent::Denied, CATALOGUE_VERSION).unwrap()]
    );
    assert_eq!((s.consent, s.ask_needed), (Consent::Denied, false));
    assert_eq!(a.queued(), 0);
    assert!(a.recent().events.is_empty());
    a.record(Event::TerminalOpened);
    a.flush(Duration::from_secs(1));
    assert!(sink.sent().is_empty());
}

#[test]
fn a_deny_stays_in_effect_when_it_cannot_be_saved() {
    let (a, _) = with_sink(granted());
    a.record(Event::TerminalOpened);
    assert_eq!(a.set_consent(false, |_| Err("io"), || COUNTS), Err("io"));
    assert!(!a.collecting());
    assert_eq!(a.queued(), 0);
    let s = a.status();
    assert_eq!((s.consent, s.persisted), (Consent::Denied, false));
    a.retry_save(|_| Err::<(), _>("io"));
    assert!(!a.status().persisted);
    let mut saved = Vec::new();
    a.retry_save(|v| {
        saved.push(v);
        Ok::<_, ()>(())
    });
    assert_eq!(
        saved,
        vec![consent(Consent::Denied, CATALOGUE_VERSION).unwrap()]
    );
    assert!(a.status().persisted);
    a.retry_save(|_| -> Result<(), ()> { panic!("saved twice") });
    a.record(Event::TerminalOpened);
    assert!(a.recent().events.is_empty());
}

#[test]
fn recent_log_keeps_the_last_fifty_newest_first() {
    let (a, _) = with_sink(granted());
    for i in 0..60 {
        a.record(Event::VariablesSaved {
            scope: Scope::Global,
            count: Count::of(i),
        });
    }
    a.record(Event::TerminalOpened);
    let recent = a.recent();
    assert_eq!(recent.events.len(), MAX_RECENT);
    assert_eq!(recent.events[0].name, "terminal_opened");
    assert_eq!(
        serde_json::to_value(&recent.events[1].props).unwrap()["count"],
        "51+"
    );
    let json = serde_json::to_value(&recent).unwrap();
    assert_eq!(
        json["system"],
        serde_json::json!({
            "appVersion": "0.1.0",
            "os": "Windows",
            "osVersion": "10.0.26300",
            "locale": "fr-FR",
            "sdkVersion": SDK_VERSION,
            "sessionId": recent.system.session_id,
        })
    );
    let first = &json["events"][0];
    assert_eq!(first["name"], "terminal_opened");
    assert_eq!(first["props"], serde_json::json!({}));
    let time = first["time"].as_str().unwrap();
    assert!(time.ends_with('Z') && time.len() == 24, "{time}");
    let times: Vec<&str> = json["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["time"].as_str().unwrap())
        .collect();
    assert!(times.windows(2).all(|w| w[0] >= w[1]));
}

#[test]
fn an_unavailable_build_logs_but_never_sends() {
    let a = Analytics::new(granted(), system(), None);
    assert!(!a.available());
    a.record(Event::TerminalOpened);
    assert_eq!(names(&a), ["terminal_opened"]);
    assert_eq!(a.queued(), 0);
    a.shutdown();
}

#[test]
fn a_retried_attempt_counts_once() {
    let (a, _) = with_sink(granted());
    let key = Attempt::Connect("h".into());
    let failed = |code| Event::ConnectFailed {
        auth: Auth::Password,
        code,
    };
    a.attempt_started(&key, false);
    a.attempt_pending(key.clone(), failed(ErrorCode::SecretRequired));
    a.attempt_started(&key, true);
    a.attempt_pending(key.clone(), failed(ErrorCode::AuthFailed));
    a.attempt_started(&key, true);
    a.attempt_done(
        &key,
        Some(Event::ConnectSucceeded {
            auth: Auth::Password,
            duration: Took::UnderOne,
        }),
    );
    assert_eq!(names(&a), ["connect_succeeded"]);

    a.attempt_pending(key.clone(), failed(ErrorCode::AuthFailed));
    a.attempt_started(&key, false);
    assert_eq!(names(&a)[0], "connect_failed");
    assert_eq!(
        serde_json::to_value(&a.recent().events[0].props).unwrap()["code"],
        "auth_failed"
    );

    a.attempt_pending(key.clone(), failed(ErrorCode::SecretRequired));
    a.expire_attempts(ATTEMPT_TTL);
    assert_eq!(names(&a).len(), 2);
    a.expire_attempts(Duration::ZERO);
    assert_eq!(names(&a).len(), 3);
}

#[test]
fn files_opened_once_per_connection() {
    let (a, _) = with_sink(granted());
    a.files_listed("c");
    a.files_listed("c");
    a.files_listed("d");
    assert_eq!(names(&a), ["files_opened", "files_opened"]);
    a.connection_opened("c");
    a.files_listed("c");
    assert_eq!(names(&a).len(), 3);
}

#[test]
fn flush_sends_batches_with_the_session_and_system_props() {
    let (a, sink) = with_sink(granted());
    for _ in 0..(BATCH * 2 + 3) {
        a.record(Event::TerminalOpened);
    }
    a.flush(Duration::from_secs(5));
    let bodies = sink.sent();
    let sizes: Vec<usize> = bodies.iter().map(|b| b.as_array().unwrap().len()).collect();
    assert_eq!(sizes, [BATCH, BATCH, 3]);
    let ev = &bodies[0][0];
    let session = ev["sessionId"].as_str().unwrap();
    assert_eq!(session.len(), 36);
    assert!(session.parse::<u64>().is_err());
    assert!(
        bodies
            .iter()
            .flat_map(|b| b.as_array().unwrap())
            .all(|e| e["sessionId"] == session)
    );
    assert_eq!(
        ev["systemProps"],
        serde_json::json!({
            "appVersion": "0.1.0",
            "osName": "Windows",
            "osVersion": "10.0.26300",
            "locale": "fr-FR",
            "sdkVersion": concat!("carapace@", env!("CARGO_PKG_VERSION")),
        })
    );
    let keys: Vec<&str> = ev.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys.len(), 5);
    assert_eq!(a.queued(), 0);
}

#[test]
fn failed_batches_are_retried_a_bounded_number_of_times() {
    let sink = Sink::new(Posted::Retry);
    let a = Analytics::new(granted(), system(), Some(Box::new(sink.clone())));
    a.record(Event::TerminalOpened);
    for _ in 0..MAX_TRIES + 2 {
        a.flush(Duration::from_secs(1));
    }
    assert_eq!(sink.sent().len(), usize::from(MAX_TRIES));
    assert_eq!(a.queued(), 0);

    let sink = Sink::new(Posted::Rejected);
    let a = Analytics::new(granted(), system(), Some(Box::new(sink.clone())));
    a.record(Event::TerminalOpened);
    a.flush(Duration::from_secs(1));
    a.flush(Duration::from_secs(1));
    assert_eq!(sink.sent().len(), 1);

    let sink = Sink::new(Posted::Sent);
    sink.script.lock().unwrap().push_back(Posted::Retry);
    let a = Analytics::new(granted(), system(), Some(Box::new(sink.clone())));
    a.record(Event::TerminalOpened);
    a.flush(Duration::from_secs(1));
    a.record(Event::FilesOpened);
    a.flush(Duration::from_secs(1));
    assert_eq!(
        sink.names(),
        ["terminal_opened", "terminal_opened", "files_opened"]
    );
}

#[test]
fn a_deny_during_a_failing_flush_keeps_nothing() {
    struct DenyWhilePosting(Mutex<Option<Analytics>>);
    impl Transport for DenyWhilePosting {
        fn post(&self, _: &[u8], _: Duration) -> Posted {
            if let Some(a) = self.0.lock().unwrap().take() {
                a.set_consent(false, ok, || COUNTS).unwrap();
            }
            Posted::Retry
        }
    }
    let t = Arc::new(DenyWhilePosting(Mutex::new(None)));
    struct Shared(Arc<DenyWhilePosting>);
    impl Transport for Shared {
        fn post(&self, b: &[u8], d: Duration) -> Posted {
            self.0.post(b, d)
        }
    }
    let a = Analytics::new(granted(), system(), Some(Box::new(Shared(t.clone()))));
    *t.0.lock().unwrap() = Some(a.clone());
    a.record(Event::TerminalOpened);
    a.flush(Duration::from_secs(1));
    assert_eq!(a.queued(), 0);
}

#[test]
fn the_queue_is_bounded() {
    let (a, _) = with_sink(granted());
    for _ in 0..client::MAX_QUEUED + 10 {
        a.record(Event::TerminalOpened);
    }
    assert_eq!(a.queued(), client::MAX_QUEUED);
}

#[test]
fn keys_map_to_their_region() {
    assert_eq!(
        client::base_url("A-EU-1234567890"),
        Some("https://eu.aptabase.com")
    );
    assert_eq!(
        client::base_url("A-US-1234567890"),
        Some("https://us.aptabase.com")
    );
    for bad in [
        "",
        "A-DEV-123",
        "A-SH-123",
        "A-EU-",
        "B-EU-1",
        "A-EU-1-2",
        "A-EU-a/b",
        "A-eu-1",
    ] {
        assert_eq!(client::base_url(bad), None, "{bad}");
    }
}

struct Request {
    head: String,
    body: Vec<u8>,
}

/// A one-shot-per-connection HTTP server answering each request with the next status.
fn mock_server(statuses: Vec<u16>, delay: Duration) -> (String, mpsc::Receiver<Request>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for status in statuses {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head, mut body) = loop {
                let n = socket.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    return;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break (
                        String::from_utf8_lossy(&buf[..i]).into_owned(),
                        buf[i + 4..].to_vec(),
                    );
                }
            };
            let len: usize = head
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse().ok())?
                })
                .unwrap_or(0);
            while body.len() < len {
                let n = socket.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..n]);
            }
            let _ = tx.send(Request { head, body });
            thread::sleep(delay);
            let _ = write!(
                socket,
                "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
        }
    });
    (base, rx)
}

fn http(base: &str) -> Aptabase {
    Aptabase::new(base, "A-EU-1234567890", false)
}

#[test]
fn http_client_posts_json_with_the_app_key() {
    let (base, rx) = mock_server(vec![200, 200], Duration::ZERO);
    let a = Analytics::new(granted(), system(), Some(Box::new(http(&base))));
    for _ in 0..BATCH + 1 {
        a.record(Event::TerminalOpened);
    }
    a.flush(Duration::from_secs(10));
    let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let second = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        first.head.starts_with("POST /api/v0/events HTTP/1.1"),
        "{}",
        first.head
    );
    let headers: HashMap<String, String> = first
        .head
        .lines()
        .skip(1)
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    assert_eq!(headers["app-key"], "A-EU-1234567890");
    assert_eq!(headers["content-type"], "application/json");
    let one: serde_json::Value = serde_json::from_slice(&first.body).unwrap();
    let two: serde_json::Value = serde_json::from_slice(&second.body).unwrap();
    assert_eq!(one.as_array().unwrap().len(), BATCH);
    assert_eq!(two.as_array().unwrap().len(), 1);
    assert_eq!(a.queued(), 0);
}

#[test]
fn http_client_maps_statuses() {
    let (base, _rx) = mock_server(vec![202, 400, 503], Duration::ZERO);
    let c = http(&base);
    let t = Duration::from_secs(5);
    assert_eq!(c.post(b"[]", t), Posted::Sent);
    assert_eq!(c.post(b"[]", t), Posted::Rejected);
    assert_eq!(c.post(b"[]", t), Posted::Retry);
    assert_eq!(c.post(b"[]", t), Posted::Retry);
}

#[test]
fn http_client_times_out() {
    let (base, _rx) = mock_server(vec![200], Duration::from_secs(5));
    let started = Instant::now();
    assert_eq!(
        http(&base).post(b"[]", Duration::from_millis(300)),
        Posted::Retry
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn exit_flush_is_bounded_and_reports_pending_attempts() {
    let (base, rx) = mock_server(vec![200], Duration::from_secs(10));
    let a = Analytics::new(granted(), system(), Some(Box::new(http(&base))));
    a.attempt_pending(
        Attempt::Test(String::new()),
        Event::test_ended(TestResult::Cancelled),
    );
    let started = Instant::now();
    a.shutdown();
    assert!(started.elapsed() < EXIT_FLUSH + Duration::from_secs(2));
    let sent = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let body: serde_json::Value = serde_json::from_slice(&sent.body).unwrap();
    assert_eq!(body[0]["eventName"], "host_test_run");
    assert_eq!(body[0]["props"], serde_json::json!({"result": "cancelled"}));
}

#[test]
fn exit_flush_without_a_server_returns() {
    let a = Analytics::new(
        granted(),
        system(),
        Some(Box::new(http("http://127.0.0.1:1"))),
    );
    a.record(Event::TerminalOpened);
    let started = Instant::now();
    a.shutdown();
    assert!(started.elapsed() < EXIT_FLUSH + Duration::from_secs(2));
}

mod catalogue {
    use super::*;

    /// The published catalogue: event -> property -> allowed values. Bools are "true"/"false".
    fn allowed() -> HashMap<&'static str, HashMap<&'static str, Vec<&'static str>>> {
        let count = vec!["0", "1", "2-5", "6-20", "21-50", "51+"];
        let codes: Vec<&str> = TS_CODES.iter().copied().chain(["unknown"]).collect();
        let auth = vec!["password", "key", "agent"];
        HashMap::from([
            (
                "app_started",
                HashMap::from([
                    ("theme", vec!["system", "light", "dark"]),
                    ("hosts", count.clone()),
                    ("projects", count.clone()),
                    ("keys", count.clone()),
                ]),
            ),
            ("consent_granted", HashMap::new()),
            ("host_created", HashMap::from([("auth", auth.clone())])),
            (
                "connect_succeeded",
                HashMap::from([
                    ("auth", auth.clone()),
                    ("duration", vec!["<1s", "1-3s", "3-10s", "10s+"]),
                ]),
            ),
            (
                "connect_failed",
                HashMap::from([("auth", auth.clone()), ("code", codes.clone())]),
            ),
            (
                "host_test_run",
                HashMap::from([
                    ("result", vec!["success", "failure", "cancelled"]),
                    ("code", codes.clone()),
                ]),
            ),
            ("terminal_opened", HashMap::new()),
            ("files_opened", HashMap::new()),
            (
                "transfer_finished",
                HashMap::from([
                    ("direction", vec!["upload", "download"]),
                    ("outcome", vec!["done", "failed", "cancelled"]),
                    ("files", vec!["1", "2-10", "11-100", "101+"]),
                ]),
            ),
            (
                "key_generated",
                HashMap::from([
                    ("type", vec!["ed25519", "rsa4096"]),
                    ("custom_folder", vec!["true", "false"]),
                ]),
            ),
            (
                "key_imported",
                HashMap::from([("type", vec!["ed25519", "rsa", "ecdsa", "other"])]),
            ),
            (
                "variables_saved",
                HashMap::from([("scope", vec!["global", "project"]), ("count", count)]),
            ),
        ])
    }

    /// `CommandErrorCode` in `src/app/core/ipc/config.models.ts`.
    const TS_CODES: &[&str] = &[
        "not_found",
        "invalid_input",
        "conflict",
        "io",
        "corrupt_config",
        "host_key_rejected",
        "auth_failed",
        "unsupported",
        "timeout",
        "network",
        "host_key_changed",
        "host_key_revoked",
        "secret_required",
        "invalid_passphrase",
        "keychain_unavailable",
        "not_connected",
        "busy",
        "permission_denied",
        "already_exists",
        "not_empty",
        "too_large",
        "missing_variables",
        "cancelled",
    ];

    fn every_event() -> Vec<Event> {
        let mut all = vec![
            Event::ConsentGranted,
            Event::TerminalOpened,
            Event::FilesOpened,
        ];
        for &theme in Theme::ALL {
            for &c in Count::ALL {
                all.push(Event::AppStarted {
                    theme,
                    hosts: c,
                    projects: c,
                    keys: c,
                });
            }
        }
        for &auth in Auth::ALL {
            all.push(Event::HostCreated { auth });
            for &duration in Took::ALL {
                all.push(Event::ConnectSucceeded { auth, duration });
            }
            for &code in ErrorCode::ALL {
                all.push(Event::ConnectFailed { auth, code });
            }
        }
        for &result in TestResult::ALL {
            all.push(Event::HostTestRun { result, code: None });
            for &code in ErrorCode::ALL {
                all.push(Event::HostTestRun {
                    result,
                    code: Some(code),
                });
            }
        }
        for &direction in TransferDirection::ALL {
            for &outcome in Outcome::ALL {
                for &files in Files::ALL {
                    all.push(Event::TransferFinished {
                        direction,
                        outcome,
                        files,
                    });
                }
            }
        }
        for &key_type in GeneratedType::ALL {
            for custom_folder in [true, false] {
                all.push(Event::KeyGenerated {
                    key_type,
                    custom_folder,
                });
            }
        }
        for &key_type in ImportedType::ALL {
            all.push(Event::KeyImported { key_type });
        }
        for &scope in Scope::ALL {
            for &count in Count::ALL {
                all.push(Event::VariablesSaved { scope, count });
            }
        }
        all
    }

    #[test]
    fn every_event_carries_only_catalogue_keys_and_values() {
        let allowed = allowed();
        let mut seen = std::collections::HashSet::new();
        for event in every_event() {
            let spec = &allowed[event.name()];
            seen.insert(event.name());
            let json = serde_json::to_value(event.props()).unwrap();
            for (k, v) in json.as_object().unwrap() {
                let values = spec
                    .get(k.as_str())
                    .unwrap_or_else(|| panic!("{} has {k}", event.name()));
                let text = match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    other => panic!("{} {k} is {other}", event.name()),
                };
                assert!(
                    values.contains(&text.as_str()),
                    "{} {k}={text}",
                    event.name()
                );
            }
            if let Event::HostTestRun { result, code } = event {
                assert_eq!(
                    json.get("code").is_some(),
                    result == TestResult::Failure && code.is_some(),
                    "{json}"
                );
            } else {
                assert_eq!(
                    json.as_object().unwrap().len(),
                    spec.len(),
                    "{}",
                    event.name()
                );
            }
        }
        assert_eq!(seen.len(), allowed.len());
    }

    #[test]
    fn error_codes_match_the_frontend_enum() {
        let ours: Vec<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
        let mut theirs: Vec<&str> = TS_CODES.to_vec();
        theirs.push("unknown");
        assert_eq!(ours, theirs);
        for code in TS_CODES {
            assert_eq!(ErrorCode::from_code(code).as_str(), *code);
        }
        for odd in [
            "unknown",
            "",
            "Timeout",
            "auth_failed ",
            "host 10.0.0.1 refused",
        ] {
            assert_eq!(ErrorCode::from_code(odd), ErrorCode::Unknown, "{odd}");
        }
    }

    #[test]
    fn buckets() {
        let c = |n| Count::of(n).as_str();
        assert_eq!(
            [
                c(0),
                c(1),
                c(2),
                c(5),
                c(6),
                c(20),
                c(21),
                c(50),
                c(51),
                c(9999)
            ],
            [
                "0", "1", "2-5", "2-5", "6-20", "6-20", "21-50", "21-50", "51+", "51+"
            ]
        );
        let f = |n| Files::of(n).as_str();
        assert_eq!(
            [f(0), f(1), f(2), f(10), f(11), f(100), f(101)],
            ["1", "1", "2-10", "2-10", "11-100", "11-100", "101+"]
        );
        let t = |ms| Took::of(Duration::from_millis(ms)).as_str();
        assert_eq!(
            [t(0), t(999), t(1000), t(2999), t(3000), t(9999), t(10_000)],
            ["<1s", "<1s", "1-3s", "1-3s", "3-10s", "3-10s", "10s+"]
        );
    }

    #[test]
    fn theme_comes_only_from_the_three_values() {
        for (raw, theme) in [
            ("light", Theme::Light),
            ("dark", Theme::Dark),
            ("system", Theme::System),
        ] {
            assert_eq!(serde_json::from_value::<Theme>(raw.into()).unwrap(), theme);
        }
        assert!(serde_json::from_value::<Theme>("Dark".into()).is_err());
        assert!(serde_json::from_value::<Theme>("solarized".into()).is_err());
    }
}

#[test]
fn a_grant_after_an_unsaved_deny_is_what_gets_saved() {
    let (a, _) = with_sink(granted());
    let _ = a.set_consent(false, |_| Err("io"), || COUNTS);
    a.set_consent(true, ok, || COUNTS).unwrap();
    assert!(a.status().persisted);
    assert!(a.collecting());
    a.retry_save(|_| -> Result<(), ()> { panic!("nothing to retry") });
}

#[test]
fn a_deny_waits_for_a_grant_being_saved_and_wins() {
    let (a, _) = with_sink(None);
    let disk = Arc::new(Mutex::new(None));
    let (in_save, saving) = mpsc::channel();
    let (release, go) = mpsc::channel::<()>();
    let grant = {
        let (a, disk) = (a.clone(), disk.clone());
        thread::spawn(move || {
            a.set_consent(
                true,
                |v| {
                    in_save.send(()).unwrap();
                    go.recv().unwrap();
                    *disk.lock().unwrap() = Some(v);
                    Ok::<_, ()>(())
                },
                || COUNTS,
            )
        })
    };
    saving.recv().unwrap();
    let deny = {
        let (a, disk) = (a.clone(), disk.clone());
        thread::spawn(move || {
            a.set_consent(
                false,
                |v| {
                    *disk.lock().unwrap() = Some(v);
                    Ok::<_, ()>(())
                },
                || COUNTS,
            )
        })
    };
    thread::sleep(Duration::from_millis(100));
    assert!(!deny.is_finished());
    release.send(()).unwrap();
    grant.join().unwrap().unwrap();
    deny.join().unwrap().unwrap();
    assert_eq!(disk.lock().unwrap().unwrap().consent, Consent::Denied);
    assert_eq!(a.status().consent, Consent::Denied);
    assert!(!a.collecting());
    assert!(a.recent().events.is_empty());
}

#[test]
fn interleaved_grants_and_denies_leave_memory_and_disk_equal() {
    let (a, _) = with_sink(None);
    let disk = Arc::new(Mutex::new(None::<AnalyticsConsent>));
    let threads: Vec<_> = (0..8)
        .map(|t| {
            let (a, disk) = (a.clone(), disk.clone());
            thread::spawn(move || {
                for i in 0..40 {
                    let granted = (t + i) % 3 != 0;
                    a.set_consent(
                        granted,
                        |v| {
                            thread::yield_now();
                            *disk.lock().unwrap() = Some(v);
                            Ok::<_, ()>(())
                        },
                        || COUNTS,
                    )
                    .unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let on_disk = disk.lock().unwrap().unwrap().consent;
    assert_eq!(a.status().consent, on_disk);
    assert_eq!(a.collecting(), on_disk == Consent::Granted);
}

#[test]
fn a_batch_taken_before_a_revoke_is_not_posted() {
    let (a, sink) = with_sink(granted());
    a.record(Event::TerminalOpened);
    let revoke = a.clone();
    *a.outbox().after_drain.lock().unwrap() = Some(Box::new(move || {
        revoke.set_consent(false, ok, || COUNTS).unwrap();
    }));
    a.flush(Duration::from_secs(1));
    assert!(sink.sent().is_empty());
    assert_eq!(a.queued(), 0);
}

#[test]
fn exit_flush_stays_bounded_while_a_periodic_flush_runs() {
    struct Slow;
    impl Transport for Slow {
        fn post(&self, _: &[u8], timeout: Duration) -> Posted {
            thread::sleep(timeout.min(Duration::from_secs(2)));
            Posted::Sent
        }
    }
    let a = Analytics::new(granted(), system(), Some(Box::new(Slow)));
    for _ in 0..BATCH * 8 {
        a.record(Event::TerminalOpened);
    }
    let periodic = {
        let a = a.clone();
        thread::spawn(move || a.flush(PERIODIC_FLUSH))
    };
    thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    a.shutdown();
    assert!(started.elapsed() <= EXIT_FLUSH + Duration::from_millis(500));
    periodic.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(a.queued() > 0);
}

#[test]
fn a_periodic_flush_has_a_deadline() {
    struct Hang;
    impl Transport for Hang {
        fn post(&self, _: &[u8], timeout: Duration) -> Posted {
            thread::sleep(timeout);
            Posted::Retry
        }
    }
    let a = Analytics::new(granted(), system(), Some(Box::new(Hang)));
    a.record(Event::TerminalOpened);
    let started = Instant::now();
    a.flush(Duration::from_millis(300));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(PERIODIC_FLUSH < FLUSH_INTERVAL);
}

#[test]
fn held_attempts_are_capped_oldest_reported_first() {
    let (a, _) = with_sink(granted());
    for i in 0..MAX_ATTEMPTS + 3 {
        a.attempt_pending(
            Attempt::Connect(format!("h{i}")),
            Event::ConnectFailed {
                auth: Auth::Key,
                code: if i == 0 {
                    ErrorCode::Timeout
                } else {
                    ErrorCode::SecretRequired
                },
            },
        );
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(a.attempts(), MAX_ATTEMPTS);
    let recent = a.recent();
    assert_eq!(recent.events.len(), 3);
    assert_eq!(
        serde_json::to_value(&recent.events[2].props).unwrap()["code"],
        "timeout"
    );
    a.attempt_pending(
        Attempt::Connect("h10".into()),
        Event::ConnectFailed {
            auth: Auth::Key,
            code: ErrorCode::AuthFailed,
        },
    );
    assert_eq!((a.attempts(), a.recent().events.len()), (MAX_ATTEMPTS, 3));
}

#[test]
fn debug_builds_never_send() {
    if cfg!(debug_assertions) {
        assert_eq!(app_key(), None);
        assert!(!Analytics::for_app(granted(), "0.1.0").available());
    }
}

#[test]
fn recent_shows_the_session_id_that_is_sent() {
    let (a, sink) = with_sink(granted());
    a.record(Event::TerminalOpened);
    a.flush(Duration::from_secs(1));
    let recent = a.recent();
    assert_eq!(sink.sent()[0][0]["sessionId"], recent.system.session_id);
    assert_eq!(recent.system.sdk_version, SDK_VERSION);
}
