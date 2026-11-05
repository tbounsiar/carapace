use std::time::Duration;

use super::export::{
    ExportInput, ExportScope, build, counts, default_file_name, portable_path, slug,
};
use super::plan::Strategy;
use super::*;
use crate::config::model::AuthMethod;
use crate::config::{HostInput, Variable, VariableKind, VariableScope};

const NOV_5: u64 = 1_793_873_520;

fn at(secs: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
}

#[test]
fn stamps_are_utc_calendar_times() {
    let s = Stamp::of(at(NOV_5));
    assert_eq!(s.rfc3339(), "2026-11-05T10:12:00Z");
    assert_eq!(s.compact(), "20261105-101200");
    assert_eq!(Stamp::of(at(0)).date(), "1970-01-01");
    assert_eq!(Stamp::of(at(951_782_400)).date(), "2000-02-29");
}

#[test]
fn default_names_and_slugs() {
    assert_eq!(
        default_file_name(&ExportScope::All, None, "2026-11-05"),
        "carapace-all-2026-11-05.json"
    );
    assert_eq!(
        default_file_name(&ExportScope::Home, None, "d"),
        "carapace-home-d.json"
    );
    let p = ExportScope::Project("x".into());
    assert_eq!(
        default_file_name(&p, Some("Payments API (v2)!"), "d"),
        "carapace-payments-api-v2-d.json"
    );
    assert_eq!(slug("ÉÉÉ"), "project");
    assert_eq!(slug(&"a-".repeat(40)).len(), 39);
    assert!(slug(&"ab".repeat(40)).len() <= 40);
}

#[test]
fn key_paths_under_home_become_portable() {
    let home = if cfg!(windows) {
        r"C:\Users\me"
    } else {
        "/home/me"
    };
    let inside = if cfg!(windows) {
        r"C:\Users\ME\.ssh\id"
    } else {
        "/home/me/.ssh/id"
    };
    assert_eq!(portable_path(inside, Some(Path::new(home))), "~/.ssh/id");
    let sibling = if cfg!(windows) {
        r"C:\Users\meX\id"
    } else {
        "/home/meX/id"
    };
    assert_eq!(portable_path(sibling, Some(Path::new(home))), sibling);
    assert_eq!(portable_path("/opt/k", None), "/opt/k");
    assert_eq!(portable_path(home, Some(Path::new(home))), home);
}

#[test]
fn portable_paths_with_non_ascii_names_never_panic() {
    let (home, inside, other) = if cfg!(windows) {
        (
            r"C:\Users\İsmail",
            r"C:\Users\İsmail\.ssh\İd",
            r"C:\Users\İİİİİİ\x",
        )
    } else {
        ("/home/İsmail", "/home/İsmail/.ssh/İd", "/home/İİİİİİ/x")
    };
    assert_eq!(portable_path(inside, Some(Path::new(home))), "~/.ssh/İd");
    assert_eq!(portable_path(other, Some(Path::new(home))), other);
    assert_eq!(portable_path(home, Some(Path::new(other))), home);
}

fn file_key(path: &str) -> format::FileKey {
    format::FileKey {
        id: String::new(),
        name: "k".into(),
        path: path.into(),
        algorithm: crate::config::KeyAlgorithm::Ed25519,
        bits: None,
    }
}

#[test]
fn key_files_are_inspected_only_under_home_or_when_registered() {
    let home = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let inside = home.path().join("id_missing");
    let outside = elsewhere.path().join("id_other");
    let s = |p: &Path| p.to_str().unwrap().to_owned();
    let keys = [file_key(&s(&inside)), file_key(&s(&outside))];
    let probes = probe_keys(&keys, &[], Some(home.path()));
    assert_eq!(
        probes,
        vec![plan::KeyProbe::Missing, plan::KeyProbe::Refused]
    );
    let registered = probe_keys(&keys, &[s(&outside)], Some(home.path()));
    assert_eq!(
        registered[1],
        plan::KeyProbe::Missing,
        "a registered path is inspected"
    );
    assert_eq!(
        probe_keys(&[file_key("relative/k")], &[], Some(home.path())),
        vec![plan::KeyProbe::Refused]
    );
    #[cfg(windows)]
    assert_eq!(
        probe_keys(&[file_key(r"\\host\share\k")], &[], Some(home.path())),
        vec![plan::KeyProbe::Refused]
    );
    #[cfg(windows)]
    {
        let link = home.path().join("to-share");
        if std::os::windows::fs::symlink_dir(r"\\host\share", &link).is_ok() {
            let through = link.join("id");
            assert_eq!(
                probe_keys(&[file_key(&s(&through))], &[], Some(home.path())),
                vec![plan::KeyProbe::Refused],
                "a link under home to a share is never followed"
            );
        }
    }
}

