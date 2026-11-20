use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use tauri_plugin_updater::Error as PluginError;

use super::*;
use crate::config::UpdateSettings;
use crate::text::Localized;

type Handle = &'static str;

fn info(version: &str) -> UpdateInfo {
    UpdateInfo {
        version: version.into(),
        date: None,
    }
}

fn found(version: &'static str) -> Option<(UpdateInfo, Handle)> {
    Some((info(version), version))
}

fn updates() -> Updates<Handle> {
    Updates::new("0.2.0", InstallKind::InPlace)
}

fn recorder() -> (Emit, Arc<Mutex<Vec<UpdateEvent>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let emit: Emit = Arc::new(move |e| {
        s.lock().unwrap().push(e);
        true
    });
    (emit, seen)
}

fn versions(seen: &Mutex<Vec<UpdateEvent>>) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|UpdateEvent::Available { info }| info.version.clone())
        .collect()
}

fn prefs(auto_check: bool, skipped: Option<&str>) -> Prefs {
    Prefs {
        auto_check,
        skipped: skipped.map(str::to_owned),
    }
}

#[test]
fn auto_check_is_on_by_default_and_off_when_the_file_cannot_be_read() {
    assert_eq!(Prefs::of(Some(&Settings::default())), prefs(true, None));
    let off = Settings {
        updates: UpdateSettings {
            auto_check: Some(false),
            skipped_version: Some("0.3.0".into()),
        },
        ..Settings::default()
    };
    assert_eq!(Prefs::of(Some(&off)), prefs(false, Some("0.3.0")));
    assert_eq!(Prefs::of(None), prefs(false, None));
}

#[test]
fn the_skipped_version_is_not_announced_and_another_one_is() {
    let u = updates();
    let (emit, seen) = recorder();
    u.subscribe(emit, None);
    u.checked(found("0.3.0"), "t1".into());
    u.notify(Some("0.3.0"));
    assert!(versions(&seen).is_empty());
    u.checked(found("0.4.0"), "t2".into());
    u.notify(Some("0.3.0"));
    assert_eq!(versions(&seen), ["0.4.0"]);
}

#[test]
fn a_late_subscriber_hears_about_the_update_found() {
    let u = updates();
    u.checked(found("0.3.0"), "t".into());
    u.notify(None);
    let (emit, seen) = recorder();
    u.subscribe(emit, None);
    assert_eq!(versions(&seen), ["0.3.0"]);

    let (emit, seen) = recorder();
    u.subscribe(emit, Some("0.3.0"));
    assert!(versions(&seen).is_empty());

    let u = updates();
    let (emit, seen) = recorder();
    u.subscribe(emit, None);
    assert!(versions(&seen).is_empty(), "nothing found yet");
}

#[test]
fn a_subscriber_that_cannot_be_reached_is_dropped() {
    let u = updates();
    let calls = Arc::new(AtomicBool::new(false));
    let c = calls.clone();
    u.checked(found("0.3.0"), "t".into());
    u.subscribe(
        Arc::new(move |_| {
            assert!(!c.swap(true, Ordering::SeqCst), "called once only");
            false
        }),
        None,
    );
    u.notify(None);
    assert!(calls.load(Ordering::SeqCst));
}

#[test]
fn a_manual_check_ignores_the_skipped_version_and_records_the_time() {
    let u = updates();
    let (emit, seen) = recorder();
    u.subscribe(emit, Some("0.3.0"));
    let p = prefs(true, Some("0.3.0"));
    assert_eq!(u.state(&p).last_check, None);
    assert_eq!(u.checked(found("0.3.0"), "t".into()), Some(info("0.3.0")));
    let state = u.state(&p);
    assert_eq!(state.available, Some(info("0.3.0")));
    assert_eq!(state.last_check.as_deref(), Some("t"));
    assert_eq!(state.skipped_version.as_deref(), Some("0.3.0"));
    assert!(
        versions(&seen).is_empty(),
        "a manual check answers its caller only"
    );
    assert_eq!(u.checked(None, "t2".into()), None);
    assert_eq!(u.state(&p).available, None);
}

