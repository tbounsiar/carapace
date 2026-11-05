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

fn choice(consent: Consent, version: u32) -> CategoryChoice {
    CategoryChoice { consent, version }
}

const GRANTED: CategoryChoice = CategoryChoice {
    consent: Consent::Granted,
    version: CATALOGUE_VERSION,
};
const DENIED: CategoryChoice = CategoryChoice {
    consent: Consent::Denied,
    version: CATALOGUE_VERSION,
};
const UNSET: CategoryChoice = CategoryChoice {
    consent: Consent::Unset,
    version: 0,
};

fn stored(
    launch: CategoryChoice,
    features: CategoryChoice,
    connections: CategoryChoice,
) -> Option<AnalyticsSettings> {
    Some(AnalyticsSettings {
        categories: CategoryChoices {
            launch,
            features,
            connections,
        },
    })
}

fn granted() -> Option<AnalyticsSettings> {
    stored(GRANTED, GRANTED, GRANTED)
}

/// That category granted, the two others denied.
fn only(category: Category) -> Option<AnalyticsSettings> {
    let mut s = CategoryChoices::all(DENIED);
    s.set(category, GRANTED);
    Some(AnalyticsSettings { categories: s })
}

fn with_sink(stored: Option<AnalyticsSettings>) -> (Analytics, Sink) {
    let sink = Sink::new(Posted::Sent);
    (
        Analytics::new(stored, system(), Some(Box::new(sink.clone())), false),
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

type Writes<'a> = &'a [(Category, CategoryChoice)];

fn apply(mut base: CategoryChoices, writes: Writes) -> AnalyticsSettings {
    for &(c, choice) in writes {
        base.set(c, choice);
    }
    AnalyticsSettings { categories: base }
}

/// What the file would hold if it matched memory before this save.
fn mirrored(a: &Analytics, writes: Writes) -> AnalyticsSettings {
    apply(a.stored_for_tests(), writes)
}

fn mirror(a: &Analytics) -> impl FnOnce(Writes) -> Result<AnalyticsSettings, ()> + '_ {
    move |w| Ok(mirrored(a, w))
}

/// A config file in memory, updated like `ConfigStore::update_analytics`.
#[derive(Clone, Default)]
struct Disk(Arc<Mutex<Option<AnalyticsSettings>>>);

impl Disk {
    fn holding(stored: Option<AnalyticsSettings>) -> Self {
        Self(Arc::new(Mutex::new(stored)))
    }

    fn save(&self, writes: Writes) -> Result<AnalyticsSettings, ()> {
        let mut v = self.0.lock().unwrap();
        let next = apply(v.unwrap_or_default().categories, writes);
        *v = Some(next);
        Ok(next)
    }

    fn value(&self) -> CategoryChoices {
        self.0.lock().unwrap().unwrap_or_default().categories
    }
}

fn choices(launch: bool, features: bool, connections: bool) -> AnalyticsChoices {
    AnalyticsChoices {
        launch,
        features,
        connections,
    }
}

fn one_of_each() -> [Event; 3] {
    [
        Event::SessionStarted,
        Event::TerminalOpened,
        Event::ConnectFailed {
            auth: Auth::Key,
            code: ErrorCode::Timeout,
        },
    ]
}

fn exercise(a: &Analytics) {
    a.launched();
    for e in one_of_each() {
        a.record(e);
    }
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
}

#[test]
fn nothing_is_recorded_without_consent() {
    let outdated = choice(Consent::Granted, 0);
    for stored in [
        None,
        stored(UNSET, UNSET, UNSET),
        stored(DENIED, DENIED, DENIED),
        stored(outdated, outdated, outdated),
        stored(choice(Consent::Granted, 1), UNSET, DENIED),
    ] {
        let (a, sink) = with_sink(stored);
        exercise(&a);
        assert!(a.recent().events.is_empty());
        assert_eq!(a.queued(), 0);
        a.flush(Duration::from_secs(1));
        assert!(sink.sent().is_empty());
        for c in Category::ALL {
            assert!(!a.collecting(c));
        }
    }
}

#[test]
fn do_not_track_closes_every_gate_and_keeps_the_choices() {
    let sink = Sink::new(Posted::Sent);
    let a = Analytics::new(granted(), system(), Some(Box::new(sink.clone())), true);
    exercise(&a);
    assert!(a.recent().events.is_empty());
    assert_eq!(a.queued(), 0);
    let s = a.status();
    assert!(s.do_not_track);
    assert_eq!(s.categories, choices(true, true, true));
    assert!(!s.ask_needed);
    let mut saved = Vec::new();
    a.set_category(
        Category::Features,
        true,
        |w| {
            let v = mirrored(&a, w);
            saved.push(v);
            Ok::<_, ()>(v)
        },
        || COUNTS,
    )
    .unwrap();
    assert!(a.recent().events.is_empty());
    assert_eq!(saved, vec![granted().unwrap()]);

    let a = Analytics::new(None, system(), None, true);
    let s = a.status();
    assert_eq!(s.pending, Category::ALL);
    assert!(!s.ask_needed);
}

#[test]
fn do_not_track_parsing() {
    use std::ffi::OsStr;
    assert!(!do_not_track(None));
    for off in ["", "0", "false", "FALSE", "False", " 0 ", " false\t", "  "] {
        assert!(!do_not_track(Some(OsStr::new(off))), "{off:?}");
    }
    for on in ["1", "yes", "true", "TRUE", "no", "00", "2", " 1 "] {
        assert!(do_not_track(Some(OsStr::new(on))), "{on:?}");
    }
}

#[test]
fn each_category_gates_its_own_events() {
    for category in Category::ALL {
        let (a, sink) = with_sink(only(category));
        for e in one_of_each() {
            a.record(e);
        }
        let expected: Vec<&str> = one_of_each()
            .iter()
            .filter(|e| e.category() == category)
            .map(Event::name)
            .collect();
        assert_eq!(names(&a), expected, "{category:?}");
        a.flush(Duration::from_secs(1));
        assert_eq!(sink.names(), expected, "{category:?}");
        for c in Category::ALL {
            assert_eq!(a.collecting(c), c == category);
        }
    }
}

#[test]
fn every_event_belongs_to_its_spec_category() {
    let spec = |name: &str| match name {
        "session_started" => Category::Launch,
        "app_started" | "host_created" | "terminal_opened" | "files_opened"
        | "transfer_finished" | "key_generated" | "key_imported" | "variables_saved" => {
            Category::Features
        }
        "connect_succeeded" | "connect_failed" | "host_test_run" => Category::Connections,
        other => panic!("{other} is not in the catalogue"),
    };
    for event in catalogue::every_event() {
        assert_eq!(event.category(), spec(event.name()), "{}", event.name());
    }
    let json = serde_json::to_value(Category::ALL).unwrap();
    assert_eq!(
        json,
        serde_json::json!(["launch", "features", "connections"])
    );
}

#[test]
fn versions_are_per_category() {
    assert_eq!(CATALOGUE_VERSION, 2);
    assert_eq!(
        Category::ALL.map(changed_in),
        [2, 1, 1],
        "launch, features, connections"
    );
    assert!(
        Category::ALL
            .iter()
            .all(|&c| changed_in(c) <= CATALOGUE_VERSION)
    );
    // A launch grant from version 1 is outdated; feature and connection grants from 1 are not.
    let v1 = choice(Consent::Granted, 1);
    let a = Analytics::new(stored(v1, v1, v1), system(), None, false);
    let s = a.status();
    assert_eq!(s.categories, choices(false, true, true));
    assert_eq!(s.pending, [Category::Launch]);
    assert!(s.ask_needed);
}

#[test]
fn pending_and_ask_needed() {
    let view = |stored| Analytics::new(stored, system(), None, false).status();
    let old = choice(Consent::Granted, 0);
    let cases = [
        (
            None,
            vec![Category::Launch, Category::Features, Category::Connections],
        ),
        (stored(GRANTED, UNSET, DENIED), vec![Category::Features]),
        (stored(old, DENIED, GRANTED), vec![Category::Launch]),
        (stored(DENIED, DENIED, DENIED), vec![]),
        (granted(), vec![]),
        (
            stored(choice(Consent::Denied, 0), old, UNSET),
            vec![Category::Features, Category::Connections],
        ),
    ];
    for (stored, pending) in cases {
        let s = view(stored);
        assert_eq!(s.ask_needed, !pending.is_empty(), "{stored:?}");
        assert_eq!(s.pending, pending, "{stored:?}");
    }
    assert!(with_sink(None).0.status().available);
    let json = serde_json::to_value(view(stored(GRANTED, UNSET, DENIED))).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "categories": {"launch": true, "features": false, "connections": false},
            "pending": ["features"],
            "doNotTrack": false,
            "askNeeded": true,
            "available": false,
            "persisted": true,
        })
    );
}

