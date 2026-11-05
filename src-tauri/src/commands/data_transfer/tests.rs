use std::sync::Arc;

use secrecy::SecretString;

use super::*;
use crate::config::model::AuthMethod;
use crate::config::{HostInput, Variable, VariableKind, VariableScope};
use crate::secrets::{MemoryBackend, SavedKey, SecretKind};

struct World {
    dir: tempfile::TempDir,
    store: ConfigStore,
    secrets: SecretStore,
    mem: Arc<MemoryBackend>,
    pending: PendingImports,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(dir.path().join("home"));
    let (secrets, mem) = MemoryBackend::store();
    World {
        dir,
        store,
        secrets,
        mem,
        pending: PendingImports::default(),
    }
}

fn host(name: &str) -> HostInput {
    HostInput {
        name: name.into(),
        hostname: "127.0.0.1".into(),
        port: "22".into(),
        username: "u".into(),
        auth: AuthMethod::Password {
            password: Some("${pw}".into()),
        },
    }
}

fn var(name: &str, kind: VariableKind) -> Variable {
    Variable {
        name: name.into(),
        kind,
        value: (kind == VariableKind::Plain).then(|| "v".to_string()),
    }
}

/// Global secret `pw` (value "hunter2"), project `P` with secret `ppw` (value "s3cret"), hosts
/// `a` (Home) and `b` (in P), each with a saved password.
fn seed(w: &World) -> (String, String, String) {
    let p = w.store.create_project("P").unwrap();
    w.store
        .set_variables(&VariableScope::Global, &[var("pw", VariableKind::Secret)])
        .unwrap();
    w.store
        .set_variables(
            &VariableScope::Project {
                project_id: p.id.clone(),
            },
            &[
                var("ppw", VariableKind::Secret),
                var("x", VariableKind::Plain),
            ],
        )
        .unwrap();
    w.secrets
        .set_var(
            &VarKey::global("pw").unwrap(),
            &SecretString::from("hunter2"),
        )
        .unwrap();
    w.secrets
        .set_var(
            &VarKey::project(&p.id, "ppw").unwrap(),
            &SecretString::from("s3cret"),
        )
        .unwrap();
    let a = w.store.create_host(None, None, &host("a")).unwrap().id;
    let b = w
        .store
        .create_host(Some(&p.id), None, &host("b"))
        .unwrap()
        .id;
    for h in [&a, &b] {
        w.secrets
            .set_saved(
                &SavedKey::new(h).unwrap(),
                SecretKind::Password,
                "t",
                &SecretString::from("saved-pw"),
            )
            .unwrap();
    }
    (p.id, a, b)
}

fn exported(w: &World, scope: ExportScope) -> DataFile {
    let (bytes, _) = export_bytes(&w.store, &scope, true, "0.2.0", SystemTime::now()).unwrap();
    format::parse(&bytes).unwrap()
}

fn preview(w: &World, file: DataFile) -> ImportPreview {
    start_preview(
        &w.store,
        &w.secrets,
        &w.pending,
        "f.json".into(),
        file,
        &[],
        &HashSet::new(),
    )
    .unwrap()
}

fn apply(w: &World, id: &str, strategy: Strategy) -> Res<(ImportResult, ImportPlan)> {
    apply_pending(
        &w.store,
        &w.secrets,
        &w.pending,
        id,
        strategy,
        &[],
        &HashSet::new(),
    )
}

fn data_json(w: &World) -> Vec<u8> {
    std::fs::read(w.store.dir().join("data.json")).unwrap()
}

#[test]
fn an_export_holds_no_secret_value_from_the_keychain() {
    let w = world();
    seed(&w);
    for scope in [ExportScope::All, ExportScope::Home] {
        let (bytes, counts) =
            export_bytes(&w.store, &scope, true, "0.2.0", SystemTime::now()).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        for secret in ["hunter2", "s3cret", "saved-pw"] {
            assert!(!text.contains(secret));
        }
        assert!(text.contains("\"${pw}\""));
        assert!(counts.hosts >= 1);
    }
    let unknown = export_bytes(
        &w.store,
        &ExportScope::Project("nope".into()),
        true,
        "0",
        SystemTime::now(),
    );
    assert_eq!(unknown.unwrap_err().code, "invalid_input");
}