#[test]
fn state_serializes_in_camel_case() {
    let u = updates();
    u.checked(
        Some((
            UpdateInfo {
                version: "0.3.0".into(),
                date: Some("2026-11-20T10:00:00.000Z".into()),
            },
            "h",
        )),
        "2026-11-20T11:00:00.000Z".into(),
    );
    let state = serde_json::to_value(u.state(&prefs(true, None))).unwrap();
    assert_eq!(
        state,
        json!({
            "current": "0.2.0",
            "autoCheck": true,
            "skippedVersion": null,
            "lastCheck": "2026-11-20T11:00:00.000Z",
            "available": { "version": "0.3.0", "date": "2026-11-20T10:00:00.000Z" },
            "downloaded": false,
            "installKind": "inPlace",
        })
    );
    let event = UpdateEvent::Available {
        info: info("1.0.0"),
    };
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({ "kind": "available", "info": { "version": "1.0.0", "date": null } })
    );
    let progress = Progress {
        downloaded: 3,
        total: None,
    };
    assert_eq!(
        serde_json::to_value(progress).unwrap(),
        json!({ "downloaded": 3, "total": null })
    );
    assert_eq!(
        serde_json::to_value(InstallKind::DownloadOnly).unwrap(),
        json!("downloadOnly")
    );
}

fn start(u: &Updates<Handle>) -> (u64, oneshot::Receiver<()>) {
    match u.begin_download() {
        Ok(Begin::Start {
            generation, cancel, ..
        }) => (generation, cancel),
        _ => panic!("expected a new download"),
    }
}

#[test]
fn download_then_install() {
    let u = updates();
    assert_eq!(u.begin_download().err(), Some(UpdateError::NoUpdate));
    assert_eq!(
        u.begin_install().err(),
        Some(UpdateError::NothingDownloaded)
    );
    u.checked(found("0.3.0"), "t".into());
    let (generation, _cancel) = start(&u);
    assert_eq!(u.begin_download().err(), Some(UpdateError::Busy));
    assert_eq!(u.begin_install().err(), Some(UpdateError::Busy));
    u.finish_download(generation, Ok(vec![1, 2, 3])).unwrap();
    assert!(u.state(&prefs(true, None)).downloaded);
    assert!(matches!(u.begin_download(), Ok(Begin::Done(3))));

    let (handle, bytes) = u.begin_install().unwrap();
    assert_eq!((handle, bytes.as_slice()), ("0.3.0", &[1u8, 2, 3][..]));
    assert_eq!(u.begin_install().err(), Some(UpdateError::Busy));
    assert_eq!(u.begin_download().err(), Some(UpdateError::Busy));
    u.install_failed(Some(bytes));
    assert!(u.state(&prefs(true, None)).downloaded);
    let (_, _) = u.begin_install().unwrap();
    u.install_failed(None);
    assert_eq!(
        u.begin_install().err(),
        Some(UpdateError::NothingDownloaded)
    );
}

#[test]
fn a_failed_download_leaves_nothing() {
    let u = updates();
    u.checked(found("0.3.0"), "t".into());
    let (generation, _cancel) = start(&u);
    assert_eq!(
        u.finish_download(generation, Err(UpdateError::Signature)),
        Err(UpdateError::Signature)
    );
    assert!(!u.state(&prefs(true, None)).downloaded);
    start(&u);
}

#[test]
fn a_cancelled_download_drops_its_bytes() {
    let u = updates();
    assert!(!u.cancel_download());
    u.checked(found("0.3.0"), "t".into());
    let (generation, mut cancel) = start(&u);
    assert!(u.cancel_download());
    assert!(cancel.try_recv().is_ok());
    assert_eq!(
        u.finish_download(generation, Ok(vec![1])),
        Err(UpdateError::Cancelled)
    );
    assert!(!u.state(&prefs(true, None)).downloaded);
    let (next, _c) = start(&u);
    assert_eq!(
        u.finish_download(generation, Ok(vec![1])),
        Err(UpdateError::Cancelled),
        "an older download never lands"
    );
    u.finish_download(next, Ok(vec![2])).unwrap();
}

#[test]
fn a_new_version_drops_the_package_of_the_old_one() {
    let u = updates();
    u.checked(found("0.3.0"), "t".into());
    let (g, _c) = start(&u);
    u.finish_download(g, Ok(vec![1])).unwrap();
    u.checked(found("0.3.0"), "t2".into());
    assert!(u.state(&prefs(true, None)).downloaded, "same version kept");
    u.checked(found("0.4.0"), "t3".into());
    let state = u.state(&prefs(true, None));
    assert!(!state.downloaded);
    assert_eq!(state.available, Some(info("0.4.0")));
}