#[test]
fn session_started_once_at_launch() {
    let (a, sink) = with_sink(only(Category::Launch));
    a.launched();
    a.launched();
    assert_eq!(names(&a), ["session_started"]);
    a.set_category(Category::Launch, true, mirror(&a), || COUNTS)
        .unwrap();
    a.set_choices(choices(true, true, true), mirror(&a), || COUNTS)
        .unwrap();
    assert_eq!(names(&a), ["session_started"]);
    a.flush(Duration::from_secs(1));
    assert_eq!(sink.names(), ["session_started"]);
    let props = &sink.sent()[0][0]["props"];
    assert_eq!(props, &serde_json::json!({}));
}

#[test]
fn session_started_follows_a_grant_and_never_repeats() {
    let (a, _) = with_sink(None);
    a.launched();
    assert!(a.recent().events.is_empty());
    a.set_category(Category::Launch, true, mirror(&a), || COUNTS)
        .unwrap();
    assert_eq!(names(&a), ["session_started"]);
    a.set_category(Category::Launch, false, mirror(&a), || COUNTS)
        .unwrap();
    assert!(a.recent().events.is_empty());
    a.set_category(Category::Launch, true, mirror(&a), || COUNTS)
        .unwrap();
    assert!(a.recent().events.is_empty());
}

