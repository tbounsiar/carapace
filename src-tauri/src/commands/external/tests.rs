use super::*;
use crate::config::Host;
use crate::config::model::{AuthMethod, Collection};

#[test]
fn edit_errors_map_to_stable_codes_without_local_paths() {
    let cases = [
        (EditError::TooLarge { name: "a".into() }, "too_large"),
        (
            EditError::LargeFile {
                name: "a".into(),
                size: 30,
            },
            "large_file",
        ),
        (
            EditError::Sensitive {
                name: ".env".into(),
            },
            "sensitive",
        ),
        (
            EditError::BlockedType {
                name: "a.exe".into(),
                ext: "exe".into(),
            },
            "blocked_type",
        ),
        (
            EditError::AppNotFound {
                app: "code.exe".into(),
            },
            "app_not_found",
        ),
        (EditError::AppFailed, "app_failed"),
        (
            EditError::AppNotEditor {
                app: "pwsh.exe".into(),
            },
            "app_not_editor",
        ),
        (EditError::HostChanged("/a".into()), "host_changed"),
        (EditError::HostGone("/a".into()), "not_found"),
        (EditError::NoConflict("/a".into()), "invalid_input"),
        (EditError::NotRegular("/d".into()), "not_regular_file"),
        (EditError::NotUploaded("/a".into()), "not_uploaded"),
        (EditError::UnknownId, "not_found"),
        (EditError::Local, "io"),
        (EditError::Fs(FsError::NotConnected), "not_connected"),
        (EditError::Fs(FsError::Changed("/a".into())), "conflict"),
        (
            EditError::Fs(FsError::PermissionDenied("/a".into())),
            "permission_denied",
        ),
    ];
    for (err, code) in cases {
        let e = CommandError::from(err);
        assert_eq!(e.code, code);
        assert!(
            !e.message.contains(":\\") && !e.message.contains("/edit/"),
            "{}",
            e.message
        );
    }
}

use crate::files::FsError;

#[test]
fn the_opener_follows_the_setting() {
    assert_eq!(opener_of(None), Opener::System);
    let custom = |app: Option<&str>| ExternalEditor {
        mode: EditorMode::Custom,
        app_path: app.map(Into::into),
        notice_seen: false,
    };
    assert_eq!(opener_of(Some(&custom(None))), Opener::System);
    assert_eq!(
        opener_of(Some(&custom(Some("/usr/bin/vi")))),
        Opener::App("/usr/bin/vi".into())
    );
    let mut system = custom(Some("/usr/bin/vi"));
    system.mode = EditorMode::System;
    assert_eq!(opener_of(Some(&system)), Opener::System);
}

#[test]
fn the_app_path_is_a_plain_local_program() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("editor.exe");
    std::fs::write(&app, b"").unwrap();
    let ok = app.to_string_lossy().into_owned();
    assert_eq!(check_app_path(&format!(" {ok} ")).unwrap(), ok);
    let control = format!("{ok}\nx");
    for bad in ["", "relative.exe", "${EDITOR}", &control, "~/bin/vi"] {
        assert_eq!(
            check_app_path(bad).unwrap_err().code,
            "invalid_input",
            "{bad}"
        );
    }
    let shell = dir.path().join("powershell.exe");
    std::fs::write(&shell, b"").unwrap();
    assert_eq!(
        check_app_path(&shell.to_string_lossy()).unwrap_err().code,
        "app_not_editor"
    );
    let missing = dir.path().join("gone.exe");
    assert_eq!(
        check_app_path(&missing.to_string_lossy()).unwrap_err().code,
        "app_not_found"
    );
    assert_eq!(
        check_app_path(&dir.path().to_string_lossy())
            .unwrap_err()
            .code,
        "app_not_found"
    );
    #[cfg(windows)]
    assert_eq!(
        check_app_path(r"\\host\share\e.exe").unwrap_err().code,
        "invalid_input"
    );
}