#[test]
fn a_check_during_a_download_keeps_the_update_being_downloaded() {
    let u = updates();
    u.checked(found("0.3.0"), "t".into());
    let (g, _c) = start(&u);
    assert_eq!(u.checked(found("0.4.0"), "t2".into()), Some(info("0.4.0")));
    u.finish_download(g, Ok(vec![1])).unwrap();
    let state = u.state(&prefs(true, None));
    assert_eq!(state.available, Some(info("0.3.0")));
    assert!(state.downloaded);
    assert_eq!(state.last_check.as_deref(), Some("t2"));
}

#[test]
fn download_only_systems_never_download_or_install() {
    let u: Updates<Handle> = Updates::new("0.2.0", InstallKind::DownloadOnly);
    u.checked(found("0.3.0"), "t".into());
    assert_eq!(u.begin_download().err(), Some(UpdateError::Unsupported));
    assert_eq!(u.begin_install().err(), Some(UpdateError::Unsupported));
    assert_eq!(u.state(&prefs(true, None)).available, Some(info("0.3.0")));
}

#[test]
fn install_kind_follows_the_bundle() {
    use BundleType as B;
    for b in [B::Nsis, B::Msi, B::App, B::AppImage] {
        assert_eq!(install_kind(Some(b.clone()), false), InstallKind::InPlace);
        assert_eq!(install_kind(Some(b), true), InstallKind::DownloadOnly);
    }
    for b in [Some(B::Deb), Some(B::Rpm), Some(B::Dmg), None] {
        assert_eq!(install_kind(b, false), InstallKind::DownloadOnly);
    }
}

#[test]
fn release_notes_url_takes_plain_versions_only() {
    assert_eq!(
        release_notes_url("0.3.0").unwrap(),
        "https://github.com/tbounsiar/carapace/releases/tag/v0.3.0"
    );
    assert_eq!(
        release_notes_url("1.0.0-rc.1").unwrap(),
        "https://github.com/tbounsiar/carapace/releases/tag/v1.0.0-rc.1"
    );
    for bad in [
        "",
        "v0.3.0",
        "0.3",
        "0.3.0.1",
        "01.2.3",
        "0.3.0+build",
        "0.3.0-",
        "0.3.0-rc..1",
        "0.3.0-01",
        "0.3.0-rc/../x",
        "0.3.0?x=1",
        "0.3.0#a",
        " 0.3.0",
        "0.3.0\n",
        "1.2.x",
        "１.2.3",
        &format!("1.2.3-{}", "a".repeat(60)),
    ] {
        assert_eq!(
            release_notes_url(bad),
            Err(UpdateError::InvalidVersion),
            "{bad:?}"
        );
    }
    for good in [
        "0.0.0",
        "10.20.30",
        "1.0.0-alpha-1.0",
        "1.0.0-0.3.7",
        "1.0.0-x-y",
    ] {
        assert!(is_plain_version(good), "{good}");
    }
}

#[test]
fn the_meter_sends_the_first_chunk_every_step_and_the_end() {
    let mut m = Meter::default();
    let total = Some(600 * 1024);
    assert_eq!(
        m.add(1024, total),
        Some(Progress {
            downloaded: 1024,
            total
        })
    );
    assert_eq!(m.add(255 * 1024, total), None);
    assert_eq!(m.add(1024, total).map(|p| p.downloaded), Some(257 * 1024));
    assert_eq!(m.add(200 * 1024, total), None);
    assert_eq!(
        m.add(143 * 1024, total).map(|p| p.downloaded),
        Some(600 * 1024)
    );
    let mut m = Meter::default();
    assert!(m.add(1, None).is_some());
    assert!(m.add(1, None).is_none());
}