#[test]
fn the_dialog_saves_all_three_in_one_write() {
    let (a, _) = with_sink(None);
    a.launched();
    a.app_started(Theme::System, || COUNTS);
    let mut saved = Vec::new();
    let s = a
        .set_choices(
            choices(true, true, false),
            |w| {
                let v = mirrored(&a, w);
                saved.push(v);
                Ok::<_, ()>(v)
            },
            || COUNTS,
        )
        .unwrap();
    assert_eq!(saved, vec![stored(GRANTED, GRANTED, DENIED).unwrap()]);
    assert_eq!(s.categories, choices(true, true, false));
    assert!(s.pending.is_empty() && !s.ask_needed && s.persisted);
    assert_eq!(names(&a), ["app_started", "session_started"]);
    assert_eq!(
        serde_json::to_value(&a.recent().events[0].props).unwrap(),
        serde_json::json!({"theme": "system", "hosts": "6-20", "projects": "1", "keys": "0"})
    );
}

#[test]
fn a_category_change_touches_that_category_only() {
    let old = choice(Consent::Granted, 1);
    let (a, _) = with_sink(stored(old, UNSET, DENIED));
    let mut saved = Vec::new();
    a.set_category(
        Category::Connections,
        true,
        |w| {
            let v = mirrored(&a, w);
            saved.push(v);
            Ok::<_, ()>(v)
        },
        || panic!("counts read without a feature grant"),
    )
    .unwrap();
    assert_eq!(saved, vec![stored(old, UNSET, GRANTED).unwrap()]);
    let s = a.status();
    assert_eq!(s.categories, choices(false, false, true));
    assert_eq!(s.pending, [Category::Launch, Category::Features]);
}

#[test]
fn app_started_once_per_launch_whenever_features_open() {
    let (a, _) = with_sink(None);
    a.set_category(Category::Features, true, mirror(&a), || COUNTS)
        .unwrap();
    assert!(a.recent().events.is_empty());
    a.app_started(Theme::Light, || COUNTS);
    a.app_started(Theme::Light, || COUNTS);
    assert_eq!(names(&a), ["app_started"]);
    a.set_category(Category::Features, false, mirror(&a), || COUNTS)
        .unwrap();
    a.set_category(Category::Features, true, mirror(&a), || {
        panic!("app_started twice")
    })
    .unwrap();
    a.app_started(Theme::Light, || panic!("app_started twice"));
    assert!(a.recent().events.is_empty());
}