#[test]
fn the_app_home_and_its_subfolders_are_refused() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("keys")).unwrap();
    assert!(inside_home(home.path(), home.path()));
    assert!(inside_home(&home.path().join("keys"), home.path()));
    let other = tempfile::tempdir().unwrap();
    assert!(!inside_home(other.path(), home.path()));
    let sibling = home.path().with_file_name(format!(
        "{}x",
        home.path().file_name().unwrap().to_str().unwrap()
    ));
    assert!(!inside_home(&sibling, home.path()));
}

#[test]
fn the_e2e_picker_hook_is_never_a_default_nor_in_release_builds() {
    const { assert!(!cfg!(feature = "e2e-pickers") || cfg!(debug_assertions)) };
    let manifest: toml::Table = toml::from_str(include_str!("../../Cargo.toml")).unwrap();
    let defaults = manifest
        .get("features")
        .and_then(|f| f.get("default"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(!defaults.iter().any(|f| f.as_str() == Some("e2e-pickers")));
    assert!(manifest["features"].get("e2e-pickers").is_some());
}

fn host(name: &str, password: Option<&str>) -> HostInput {
    HostInput {
        name: name.into(),
        hostname: "${addr}".into(),
        port: "22".into(),
        username: "u".into(),
        auth: AuthMethod::Password {
            password: password.map(str::to_owned),
        },
    }
}

fn seeded(dir: &Path) -> ConfigStore {
    let store = ConfigStore::new(dir.to_path_buf());
    let p = store.create_project("Payments").unwrap();
    store
        .set_variables(
            &VariableScope::Global,
            &[
                Variable {
                    name: "addr".into(),
                    kind: VariableKind::Plain,
                    value: Some("10.0.0.1".into()),
                },
                Variable {
                    name: "pw".into(),
                    kind: VariableKind::Secret,
                    value: None,
                },
            ],
        )
        .unwrap();
    let c = store
        .create_collection(Some(&p.id), None, "Backend")
        .unwrap();
    store
        .create_host(Some(&p.id), Some(&c.id), &host("api", Some("${pw}")))
        .unwrap();
    store.create_host(None, None, &host("home", None)).unwrap();
    store
}

fn export_all(store: &ConfigStore) -> DataFile {
    let cfg = store.snapshot().unwrap();
    let input = ExportInput {
        scope: &ExportScope::All,
        include_shared: false,
        home: None,
        exported_at: Stamp::of(at(NOV_5)).rfc3339(),
        app_version: "0.2.0",
    };
    let file = build(&cfg, &input).unwrap();
    format::parse(&format::to_bytes(&file)).unwrap()
}

fn none(_: &plan::VarAccount) -> bool {
    false
}

fn apply_all(
    store: &ConfigStore,
    file: &DataFile,
    strategy: Strategy,
) -> Result<Applied, ConfigError> {
    let (_, rev) = store.snapshot_revision().unwrap();
    let connected = HashSet::new();
    let inputs = Inputs {
        file,
        keys: &[],
        connected: &connected,
        has_value: &none,
    };
    apply(store, &inputs, &rev, strategy, at(NOV_5), |_| Ok(()))
}

#[test]
fn an_export_reimported_into_an_empty_home_is_the_same_data() {
    let a = tempfile::tempdir().unwrap();
    let source = seeded(a.path());
    let file = export_all(&source);
    assert_eq!(counts(&file).hosts, 2);
    assert_eq!(counts(&file).secret_variables, 1);

    let b = tempfile::tempdir().unwrap();
    let target = ConfigStore::new(b.path().to_path_buf());
    let done = apply_all(&target, &file, Strategy::Merge).unwrap();
    assert!(done.outcome.plan.blocking.is_empty());
    assert_eq!(target.snapshot().unwrap(), source.snapshot().unwrap());
    assert!(done.backup.path.starts_with(b.path().join(backup::DIR)));

    let again = apply_all(&target, &file, Strategy::Merge).unwrap();
    let rows = &again.outcome.plan.rows;
    assert!(
        rows.iter()
            .all(|r| r.added + r.updated + r.removed + r.copied == 0),
        "{rows:?}"
    );
}

#[test]
fn a_project_export_carries_the_globals_its_hosts_use() {
    let a = tempfile::tempdir().unwrap();
    let store = seeded(a.path());
    let cfg = store.snapshot().unwrap();
    let id = cfg.projects[0].id.clone();
    let scope = ExportScope::Project(id.clone());
    let mut input = ExportInput {
        scope: &scope,
        include_shared: true,
        home: None,
        exported_at: String::new(),
        app_version: "0",
    };
    let file = build(&cfg, &input).unwrap();
    let names: Vec<&str> = file.variables.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names, vec!["addr", "pw"]);
    assert_eq!(file.nodes.len(), 2);
    assert!(
        file.nodes
            .iter()
            .all(|n| n.project_id() == Some(id.as_str()))
    );
    assert!(format::parse(&format::to_bytes(&file)).is_ok());
    input.include_shared = false;
    assert!(build(&cfg, &input).unwrap().variables.is_empty());
    let unknown = ExportScope::Project("nope".into());
    input.scope = &unknown;
    assert!(build(&cfg, &input).is_none());
}

#[test]
fn apply_refuses_stale_and_blocked_imports_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded(dir.path());
    let file = export_all(&store);
    let before = std::fs::read(dir.path().join("data.json")).unwrap();
    let connected = HashSet::new();
    let inputs = Inputs {
        file: &file,
        keys: &[],
        connected: &connected,
        has_value: &none,
    };
    let stale = apply(
        &store,
        &inputs,
        &Revision::of(None),
        Strategy::Merge,
        at(NOV_5),
        |_| Ok(()),
    );
    assert!(matches!(stale, Err(ConfigError::Changed)));

    let (_, rev) = store.snapshot_revision().unwrap();
    let failed = apply(&store, &inputs, &rev, Strategy::Replace, at(NOV_5), |_| {
        Err(ConfigError::Keychain)
    });
    assert!(matches!(failed, Err(ConfigError::Keychain)));
    assert_eq!(std::fs::read(dir.path().join("data.json")).unwrap(), before);

    let mut big = file.clone();
    big.variables = (0..120)
        .map(|i| format::FileVariable {
            name: format!("v{i}"),
            kind: VariableKind::Plain,
            value: Some("x".into()),
        })
        .collect();
    let mut big2 = big.clone();
    big2.variables.iter_mut().for_each(|v| v.name.push('x'));
    let first = apply_all(&store, &big, Strategy::Merge).unwrap();
    assert!(first.outcome.plan.blocking.is_empty());
    let blocked = apply_all(&store, &big2, Strategy::Merge).unwrap_err();
    match blocked {
        ConfigError::InvalidInput(m) => {
            assert!(
                m.starts_with("This import cannot be done with Merge: there would be"),
                "{m}"
            )
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_backup_failure_aborts_the_import() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded(dir.path());
    let file = export_all(&store);
    std::fs::write(dir.path().join(backup::DIR), b"not a folder").unwrap();
    let before = std::fs::read(dir.path().join("data.json")).unwrap();
    let mut ran = false;
    let (_, rev) = store.snapshot_revision().unwrap();
    let connected = HashSet::new();
    let inputs = Inputs {
        file: &file,
        keys: &[],
        connected: &connected,
        has_value: &none,
    };
    let r = apply(&store, &inputs, &rev, Strategy::Replace, at(NOV_5), |_| {
        ran = true;
        Ok(())
    });
    assert!(matches!(r, Err(ConfigError::Io)));
    assert!(!ran, "no keychain delete before the backup exists");
    assert_eq!(std::fs::read(dir.path().join("data.json")).unwrap(), before);
}

#[test]
fn the_backup_holds_the_previous_bytes_and_restores_them() {
    let dir = tempfile::tempdir().unwrap();
    let store = seeded(dir.path());
    let before = std::fs::read(dir.path().join("data.json")).unwrap();
    let mut file = export_all(&store);
    file.nodes.retain(|n| n.name() != "home");
    let done = apply_all(&store, &file, Strategy::Replace).unwrap();
    assert_eq!(done.outcome.plan.removed_host_ids.len(), 1);
    assert_eq!(
        &*backup::read(&done.backup.path).unwrap(),
        before.as_slice()
    );
    assert_eq!(done.backup.name, "data-20261105-101200-before-import.json");

    let bytes = backup::read(&done.backup.path).unwrap();
    let (_, restored) = store
        .restore_data(&done.revision, &bytes, |_, _| {})
        .unwrap();
    assert_eq!(restored.nodes.len(), 3);
    assert_eq!(std::fs::read(dir.path().join("data.json")).unwrap(), before);
}