#[test]
fn error_codes_and_texts() {
    let cases = [
        (UpdateError::Network, "network", "errors.updates.network"),
        (
            UpdateError::Unavailable,
            "update_unavailable",
            "errors.updates.unavailable",
        ),
        (
            UpdateError::Signature,
            "signature_invalid",
            "errors.updates.signature",
        ),
        (
            UpdateError::InstallFailed,
            "install_failed",
            "errors.updates.installFailed",
        ),
        (
            UpdateError::NothingDownloaded,
            "nothing_downloaded",
            "errors.updates.nothingDownloaded",
        ),
        (
            UpdateError::NoUpdate,
            "not_found",
            "errors.updates.noUpdate",
        ),
        (UpdateError::Busy, "busy", "errors.updates.busy"),
        (
            UpdateError::Cancelled,
            "cancelled",
            "errors.updates.cancelled",
        ),
        (
            UpdateError::Unsupported,
            "unsupported",
            "errors.updates.unsupported",
        ),
        (
            UpdateError::NotUploaded,
            "not_uploaded",
            "errors.updates.notUploaded",
        ),
        (
            UpdateError::InvalidVersion,
            "invalid_input",
            "errors.updates.invalidVersion",
        ),
        (UpdateError::Browser, "io", "errors.updates.browserFailed"),
        (
            UpdateError::Unconfirmed,
            "busy",
            "errors.updates.unconfirmed",
        ),
        (
            UpdateError::RestartRequired,
            "restart_required",
            "errors.updates.restartRequired",
        ),
    ];
    for (e, code, key) in cases {
        assert_eq!(e.code(), code);
        let text = e.text();
        assert_eq!(text.key, Some(key));
        assert_eq!(text.message, e.to_string());
        assert!(text.params.is_empty());
    }
}

#[test]
fn plugin_errors_are_classified_without_their_text() {
    let mismatch = || PluginError::SignedVersionMismatch {
        signed: "0.1.0".into(),
        announced: "9.0.0".into(),
    };
    for stage in [Stage::Check, Stage::Download, Stage::Install] {
        assert_eq!(classify(&mismatch(), stage), UpdateError::Signature);
        assert_eq!(
            classify(&PluginError::MissingSignedVersion, stage),
            UpdateError::Signature
        );
        assert_eq!(
            classify(&PluginError::SignatureUtf8("x".into()), stage),
            UpdateError::Signature
        );
    }
    let io = || PluginError::Io(std::io::Error::other("/secret/path"));
    assert_eq!(classify(&io(), Stage::Check), UpdateError::Network);
    assert_eq!(classify(&io(), Stage::Download), UpdateError::Network);
    assert_eq!(classify(&io(), Stage::Install), UpdateError::InstallFailed);
    for e in [
        PluginError::ReleaseNotFound,
        PluginError::TargetsNotFound(vec!["windows-x86_64".into()]),
        PluginError::Network("Download request failed with status: 404".into()),
        PluginError::InsecureTransportProtocol,
    ] {
        assert_eq!(classify(&e, Stage::Check), UpdateError::Unavailable);
    }
    assert_eq!(
        classify(&PluginError::PackageInstallFailed, Stage::Install),
        UpdateError::InstallFailed
    );
}

#[test]
fn an_unconfirmed_install_refuses_open_work() {
    let open = |transfers, unsaved_editors, unsynced_edits| OpenWork {
        transfers,
        unsaved_editors,
        unsynced_edits,
    };
    assert_eq!(may_apply(false, open(false, false, false)), Ok(()));
    assert_eq!(
        may_apply(false, open(true, false, false)),
        Err(UpdateError::Unconfirmed)
    );
    assert_eq!(
        may_apply(false, open(false, true, false)),
        Err(UpdateError::Unconfirmed)
    );
    assert_eq!(may_apply(true, open(true, true, false)), Ok(()));
    for confirmed in [false, true] {
        assert_eq!(
            may_apply(confirmed, open(false, false, true)),
            Err(UpdateError::NotUploaded),
            "unsynced edits refuse even a confirmed install"
        );
    }
}

#[test]
fn a_failure_after_the_exit_work_asks_for_a_restart() {
    assert_eq!(
        install_error(UpdateError::InstallFailed, false),
        UpdateError::InstallFailed
    );
    assert_eq!(
        install_error(UpdateError::Signature, false),
        UpdateError::Signature
    );
    for e in [UpdateError::InstallFailed, UpdateError::Signature] {
        assert_eq!(install_error(e, true), UpdateError::RestartRequired);
    }
}