#[test]
fn preview_serializes_the_contract_shape() {
    let w = world();
    let (pid, _, _) = seed(&w);
    let file = exported(&w, ExportScope::Project(pid));
    let json = serde_json::to_value(preview(&w, file)).unwrap();
    assert!(json["importId"].is_string());
    assert_eq!(json["fileName"], "f.json");
    assert_eq!(
        json["file"]["scope"],
        serde_json::json!({"kind":"project","projectName":"P"})
    );
    assert_eq!(json["file"]["appVersion"], "0.2.0");
    assert_eq!(json["file"]["counts"]["secretVariables"], 2);
    for s in ["merge", "replace", "duplicate"] {
        assert!(json["plans"][s]["rows"].is_array(), "{s}");
    }
    let scope: DataScope = serde_json::from_str(r#"{"kind":"project","projectId":"p"}"#).unwrap();
    assert_eq!(
        scope,
        DataScope::Project {
            project_id: "p".into()
        }
    );
}

#[test]
fn replace_deletes_keychain_values_and_saved_secrets_then_undo_restores_the_data() {
    let w = world();
    let (pid, a, b) = seed(&w);
    let mut file = exported(&w, ExportScope::All);
    file.nodes.retain(|n| n.name() != "a");
    file.projects[0].variables.retain(|v| v.name != "ppw");
    let before = data_json(&w);
    let p = preview(&w, file);
    assert_eq!(p.plans.replace.secret_values_deleted, 1);
    assert_eq!(p.plans.replace.removed_host_ids, vec![a.clone()]);
    assert_eq!(p.plans.merge.secret_values_deleted, 0);

    let (result, plan) = apply(&w, &p.import_id, Strategy::Replace).unwrap();
    assert_eq!(result.secret_values_deleted, 1);
    assert!(result.backup_name.ends_with("-before-import.json"));
    assert_eq!(plan.removed_host_ids, vec![a.clone()]);
    assert!(w.mem.raw(&format!("var/project/{pid}/ppw")).is_none());
    assert!(w.mem.raw(&format!("conn/{a}/none/password")).is_none());
    assert!(
        w.mem.raw(&format!("conn/{b}/none/password")).is_some(),
        "other hosts keep theirs"
    );
    assert!(w.mem.raw("var/global/pw").is_some());
    assert_eq!(
        apply(&w, &p.import_id, Strategy::Merge).unwrap_err().code,
        "invalid_input"
    );

    let backup = backup_bytes(&w.pending, &p.import_id).unwrap();
    let bytes = backup::read(&backup).unwrap();
    let (removed, moved) =
        undo_pending(&w.store, &w.secrets, &w.pending, &p.import_id, &bytes).unwrap();
    assert!(removed.is_empty() && moved.is_empty());
    assert_eq!(data_json(&w), before);
    assert_eq!(
        undo_pending(&w.store, &w.secrets, &w.pending, &p.import_id, &bytes)
            .unwrap_err()
            .code,
        "not_found",
        "an undone import is gone"
    );
}

#[test]
fn a_keychain_failure_writes_nothing() {
    let w = world();
    let (_, a, _) = seed(&w);
    let mut file = exported(&w, ExportScope::All);
    file.nodes.retain(|n| n.name() != "a");
    let before = data_json(&w);
    let p = preview(&w, file);
    w.mem.fail_on(&[format!("delete conn/{a}/none/password")]);
    let err = apply(&w, &p.import_id, Strategy::Replace).unwrap_err();
    if err.code == "keychain_unavailable" {
        assert_eq!(
            err.message,
            "The system keychain is not available. Nothing was imported."
        );
        assert_eq!(data_json(&w), before);
    } else {
        panic!("unexpected {err:?}");
    }
}

#[test]
fn a_stale_preview_is_a_conflict_until_refreshed() {
    let w = world();
    seed(&w);
    let file = exported(&w, ExportScope::Home);
    let p = preview(&w, file);
    w.store.create_host(None, None, &host("late")).unwrap();
    let err = apply(&w, &p.import_id, Strategy::Merge).unwrap_err();
    assert_eq!(
        (err.code, err.message.as_str()),
        ("conflict", "Your data changed since this preview.")
    );
    let fresh = refresh_preview(
        &w.store,
        &w.secrets,
        &w.pending,
        &p.import_id,
        &[],
        &HashSet::new(),
    )
    .unwrap();
    assert_eq!(fresh.import_id, p.import_id);
    let (_, plan) = apply(&w, &p.import_id, Strategy::Replace).unwrap();
    assert_eq!(
        plan.removed_host_ids.len(),
        1,
        "the late host is not in the file"
    );
}

#[test]
fn undo_refuses_data_changed_since_the_import() {
    let w = world();
    seed(&w);
    let p = preview(&w, exported(&w, ExportScope::Home));
    apply(&w, &p.import_id, Strategy::Merge).unwrap();
    w.store.create_host(None, None, &host("after")).unwrap();
    let bytes = backup::read(&backup_bytes(&w.pending, &p.import_id).unwrap()).unwrap();
    let err = undo_pending(&w.store, &w.secrets, &w.pending, &p.import_id, &bytes).unwrap_err();
    assert_eq!(err.code, "conflict");
}

#[test]
fn unknown_or_cancelled_imports_are_not_found() {
    let w = world();
    seed(&w);
    let p = preview(&w, exported(&w, ExportScope::Home));
    w.pending.cancel(&p.import_id);
    assert_eq!(
        apply(&w, &p.import_id, Strategy::Merge).unwrap_err().code,
        "not_found"
    );
    assert_eq!(
        apply(&w, " ", Strategy::Merge).unwrap_err().code,
        "invalid_input"
    );
    assert_eq!(backup_bytes(&w.pending, "x").unwrap_err().code, "not_found");
}

#[test]
fn picked_files_are_read_capped_and_errors_name_the_file() {
    let w = world();
    let dir = w.dir.path();
    let big = dir.join("big.json");
    std::fs::write(&big, vec![b' '; (format::MAX_FILE_BYTES + 1) as usize]).unwrap();
    let e = read_import(big).unwrap_err();
    assert_eq!(e.code, "too_large");
    assert!(e.message.starts_with("file “big.json”: "));
    assert_eq!(
        read_import(dir.join("none.json")).unwrap_err().code,
        "not_found"
    );
    assert_eq!(
        read_import(dir.to_path_buf()).unwrap_err().code,
        "invalid_input"
    );
    let notes = dir.join("notes.json");
    std::fs::write(&notes, b"{\"a\":1}").unwrap();
    let e = read_import(notes).unwrap_err();
    assert_eq!(e.code, "import_format");
    assert_eq!(
        e.message,
        "file “notes.json”: This is not a Carapace data file."
    );
    let json = serde_json::to_value(&e).unwrap();
    assert_eq!(json["key"], "errors.dataTransfer.inFile");
    assert_eq!(json["params"]["file"], "notes.json");
    assert_eq!(
        json["params"]["error"]["key"],
        "errors.dataTransfer.notDataFile"
    );
    let broken = dir.join("broken.json");
    std::fs::write(&broken, b"{\n  oops\n}").unwrap();
    let json = serde_json::to_value(read_import(broken).unwrap_err()).unwrap();
    assert_eq!(
        json["params"]["error"],
        serde_json::json!({
            "key": "errors.dataTransfer.syntax",
            "params": { "line": 2, "column": 3 },
            "message": "The file is not valid JSON (line 2, column 3).",
        })
    );
    #[cfg(windows)]
    assert_eq!(
        read_import(PathBuf::from(r"\\host\share\f.json"))
            .unwrap_err()
            .code,
        "invalid_input"
    );
    let good = dir.join("good.json");
    let (bytes, _) =
        export_bytes(&w.store, &ExportScope::All, false, "0", SystemTime::now()).unwrap();
    std::fs::write(&good, bytes).unwrap();
    assert_eq!(read_import(good).unwrap().0, "good.json");
}

#[test]
fn export_targets_outside_the_app_home_only() {
    let w = world();
    seed(&w);
    let home = w.store.dir().to_path_buf();
    let out = tempfile::tempdir().unwrap();
    let (dir, name) = export_target(out.path().join("x.json"), &home).unwrap();
    assert_eq!(name, "x.json");
    fsutil::write_replace(&dir, &name, b"{}").unwrap();
    assert_eq!(
        export_target(home.join("data.json"), &home)
            .unwrap_err()
            .code,
        "invalid_input"
    );
    std::fs::create_dir_all(home.join("keys")).unwrap();
    assert_eq!(
        export_target(home.join("keys").join("k.json"), &home)
            .unwrap_err()
            .code,
        "invalid_input"
    );
    assert_eq!(
        export_target(out.path().join("no").join("x.json"), &home)
            .unwrap_err()
            .code,
        "not_found"
    );
    std::fs::create_dir(out.path().join("d.json")).unwrap();
    assert_eq!(
        export_target(out.path().join("d.json"), &home)
            .unwrap_err()
            .code,
        "invalid_input"
    );
    #[cfg(windows)]
    assert_eq!(
        export_target(PathBuf::from(r"\\host\share\x.json"), &home)
            .unwrap_err()
            .code,
        "invalid_input"
    );
}

#[test]
fn a_failure_after_some_deletes_says_how_many_values_are_gone() {
    let w = world();
    let (pid, a, _) = seed(&w);
    let mut file = exported(&w, ExportScope::All);
    file.nodes.retain(|n| n.name() != "a");
    file.projects[0].variables.retain(|v| v.name != "ppw");
    let before = data_json(&w);
    let p = preview(&w, file);
    w.mem.fail_on(&[format!("delete conn/{a}/none/password")]);
    let err = apply(&w, &p.import_id, Strategy::Replace).unwrap_err();
    assert_eq!(err.code, "keychain_unavailable");
    assert_eq!(
        err.message,
        "Nothing was imported, but 1 secret values were already removed from the keychain."
    );
    assert_eq!(data_json(&w), before);
    assert!(w.mem.raw(&format!("var/project/{pid}/ppw")).is_none());
}

#[test]
fn an_account_that_cannot_be_named_fails_the_import() {
    let (secrets, _) = MemoryBackend::store();
    let work = KeychainWork {
        variables: vec![VarAccount {
            project_id: Some("not-a-uuid".into()),
            name: "pw".into(),
        }],
        saved_hosts: Vec::new(),
    };
    let removed = std::cell::Cell::new(0);
    assert!(matches!(
        delete_keychain(&secrets, &work, &removed),
        Err(ConfigError::Keychain)
    ));
}

#[test]
fn a_picked_link_to_another_host_is_never_read() {
    let w = world();
    let link = w.dir.path().join("link.json");
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(r"\\host\share\x.json", &link).is_ok();
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&link, &link).is_ok();
    if made {
        let e = read_import(link).unwrap_err();
        assert_eq!(e.code, "invalid_input");
        assert!(e.message.starts_with("file “link.json”: "));
    }
}