#[test]
fn a_failed_save_of_a_grant_changes_nothing() {
    let (a, sink) = with_sink(None);
    a.launched();
    a.app_started(Theme::Dark, || COUNTS);
    assert_eq!(
        a.set_choices(choices(true, true, true), |_| Err("io"), || COUNTS),
        Err("io")
    );
    assert_eq!(
        a.set_category(Category::Launch, true, |_| Err("io"), || COUNTS),
        Err("io")
    );
    let s = a.status();
    assert_eq!(s.categories, choices(false, false, false));
    assert_eq!(s.pending.len(), 3);
    assert!(s.persisted);
    assert!(a.recent().events.is_empty());
    a.flush(Duration::from_secs(1));
    assert!(sink.sent().is_empty());
}

#[test]
fn turning_a_category_off_drops_only_its_log_queue_and_attempts() {
    let (a, sink) = with_sink(granted());
    a.launched();
    a.record(Event::TerminalOpened);
    a.files_listed("c");
    a.record(Event::ConnectSucceeded {
        auth: Auth::Agent,
        duration: Took::UnderOne,
    });
    a.attempt_pending(
        Attempt::Test(String::new()),
        Event::test_ended(TestResult::Cancelled),
    );
    assert_eq!(a.queued(), 4);
    let s = a
        .set_category(Category::Connections, false, mirror(&a), || {
            panic!("counts on deny")
        })
        .unwrap();
    assert_eq!(s.categories, choices(true, true, false));
    assert_eq!(a.attempts(), 0);
    assert_eq!(a.queued(), 3);
    assert_eq!(
        names(&a),
        ["files_opened", "terminal_opened", "session_started"]
    );
    a.set_category(Category::Features, false, mirror(&a), || COUNTS)
        .unwrap();
    assert_eq!(names(&a), ["session_started"]);
    assert_eq!(a.queued(), 1);
    a.record(Event::TerminalOpened);
    a.files_listed("d");
    a.expire_attempts(Duration::ZERO);
    a.flush(Duration::from_secs(1));
    assert_eq!(sink.names(), ["session_started"]);

    a.set_category(Category::Features, true, mirror(&a), || COUNTS)
        .unwrap();
    a.files_listed("c");
    assert_eq!(names(&a), ["files_opened", "session_started"]);
}

#[test]
fn denying_everything_sends_nothing_about_it() {
    let (a, sink) = with_sink(granted());
    a.launched();
    a.record(Event::TerminalOpened);
    let mut saved = Vec::new();
    let s = a
        .set_choices(
            choices(false, false, false),
            |w| {
                let v = mirrored(&a, w);
                saved.push(v);
                Ok::<_, ()>(v)
            },
            || panic!("counts read on deny"),
        )
        .unwrap();
    assert_eq!(saved, vec![stored(DENIED, DENIED, DENIED).unwrap()]);
    assert_eq!(s.categories, choices(false, false, false));
    assert!(!s.ask_needed);
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
    a.record(Event::test_ended(TestResult::Success));
    assert_eq!(
        a.set_choices(choices(true, false, true), |_| Err("io"), || COUNTS),
        Err("io")
    );
    assert!(!a.collecting(Category::Features));
    assert!(a.collecting(Category::Connections));
    assert_eq!(a.queued(), 1);
    let s = a.status();
    assert_eq!(
        (s.categories, s.persisted),
        (choices(true, false, true), false)
    );
    a.retry_save(|_| Err::<AnalyticsSettings, _>("io"));
    assert!(!a.status().persisted);
    let mut saved = Vec::new();
    a.retry_save(|w| {
        let v = mirrored(&a, w);
        saved.push(v);
        Ok::<_, ()>(v)
    });
    assert_eq!(saved, vec![stored(GRANTED, DENIED, GRANTED).unwrap()]);
    assert!(a.status().persisted);
    a.retry_save(|_| -> Result<AnalyticsSettings, ()> { panic!("saved twice") });
    a.record(Event::TerminalOpened);
    assert_eq!(names(&a), ["host_test_run"]);
}