#[test]
fn the_setting_is_saved_in_the_config_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(dir.path().to_owned());
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .external_editor
            .unwrap_or_default(),
        ExternalEditor::default()
    );
    let saved = set_editor_in(&store, EditorMode::Custom, None, true).unwrap();
    assert_eq!(store.snapshot().unwrap().external_editor, Some(saved));
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("config.json")).unwrap()).unwrap();
    assert_eq!(
        raw["externalEditor"],
        serde_json::json!({"mode": "custom", "appPath": null, "noticeSeen": true})
    );
    let err = set_editor_in(&store, EditorMode::Custom, Some("nope".into()), true).unwrap_err();
    assert_eq!(err.code, "invalid_input");
    assert_eq!(
        store.snapshot().unwrap().external_editor.unwrap().mode,
        EditorMode::Custom
    );
}

#[test]
fn a_malformed_setting_reads_as_the_default() {
    let cfg: ConfigFile =
        serde_json::from_str(r#"{"version":3,"externalEditor":{"mode":"shell"}}"#).unwrap();
    assert_eq!(cfg.external_editor, None);
    let cfg: ConfigFile =
        serde_json::from_str(r#"{"version":3,"externalEditor":{"mode":"custom","appPath":"/x"}}"#)
            .unwrap();
    assert!(!cfg.external_editor.unwrap().notice_seen);
}

fn host(id: &str, project: Option<&str>, parent: Option<&str>) -> Node {
    Node::Host(Host {
        id: id.into(),
        name: id.into(),
        project_id: project.map(Into::into),
        parent_id: parent.map(Into::into),
        hostname: "h".into(),
        port: "22".into(),
        username: "u".into(),
        auth: AuthMethod::Agent,
    })
}

fn collection(id: &str, project: Option<&str>, parent: Option<&str>) -> Node {
    Node::Collection(Collection {
        id: id.into(),
        name: id.into(),
        project_id: project.map(Into::into),
        parent_id: parent.map(Into::into),
    })
}

#[test]
fn delete_targets_list_the_hosts_they_remove() {
    let cfg = ConfigFile {
        nodes: vec![
            collection("c1", None, None),
            collection("c2", None, Some("c1")),
            host("h1", None, Some("c2")),
            host("h2", None, None),
            host("p1", Some("p"), None),
            collection("pc", Some("p"), None),
            host("p2", Some("p"), Some("pc")),
        ],
        ..ConfigFile::default()
    };
    let of = |json: &str| {
        let mut ids = hosts_of(&cfg, &serde_json::from_str(json).unwrap());
        ids.sort();
        ids
    };
    assert_eq!(of(r#"{"kind":"host","id":"h2"}"#), ["h2"]);
    assert_eq!(of(r#"{"kind":"collection","id":"c1"}"#), ["h1"]);
    assert_eq!(of(r#"{"kind":"project","id":"p"}"#), ["p1", "p2"]);
    assert!(of(r#"{"kind":"collection","id":"zz"}"#).is_empty());
    assert!(serde_json::from_str::<DeleteTarget>(r#"{"kind":"key","id":"k"}"#).is_err());
}

#[test]
fn ipc_shapes() {
    assert_eq!(
        serde_json::from_str::<Choice>(r#""overwrite""#).unwrap(),
        Choice::Overwrite
    );
    for raw in [r#""useServer""#, r#""use_server""#] {
        assert_eq!(
            serde_json::from_str::<Choice>(raw).unwrap(),
            Choice::UseServer
        );
    }
    assert!(serde_json::from_str::<Choice>(r#""merge""#).is_err());
    assert_eq!(
        serde_json::to_value(EditEvent::Removed { id: "x".into() }).unwrap(),
        serde_json::json!({"kind": "removed", "id": "x"})
    );
}

#[test]
fn blank_or_long_ids_are_invalid_input() {
    assert_eq!(required("id", " ").unwrap_err().code, "invalid_input");
    assert_eq!(
        required("id", &"x".repeat(65)).unwrap_err().code,
        "invalid_input"
    );
    assert!(required("id", "abc").is_ok());
    assert_eq!(check_path("").unwrap_err().code, "invalid_input");
    assert_eq!(
        check_path(&"/x".repeat(3000)).unwrap_err().code,
        "invalid_input"
    );
}