mod connections {
    use super::*;
    use crate::ssh::test_server::{manager_for, start_server};

    #[tokio::test]
    async fn connected_hosts_removed_or_moved_are_listed_and_closed() {
        let server = start_server(7).await;
        let c = manager_for(&server, "unused");
        let w = world();
        let (pid, a, b) = seed(&w);
        for h in [&a, &b] {
            let mut t = c.target.clone();
            t.host_id = h.clone();
            t.connection_id = h.clone();
            let emit: crate::ssh::Emit = Arc::new(|_| {});
            c.manager.connect(&t, None, &|| true, emit).await.unwrap();
        }
        let mut file = exported(&w, ExportScope::All);
        file.nodes.retain(|n| n.name() != "a");
        for n in file.nodes.iter_mut() {
            if n.name() == "b" {
                n.set_location(None, None);
            }
        }
        let _ = pid;
        let connected = connected(&c.manager).await;
        let p = start_preview(
            &w.store,
            &w.secrets,
            &w.pending,
            "f".into(),
            file,
            &[],
            &connected,
        )
        .unwrap();
        let mut affected = p.plans.replace.affected_connected_hosts.clone();
        affected.sort();
        assert_eq!(affected, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(
            p.plans.merge.affected_connected_hosts,
            vec!["b".to_string()]
        );

        let (result, plan) = apply_pending(
            &w.store,
            &w.secrets,
            &w.pending,
            &p.import_id,
            Strategy::Replace,
            &[],
            &connected,
        )
        .unwrap();
        assert_eq!(result.disconnected.len(), 2);
        let closing: Vec<String> = plan
            .removed_host_ids
            .iter()
            .chain(&plan.moved_host_ids)
            .cloned()
            .collect();
        close_hosts(&c.manager, &closing).await;
        assert!(c.manager.list().await.is_empty());
        assert!(
            w.mem.raw(&format!("conn/{b}/none/password")).is_none(),
            "a cross-scope move forgets saved secrets"
        );
    }
}