#[test]
fn a_failed_mixed_save_applies_the_deny_but_not_the_grant() {
    let (a, _) = with_sink(stored(UNSET, GRANTED, UNSET));
    assert_eq!(
        a.set_choices(choices(true, false, false), |_| Err("io"), || COUNTS),
        Err("io")
    );
    let s = a.status();
    assert_eq!(s.categories, choices(false, false, false));
    assert_eq!(s.pending, [Category::Launch]);
    assert!(!s.persisted);
    let mut saved = Vec::new();
    a.retry_save(|w| {
        let v = mirrored(&a, w);
        saved.push(v);
        Ok::<_, ()>(v)
    });
    assert_eq!(saved, vec![stored(UNSET, DENIED, DENIED).unwrap()]);
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
    let a = Analytics::new(granted(), system(), None, false);
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
    let a = Analytics::new(granted(), system(), Some(Box::new(sink.clone())), false);
    a.record(Event::TerminalOpened);
    for _ in 0..MAX_TRIES + 2 {
        a.flush(Duration::from_secs(1));
    }
    assert_eq!(sink.sent().len(), usize::from(MAX_TRIES));
    assert_eq!(a.queued(), 0);

    let sink = Sink::new(Posted::Rejected);
    let a = Analytics::new(granted(), system(), Some(Box::new(sink.clone())), false);
    a.record(Event::TerminalOpened);
    a.flush(Duration::from_secs(1));
    a.flush(Duration::from_secs(1));
    assert_eq!(sink.sent().len(), 1);

    let sink = Sink::new(Posted::Sent);
    sink.script.lock().unwrap().push_back(Posted::Retry);
    let a = Analytics::new(granted(), system(), Some(Box::new(sink.clone())), false);
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
                a.set_choices(choices(false, false, false), mirror(&a), || COUNTS)
                    .unwrap();
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
    let a = Analytics::new(
        granted(),
        system(),
        Some(Box::new(Shared(t.clone()))),
        false,
    );
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
    let a = Analytics::new(granted(), system(), Some(Box::new(http(&base))), false);
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
    let a = Analytics::new(granted(), system(), Some(Box::new(http(&base))), false);
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
        false,
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
            ("session_started", HashMap::new()),
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

    pub(super) fn every_event() -> Vec<Event> {
        let mut all = vec![
            Event::SessionStarted,
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
    let _ = a.set_category(Category::Features, false, |_| Err("io"), || COUNTS);
    let mut saved = Vec::new();
    a.set_category(
        Category::Features,
        true,
        |w| {
            let v = mirrored(&a, w);
            saved.push(v);
            Ok::<_, ()>(v)
        },
        || COUNTS,
    )
    .unwrap();
    assert_eq!(saved, vec![granted().unwrap()]);
    assert!(a.status().persisted);
    assert!(a.collecting(Category::Features));
    a.retry_save(|_| -> Result<AnalyticsSettings, ()> { panic!("nothing to retry") });
}

#[test]
fn an_unsaved_deny_is_written_with_the_next_grant_of_another_category() {
    let (a, _) = with_sink(stored(UNSET, GRANTED, UNSET));
    let _ = a.set_category(Category::Features, false, |_| Err("io"), || COUNTS);
    let mut saved = Vec::new();
    a.set_category(
        Category::Launch,
        true,
        |w| {
            let v = mirrored(&a, w);
            saved.push(v);
            Ok::<_, ()>(v)
        },
        || COUNTS,
    )
    .unwrap();
    assert_eq!(saved, vec![stored(GRANTED, DENIED, UNSET).unwrap()]);
    assert!(a.status().persisted);
}

#[test]
fn a_deny_waits_for_a_grant_being_saved_and_wins() {
    let (a, _) = with_sink(None);
    let disk = Disk::default();
    let (in_save, saving) = mpsc::channel();
    let (release, go) = mpsc::channel::<()>();
    let grant = {
        let (a, disk) = (a.clone(), disk.clone());
        thread::spawn(move || {
            a.set_category(
                Category::Connections,
                true,
                |w| {
                    in_save.send(()).unwrap();
                    go.recv().unwrap();
                    disk.save(w)
                },
                || COUNTS,
            )
        })
    };
    saving.recv().unwrap();
    let deny = {
        let (a, disk) = (a.clone(), disk.clone());
        thread::spawn(move || {
            a.set_category(Category::Connections, false, |w| disk.save(w), || COUNTS)
        })
    };
    thread::sleep(Duration::from_millis(100));
    assert!(!deny.is_finished());
    release.send(()).unwrap();
    grant.join().unwrap().unwrap();
    deny.join().unwrap().unwrap();
    assert_eq!(disk.value().connections, DENIED);
    assert!(!a.status().categories.connections);
    assert!(!a.collecting(Category::Connections));
    assert!(a.recent().events.is_empty());
}

#[test]
fn interleaved_changes_leave_memory_and_disk_equal() {
    let (a, _) = with_sink(None);
    let disk = Disk::default();
    let threads: Vec<_> = (0..8)
        .map(|t| {
            let (a, disk) = (a.clone(), disk.clone());
            thread::spawn(move || {
                for i in 0..40usize {
                    let granted = (t + i) % 3 != 0;
                    let save = |w: Writes| {
                        thread::yield_now();
                        disk.save(w)
                    };
                    if i % 4 == 0 {
                        a.set_choices(choices(granted, !granted, granted), save, || COUNTS)
                    } else {
                        a.set_category(Category::ALL[(t + i) % 3], granted, save, || COUNTS)
                    }
                    .unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let on_disk = disk.value();
    for c in Category::ALL {
        let granted = on_disk.get(c).consent == Consent::Granted;
        assert_eq!(a.status().categories.get(c), granted, "{c:?}");
        assert_eq!(a.collecting(c), granted, "{c:?}");
    }
}

#[test]
fn a_batch_taken_before_a_category_is_turned_off_posts_only_the_others() {
    let (a, sink) = with_sink(granted());
    a.record(Event::TerminalOpened);
    a.record(Event::test_ended(TestResult::Success));
    let revoke = a.clone();
    *a.outbox().after_drain.lock().unwrap() = Some(Box::new(move || {
        revoke
            .set_category(Category::Features, false, mirror(&revoke), || COUNTS)
            .unwrap();
    }));
    a.flush(Duration::from_secs(1));
    assert_eq!(sink.names(), ["host_test_run"]);
    assert_eq!(a.queued(), 0);
}

#[test]
fn a_failed_batch_is_not_requeued_for_a_category_turned_off() {
    struct DenyWhilePosting(Mutex<Option<Analytics>>);
    impl Transport for DenyWhilePosting {
        fn post(&self, _: &[u8], _: Duration) -> Posted {
            if let Some(a) = self.0.lock().unwrap().take() {
                a.set_category(Category::Features, false, mirror(&a), || COUNTS)
                    .unwrap();
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
    let a = Analytics::new(
        granted(),
        system(),
        Some(Box::new(Shared(t.clone()))),
        false,
    );
    *t.0.lock().unwrap() = Some(a.clone());
    a.record(Event::TerminalOpened);
    a.record(Event::test_ended(TestResult::Success));
    a.flush(Duration::from_secs(1));
    assert_eq!(a.queued(), 1);
}

#[test]
fn a_batch_taken_before_a_revoke_is_not_posted() {
    let (a, sink) = with_sink(granted());
    a.record(Event::TerminalOpened);
    let revoke = a.clone();
    *a.outbox().after_drain.lock().unwrap() = Some(Box::new(move || {
        revoke
            .set_category(Category::Features, false, mirror(&revoke), || COUNTS)
            .unwrap();
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
    let a = Analytics::new(granted(), system(), Some(Box::new(Slow)), false);
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
    let a = Analytics::new(granted(), system(), Some(Box::new(Hang)), false);
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
        assert!(!Analytics::for_app(Ok::<_, ()>(granted()), "0.1.0").available());
        assert_eq!(
            Analytics::for_app(Ok::<_, ()>(granted()), "0.1.0").recorded(),
            []
        );
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

#[test]
fn an_unread_config_closes_every_gate_and_asks_nothing() {
    let sink = Sink::new(Posted::Sent);
    let a = Analytics::new(granted(), system(), Some(Box::new(sink.clone())), false).unread();
    exercise(&a);
    assert!(a.recent().events.is_empty());
    assert_eq!(a.queued(), 0);
    let s = a.status();
    assert_eq!(s.categories, choices(false, false, false));
    assert!(s.pending.is_empty());
    assert!(!s.ask_needed);
    assert!(a.is_unread());
}

#[test]
fn reload_adopts_what_the_file_holds_and_starts_the_session() {
    let a = Analytics::new(None, system(), None, false).unread();
    a.reload(|| Err::<Option<AnalyticsSettings>, _>("io"));
    assert!(a.is_unread());
    assert!(!a.status().ask_needed);
    a.reload(|| Ok::<_, ()>(only(Category::Launch)));
    assert!(!a.is_unread());
    assert_eq!(a.status().categories, choices(true, false, false));
    assert_eq!(names(&a), ["session_started"]);
    a.reload(|| -> Result<Option<AnalyticsSettings>, ()> { panic!("read twice") });
    a.launched();
    assert_eq!(names(&a), ["session_started"]);

    let a = Analytics::new(None, system(), None, false).unread();
    a.reload(|| Ok::<_, ()>(None));
    let s = a.status();
    assert_eq!(s.pending, Category::ALL);
    assert!(s.ask_needed);
}

#[test]
fn a_change_applies_only_its_categories_on_top_of_the_file() {
    let disk = Disk::holding(stored(DENIED, DENIED, DENIED));
    let a = Analytics::new(None, system(), None, false).unread();
    let s = a
        .set_category(Category::Features, true, |w| disk.save(w), || COUNTS)
        .unwrap();
    assert_eq!(
        disk.value(),
        stored(DENIED, GRANTED, DENIED).unwrap().categories
    );
    assert_eq!(s.categories, choices(false, true, false));
    assert!(s.pending.is_empty() && !s.ask_needed);
    assert!(!a.is_unread());
    assert!(a.recent().events.is_empty());

    // Memory believed launch was granted; the file says denied, and the file wins.
    let disk = Disk::holding(stored(DENIED, UNSET, UNSET));
    let (a, sink) = with_sink(granted());
    a.launched();
    a.record(Event::TerminalOpened);
    let s = a
        .set_category(Category::Connections, true, |w| disk.save(w), || COUNTS)
        .unwrap();
    assert_eq!(
        disk.value(),
        stored(DENIED, UNSET, GRANTED).unwrap().categories
    );
    assert_eq!(s.categories, choices(false, false, true));
    assert_eq!(s.pending, [Category::Features]);
    assert!(a.recent().events.is_empty());
    a.flush(Duration::from_secs(1));
    assert!(sink.sent().is_empty());
}

#[test]
fn a_failed_read_turns_nothing_on() {
    let a = Analytics::new(None, system(), None, false).unread();
    assert_eq!(
        a.set_category(Category::Launch, true, |_| Err("unreadable"), || COUNTS),
        Err("unreadable")
    );
    assert!(a.is_unread());
    assert!(!a.collecting(Category::Launch));
    assert!(a.recent().events.is_empty());
}

#[test]
fn a_retried_save_writes_only_the_refusals() {
    let disk = Disk::holding(stored(DENIED, GRANTED, UNSET));
    let (a, _) = with_sink(granted());
    let _ = a.set_category(Category::Features, false, |_| Err("io"), || COUNTS);
    a.retry_save(|w| {
        assert_eq!(w, [(Category::Features, DENIED)]);
        disk.save(w)
    });
    assert_eq!(
        disk.value(),
        stored(DENIED, DENIED, UNSET).unwrap().categories
    );
    let s = a.status();
    assert!(s.persisted);
    assert_eq!(s.categories, choices(false, false, false));
    assert_eq!(s.pending, [Category::Connections]);
}

#[test]
fn a_category_turned_off_after_its_batch_is_serialized_is_not_posted() {
    let (a, sink) = with_sink(granted());
    a.record(Event::TerminalOpened);
    a.record(Event::test_ended(TestResult::Success));
    let revoke = a.clone();
    *a.outbox().before_post.lock().unwrap() = Some(Box::new(move || {
        revoke
            .set_category(Category::Features, false, mirror(&revoke), || COUNTS)
            .unwrap();
    }));
    a.flush(Duration::from_secs(1));
    assert_eq!(sink.names(), ["host_test_run"]);
    assert_eq!(sink.sent().len(), 1);
    assert_eq!(a.queued(), 0);
}
