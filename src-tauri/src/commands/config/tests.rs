use std::sync::Arc;

use secrecy::ExposeSecret;

use super::*;
use crate::config::model::AuthMethod;
use crate::secrets::{MAX_SECRET_UTF16_UNITS, MemoryBackend, SavedKey, SecretKind};

struct World {
    dir: tempfile::TempDir,
    store: ConfigStore,
    secrets: SecretStore,
    mem: Arc<MemoryBackend>,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(dir.path().to_path_buf());
    let (secrets, mem) = MemoryBackend::store();
    World {
        dir,
        store,
        secrets,
        mem,
    }
}

fn input(
    name: &str,
    kind: VariableKind,
    value: Option<&str>,
    secret: Option<&str>,
) -> VariableInput {
    VariableInput {
        name: name.into(),
        kind,
        value: value.map(str::to_owned),
        secret_value: secret.map(SecretString::from),
    }
}

fn plain(name: &str, value: &str) -> VariableInput {
    input(name, VariableKind::Plain, Some(value), None)
}

fn secret(name: &str, value: Option<&str>) -> VariableInput {
    input(name, VariableKind::Secret, None, value)
}

fn host_input(name: &str) -> HostInput {
    HostInput {
        name: name.into(),
        hostname: "${host}".into(),
        port: "${port}".into(),
        username: "${user}".into(),
        auth: AuthMethod::Password {
            password: Some("${pw}".into()),
        },
    }
}

fn raw_config(w: &World) -> String {
    std::fs::read_to_string(w.dir.path().join("config.json")).unwrap()
}

fn value(w: &World, account: &str) -> Option<String> {
    w.mem.raw(account)
}

#[test]
fn store_errors_map_to_contract_codes() {
    let w = world();
    w.store.create_project("A").unwrap();
    let code =
        |r: Result<Project, crate::config::ConfigError>| CommandError::from(r.unwrap_err()).code;
    assert_eq!(code(w.store.create_project("a")), "conflict");
    assert_eq!(code(w.store.create_project(" ")), "invalid_input");
    assert_eq!(code(w.store.rename_project("nope", "x")), "not_found");
}

#[test]
fn corrupt_file_maps_to_corrupt_config() {
    let w = world();
    std::fs::write(w.dir.path().join("config.json"), "garbage").unwrap();
    let err = config_view(&w.store, &w.secrets).unwrap_err();
    assert_eq!(err.code, "corrupt_config");
    assert!(!err.message.contains("garbage"));
}

#[test]
fn global_secret_is_stored_in_the_keychain_only() {
    let w = world();
    let g = VariableScope::Global;
    let out = save_variables(
        &w.store,
        &w.secrets,
        &g,
        vec![plain("user", "carapace"), secret("pw", Some("hunter2"))],
    )
    .unwrap();
    assert_eq!(
        out,
        vec![
            VariableView {
                name: "user".into(),
                kind: VariableKind::Plain,
                value: Some("carapace".into()),
                has_value: true
            },
            VariableView {
                name: "pw".into(),
                kind: VariableKind::Secret,
                value: None,
                has_value: true
            },
        ]
    );
    assert_eq!(value(&w, "var/global/pw").as_deref(), Some("hunter2"));
    assert!(!raw_config(&w).contains("hunter2"));
    let view = config_view(&w.store, &w.secrets).unwrap();
    assert_eq!(view.variables, out);
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["variables"][1]["hasValue"], true);
    assert!(json["variables"][1]["value"].is_null());
    assert!(!json.to_string().contains("hunter2"));
}

#[test]
fn project_secrets_use_their_account() {
    let w = world();
    let p = w.store.create_project("p").unwrap();
    let ps = VariableScope::Project {
        project_id: p.id.clone(),
    };
    save_variables(
        &w.store,
        &w.secrets,
        &ps,
        vec![secret("a", Some("1")), secret("c", None)],
    )
    .unwrap();
    assert_eq!(w.mem.accounts(), vec![format!("var/project/{}/a", p.id)]);
    let view = config_view(&w.store, &w.secrets).unwrap();
    let vars = &view.projects[0].variables;
    assert!(vars[0].has_value);
    assert!(!vars[1].has_value);
}

#[test]
fn absent_secret_value_keeps_the_stored_one() {
    let w = world();
    let g = VariableScope::Global;
    save_variables(&w.store, &w.secrets, &g, vec![secret("pw", Some("one"))]).unwrap();
    let out = save_variables(&w.store, &w.secrets, &g, vec![secret("pw", None)]).unwrap();
    assert!(out[0].has_value);
    assert_eq!(value(&w, "var/global/pw").as_deref(), Some("one"));
    save_variables(&w.store, &w.secrets, &g, vec![secret("pw", Some("two"))]).unwrap();
    assert_eq!(value(&w, "var/global/pw").as_deref(), Some("two"));
}

#[test]
fn removed_plainified_and_renamed_secrets_lose_their_value() {
    let w = world();
    let g = VariableScope::Global;
    save_variables(
        &w.store,
        &w.secrets,
        &g,
        vec![
            secret("gone", Some("1")),
            secret("flip", Some("2")),
            secret("old", Some("3")),
            secret("Case", Some("4")),
        ],
    )
    .unwrap();
    let out = save_variables(
        &w.store,
        &w.secrets,
        &g,
        vec![
            plain("flip", "visible"),
            secret("new", None),
            secret("case", Some("5")),
        ],
    )
    .unwrap();
    assert_eq!(w.mem.accounts(), vec!["var/global/case".to_string()]);
    assert_eq!(out[0].value.as_deref(), Some("visible"));
    assert!(
        !out[1].has_value,
        "a renamed secret without a value starts empty"
    );
    assert!(out[2].has_value);
}

#[test]
fn new_secret_without_value_clears_a_leftover_entry() {
    let w = world();
    w.mem.put_raw("var/global/pw", "leftover");
    let out = save_variables(
        &w.store,
        &w.secrets,
        &VariableScope::Global,
        vec![secret("pw", None)],
    )
    .unwrap();
    assert!(!out[0].has_value);
    assert!(w.mem.accounts().is_empty());
}

#[test]
fn invalid_inputs_change_nothing() {
    let w = world();
    let g = VariableScope::Global;
    save_variables(&w.store, &w.secrets, &g, vec![secret("pw", Some("keep"))]).unwrap();
    let before = raw_config(&w);
    let cases = vec![
        vec![input("p", VariableKind::Plain, Some("v"), Some("hunter2"))],
        vec![input("s", VariableKind::Secret, Some("hunter2"), None)],
        vec![secret("s", Some(""))],
        vec![secret("s", Some(&"a".repeat(MAX_SECRET_UTF16_UNITS + 1)))],
        vec![secret("bad name", Some("x"))],
        vec![plain("dup", "1"), plain("DUP", "2")],
    ];
    for vars in cases {
        let err = save_variables(&w.store, &w.secrets, &g, vars).unwrap_err();
        assert_eq!(err.code, "invalid_input");
        assert!(!err.message.contains("hunter2"));
    }
    assert_eq!(raw_config(&w), before);
    assert_eq!(w.mem.accounts(), vec!["var/global/pw".to_string()]);
    assert_eq!(value(&w, "var/global/pw").as_deref(), Some("keep"));
}

#[test]
fn keychain_failure_is_reported_and_views_degrade() {
    let w = world();
    let g = VariableScope::Global;
    save_variables(&w.store, &w.secrets, &g, vec![secret("pw", None)]).unwrap();
    w.mem.set_failing(true);
    let err = save_variables(&w.store, &w.secrets, &g, vec![secret("pw", Some("x"))]).unwrap_err();
    assert_eq!(err.code, "keychain_unavailable");
    let view = config_view(&w.store, &w.secrets).unwrap();
    assert!(!view.variables[0].has_value);
}

#[test]
fn unknown_scope_is_not_found() {
    let w = world();
    let err = save_variables(
        &w.store,
        &w.secrets,
        &VariableScope::Project {
            project_id: "00000000-0000-4000-8000-000000000001".into(),
        },
        vec![],
    )
    .unwrap_err();
    assert_eq!(err.code, "not_found");
}

#[test]
fn variable_input_wire_format() {
    let v: VariableInput =
        serde_json::from_str(r#"{"name":"pw","kind":"secret","secretValue":"hunter2"}"#).unwrap();
    assert_eq!(v.secret_value.unwrap().expose_secret(), "hunter2");
    let v: VariableInput =
        serde_json::from_str(r#"{"name":"a","kind":"plain","value":"x"}"#).unwrap();
    assert!(v.secret_value.is_none());
    let v: VariableInput =
        serde_json::from_str(r#"{"name":"a","kind":"secret","value":null,"secretValue":null}"#)
            .unwrap();
    assert!(v.value.is_none() && v.secret_value.is_none());
    assert!(
        !format!(
            "{:?}",
            serde_json::from_str::<VariableInput>(
                r#"{"name":"pw","kind":"secret","secretValue":"hunter2"}"#
            )
            .unwrap()
        )
        .contains("hunter2")
    );
}

struct Tree {
    p1: String,
    p2: String,
    h1: String,
    h2: String,
    h3: String,
}

fn tree(w: &World) -> Tree {
    let s = &w.store;
    let p1 = s.create_project("p1").unwrap().id;
    let p2 = s.create_project("p2").unwrap().id;
    let h1 = s.create_host(Some(&p1), None, &host_input("a")).unwrap().id;
    let h2 = s.create_host(Some(&p1), None, &host_input("b")).unwrap().id;
    let h3 = s.create_host(Some(&p2), None, &host_input("c")).unwrap().id;
    for (scope, name) in [
        (VariableScope::Global, "g"),
        (
            VariableScope::Project {
                project_id: p1.clone(),
            },
            "p",
        ),
        (
            VariableScope::Project {
                project_id: p2.clone(),
            },
            "q",
        ),
    ] {
        save_variables(
            s,
            &w.secrets,
            &scope,
            vec![secret(name, Some("s")), plain("x", "1")],
        )
        .unwrap();
    }
    Tree { p1, p2, h1, h2, h3 }
}

fn save_conn(w: &World, host: &str) {
    let key = SavedKey::new(host).unwrap();
    for kind in SecretKind::ALL {
        w.secrets
            .set_saved(&key, kind, "t", &SecretString::from("s"))
            .unwrap();
    }
}

fn conn_accounts(w: &World, host: &str) -> usize {
    w.mem
        .accounts()
        .iter()
        .filter(|a| a.starts_with(&format!("conn/{host}/")))
        .count()
}

fn seed_conns(w: &World, t: &Tree) {
    for h in [&t.h1, &t.h2, &t.h3] {
        save_conn(w, h);
    }
}

#[test]
fn delete_host_removes_its_saved_secrets() {
    let w = world();
    let t = tree(&w);
    seed_conns(&w, &t);
    remove_host(&w.store, &w.secrets, &t.h1).unwrap();
    assert_eq!(conn_accounts(&w, &t.h1), 0);
    assert_eq!(conn_accounts(&w, &t.h2), 2);
    assert_eq!(conn_accounts(&w, &t.h3), 2);
}

#[test]
fn delete_project_removes_everything_it_owns() {
    let w = world();
    let t = tree(&w);
    seed_conns(&w, &t);
    remove_project(&w.store, &w.secrets, &t.p1).unwrap();
    let mut expected = vec![
        format!("conn/{}/none/passphrase", t.h3),
        format!("conn/{}/none/password", t.h3),
        format!("var/project/{}/q", t.p2),
        "var/global/g".to_string(),
    ];
    expected.sort();
    assert_eq!(w.mem.accounts(), expected);
}

#[test]
fn failed_deletes_keep_secrets() {
    let w = world();
    let t = tree(&w);
    seed_conns(&w, &t);
    let before = w.mem.accounts();
    assert!(remove_host(&w.store, &w.secrets, &t.p1).is_err());
    assert!(remove_host(&w.store, &w.secrets, "nope").is_err());
    assert!(remove_project(&w.store, &w.secrets, "nope").is_err());
    assert_eq!(
        remove_project(&w.store, &w.secrets, " ").unwrap_err().code,
        "invalid_input"
    );
    assert_eq!(w.mem.accounts(), before);
}

#[test]
fn keychain_failure_does_not_fail_a_delete() {
    let w = world();
    let t = tree(&w);
    w.mem.set_failing(true);
    remove_host(&w.store, &w.secrets, &t.h1).unwrap();
    remove_project(&w.store, &w.secrets, &t.p2).unwrap();
    assert_eq!(w.store.snapshot().unwrap().projects.len(), 1);
}

#[test]
fn resolve_view_uses_project_then_global_variables() {
    let w = world();
    let p = w.store.create_project("p").unwrap();
    let other = w.store.create_project("q").unwrap();
    let h = w
        .store
        .create_host(Some(&p.id), None, &host_input("web"))
        .unwrap();
    let home = w
        .store
        .create_host(None, None, &host_input("home"))
        .unwrap();
    save_variables(
        &w.store,
        &w.secrets,
        &VariableScope::Global,
        vec![plain("user", "carapace"), plain("port", "22")],
    )
    .unwrap();
    save_variables(
        &w.store,
        &w.secrets,
        &VariableScope::Project {
            project_id: p.id.clone(),
        },
        vec![
            plain("host", "127.0.0.1"),
            plain("port", "2223"),
            secret("pw", Some("hunter2")),
        ],
    )
    .unwrap();

    let r = resolve::view(&w.store, &h.id).unwrap();
    assert_eq!(
        r,
        ResolvedView {
            hostname: Some("127.0.0.1".into()),
            port: Some(2223),
            username: Some("carapace".into()),
            key_path: None,
            missing: vec![],
            errors: vec![],
        }
    );
    let json = serde_json::to_value(&r).unwrap();
    assert!(json["keyPath"].is_null());
    assert!(!json.to_string().contains("hunter2"));

    let global_only = resolve::view(&w.store, &home.id).unwrap();
    assert_eq!(global_only.missing, vec!["host", "pw"]);
    assert_eq!(global_only.port, Some(22));
    assert_eq!(global_only.username.as_deref(), Some("carapace"));

    let code = |r: Res<ResolvedView>| r.unwrap_err().code;
    assert_eq!(code(resolve::view(&w.store, &other.id)), "not_found");
    assert_eq!(code(resolve::view(&w.store, " ")), "invalid_input");
}

#[test]
fn views_serialize_as_contract() {
    let w = world();
    let p = w.store.create_project("p").unwrap();
    let json = serde_json::to_value(project_view(&w.secrets, &p)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"id": p.id, "name": "p", "variables": []})
    );
}

#[test]
fn keychain_cleanup_waits_for_a_running_lifecycle_step() {
    let w = world();
    let t = tree(&w);
    seed_conns(&w, &t);
    let guard = w.secrets.lifecycle();
    std::thread::scope(|s| {
        let deleting = s.spawn(|| remove_host(&w.store, &w.secrets, &t.h1));
        let saving = s.spawn(|| {
            save_variables(
                &w.store,
                &w.secrets,
                &VariableScope::Global,
                vec![secret("late", Some("x"))],
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert_eq!(conn_accounts(&w, &t.h1), 2);
        assert!(w.mem.raw("var/global/late").is_none());
        assert!(w.store.snapshot().unwrap().host(&t.h1).is_some());
        drop(guard);
        deleting.join().unwrap().unwrap();
        saving.join().unwrap().unwrap();
    });
    assert_eq!(conn_accounts(&w, &t.h1), 0);
    assert!(w.mem.raw("var/global/late").is_some());
}

#[test]
fn version_1_keychain_entries_are_cleaned_up_once() {
    let w = world();
    let (p, e, h) = (
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
        "00000000-0000-4000-8000-000000000013",
    );
    let v1 = format!(
        r#"{{"version":1,"projects":[{{"id":"{p}","name":"A","environments":[{{"id":"{e}","name":"d","hosts":[{{"id":"{h}"}},{{"id":"not-a-uuid"}}]}}]}}]}}"#
    );
    std::fs::write(w.dir.path().join("config.json"), v1).unwrap();
    for kind in ["password", "passphrase"] {
        w.mem.put_raw(&format!("{p}/{e}/{h}/{kind}"), "old");
    }
    w.mem.put_raw("var/global/keep", "x");
    let _ = w.store.snapshot();
    super::super::secrets::forget_legacy(&w.store, &w.secrets);
    assert_eq!(w.mem.accounts(), vec!["var/global/keep".to_string()]);
    super::super::secrets::forget_legacy(&w.store, &w.secrets);
    assert!(w.dir.path().join("config.json.v1.bak").exists());
}

#[test]
fn unvalidated_names_are_not_quoted() {
    let w = world();
    let err = save_variables(
        &w.store,
        &w.secrets,
        &VariableScope::Global,
        vec![input("<b>x</b>", VariableKind::Plain, None, Some("s"))],
    )
    .unwrap_err();
    assert_eq!(err.code, "invalid_input");
    assert!(!err.message.contains("<b>"));
}

/// p1 > Backend > [a, b], p1 root host c, Home > Tools > d.
struct Nodes {
    p1: String,
    backend: String,
    tools: String,
    a: String,
    b: String,
    c: String,
    d: String,
}

fn nodes(w: &World) -> Nodes {
    let s = &w.store;
    let p1 = s.create_project("Payments").unwrap().id;
    let backend = s.create_collection(Some(&p1), None, "Backend").unwrap().id;
    let tools = s.create_collection(None, None, "Tools").unwrap().id;
    let host = |p: Option<&str>, parent: Option<&str>, name: &str| {
        s.create_host(p, parent, &host_input(name)).unwrap().id
    };
    let a = host(Some(&p1), Some(&backend), "a");
    let b = host(Some(&p1), Some(&backend), "b");
    let c = host(Some(&p1), None, "c");
    let d = host(None, Some(&tools), "d");
    for h in [&a, &b, &c, &d] {
        save_conn(w, h);
    }
    Nodes {
        p1,
        backend,
        tools,
        a,
        b,
        c,
        d,
    }
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[test]
fn delete_collection_removes_the_saved_secrets_of_its_hosts() {
    let w = world();
    let n = nodes(&w);
    let deleted = remove_collection(&w.store, &w.secrets, &n.backend).unwrap();
    assert_eq!(deleted.collection_ids, vec![n.backend.clone()]);
    assert_eq!(
        sorted(deleted.host_ids.clone()),
        sorted(vec![n.a.clone(), n.b.clone()])
    );
    assert_eq!(conn_accounts(&w, &n.a), 0);
    assert_eq!(conn_accounts(&w, &n.b), 0);
    assert_eq!(conn_accounts(&w, &n.c), 2);
    assert_eq!(conn_accounts(&w, &n.d), 2);
    let json = serde_json::to_value(&deleted).unwrap();
    assert!(json["collectionIds"].is_array() && json["hostIds"].is_array());

    let home = remove_collection(&w.store, &w.secrets, &n.tools).unwrap();
    assert_eq!(home.host_ids, vec![n.d.clone()]);
    assert_eq!(conn_accounts(&w, &n.d), 0);

    let err = remove_collection(&w.store, &w.secrets, &n.tools).unwrap_err();
    assert_eq!(
        (err.code, err.message.as_str()),
        ("not_found", "collection not found")
    );
    assert_eq!(
        remove_collection(&w.store, &w.secrets, " ")
            .unwrap_err()
            .code,
        "invalid_input"
    );
    assert_eq!(conn_accounts(&w, &n.c), 2);
}

#[test]
fn delete_project_removes_its_nested_hosts_and_their_secrets() {
    let w = world();
    let n = nodes(&w);
    let removed = remove_project(&w.store, &w.secrets, &n.p1).unwrap();
    assert_eq!(
        sorted(removed),
        sorted(vec![n.a.clone(), n.b.clone(), n.c.clone()])
    );
    for h in [&n.a, &n.b, &n.c] {
        assert_eq!(conn_accounts(&w, h), 0);
    }
    assert_eq!(conn_accounts(&w, &n.d), 2);
    let cfg = w.store.snapshot().unwrap();
    let left: Vec<_> = cfg.nodes.iter().map(|n| n.id().to_string()).collect();
    assert_eq!(sorted(left), sorted(vec![n.tools.clone(), n.d.clone()]));
}

#[test]
fn delete_host_by_id_works_in_home_and_nested() {
    let w = world();
    let n = nodes(&w);
    assert_eq!(
        remove_host(&w.store, &w.secrets, &n.a).unwrap(),
        vec![n.a.clone()]
    );
    assert_eq!(conn_accounts(&w, &n.a), 0);
    remove_host(&w.store, &w.secrets, &n.d).unwrap();
    assert_eq!(conn_accounts(&w, &n.d), 0);
    assert_eq!(conn_accounts(&w, &n.b), 2);
    let err = remove_host(&w.store, &w.secrets, &n.backend).unwrap_err();
    assert_eq!(err.code, "not_found");
}

#[test]
fn cross_scope_move_forgets_saved_secrets_of_the_old_scope() {
    let w = world();
    let n = nodes(&w);
    let m = relocate(&w.store, &w.secrets, &n.backend, None, Some(&n.tools)).unwrap();
    assert!(m.scope_changed);
    assert_eq!(conn_accounts(&w, &n.a), 0);
    assert_eq!(conn_accounts(&w, &n.b), 0);
    assert_eq!(conn_accounts(&w, &n.c), 2);
    assert_eq!(conn_accounts(&w, &n.d), 2);

    let m = relocate(&w.store, &w.secrets, &n.d, Some(&n.p1), None).unwrap();
    assert!(m.scope_changed);
    assert_eq!(conn_accounts(&w, &n.d), 0);
}

#[test]
fn moves_within_a_scope_or_refused_keep_saved_secrets() {
    let w = world();
    let n = nodes(&w);
    let m = relocate(&w.store, &w.secrets, &n.c, Some(&n.p1), Some(&n.backend)).unwrap();
    assert!(!m.scope_changed);
    assert_eq!(conn_accounts(&w, &n.c), 2);

    w.store.create_host(None, None, &host_input("A")).unwrap();
    let err = relocate(&w.store, &w.secrets, &n.backend, None, None).unwrap_err();
    assert_eq!(err.code, "conflict");
    assert_eq!(err.message, "a host named \"a\" already exists in Home");
    let err = relocate(
        &w.store,
        &w.secrets,
        &n.backend,
        Some(&n.p1),
        Some(&n.backend),
    )
    .unwrap_err();
    assert_eq!(err.code, "invalid_input");
    for h in [&n.a, &n.b, &n.c] {
        assert_eq!(conn_accounts(&w, h), 2);
    }
}

#[test]
fn config_view_lists_nodes_by_kind_without_secret_values() {
    let w = world();
    let n = nodes(&w);
    save_variables(
        &w.store,
        &w.secrets,
        &VariableScope::Global,
        vec![secret("pw", Some("hunter2"))],
    )
    .unwrap();
    let json = serde_json::to_value(config_view(&w.store, &w.secrets).unwrap()).unwrap();
    assert!(json["projects"][0].get("hosts").is_none());
    let nodes = json["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 6);
    let find = |id: &str| nodes.iter().find(|v| v["id"] == id).unwrap().clone();
    assert_eq!(
        find(&n.backend),
        serde_json::json!({"kind":"collection","id":n.backend,"name":"Backend",
            "projectId":n.p1,"parentId":null})
    );
    let d = find(&n.d);
    assert_eq!(d["kind"], "host");
    assert!(d["projectId"].is_null());
    assert_eq!(d["parentId"], n.tools);
    assert_eq!(
        d["auth"],
        serde_json::json!({"kind":"password","password":"${pw}"})
    );
    assert!(!json.to_string().contains("hunter2"));
}

#[test]
fn move_result_and_nullable_ids_follow_the_contract() {
    let r = MoveResult {
        nodes: Vec::new(),
        scope_changed: true,
    };
    assert_eq!(
        serde_json::to_value(r).unwrap(),
        serde_json::json!({"nodes":[],"scopeChanged":true})
    );
    assert_eq!(optional("parentId", &None).unwrap(), None);
    assert_eq!(optional("parentId", &Some("x".into())).unwrap(), Some("x"));
    assert_eq!(
        optional("parentId", &Some(" ".into())).unwrap_err().code,
        "invalid_input"
    );
}

mod connections {
    use super::*;
    use crate::config::Node;
    use crate::ssh::test_server::{Connected, manager_for, start_server};

    async fn connect(c: &Connected, host_id: &str) -> String {
        let mut t = c.target.clone();
        t.host_id = host_id.into();
        t.connection_id = host_id.into();
        let emit: Arc<dyn Fn(crate::ssh::ConnectEvent) + Send + Sync> = Arc::new(|_| {});
        c.manager.connect(&t, None, &|| true, emit).await.unwrap();
        t.connection_id
    }

    async fn open(c: &Connected) -> Vec<String> {
        let mut ids: Vec<String> = c
            .manager
            .list()
            .await
            .into_iter()
            .map(|i| i.host_id)
            .collect();
        ids.sort();
        ids
    }

    #[tokio::test]
    async fn moves_close_connections_only_when_the_scope_changes() {
        let server = start_server(1).await;
        let c = manager_for(&server, "unused");
        let w = world();
        let n = nodes(&w);
        for h in [&n.a, &n.b, &n.c, &n.d] {
            connect(&c, h).await;
        }
        let r = move_node_in(
            &w.store,
            &w.secrets,
            &c.manager,
            &n.c,
            Some(&n.p1),
            Some(&n.backend),
        )
        .await
        .unwrap();
        assert!(!r.scope_changed);
        assert_eq!(open(&c).await.len(), 4);

        let r = move_node_in(
            &w.store,
            &w.secrets,
            &c.manager,
            &n.backend,
            None,
            Some(&n.tools),
        )
        .await
        .unwrap();
        assert!(r.scope_changed);
        let ids: Vec<&str> = r.nodes.iter().map(Node::id).collect();
        assert_eq!(ids[0], n.backend);
        assert_eq!(ids.len(), 4, "the collection, its two hosts and c");
        assert_eq!(open(&c).await, sorted(vec![n.d.clone()]));

        let home = move_node_in(&w.store, &w.secrets, &c.manager, &n.d, Some(&n.p1), None).await;
        assert!(home.unwrap().scope_changed);
        assert!(open(&c).await.is_empty());
    }

    #[tokio::test]
    async fn deletes_close_the_connections_of_removed_hosts() {
        let server = start_server(2).await;
        let c = manager_for(&server, "unused");
        let w = world();
        let n = nodes(&w);
        for h in [&n.a, &n.b, &n.c, &n.d] {
            connect(&c, h).await;
        }
        let deleted = remove_collection(&w.store, &w.secrets, &n.backend).unwrap();
        close_hosts(&c.manager, &deleted.host_ids).await;
        assert_eq!(open(&c).await, sorted(vec![n.c.clone(), n.d.clone()]));
        let gone = remove_host(&w.store, &w.secrets, &n.d).unwrap();
        close_hosts(&c.manager, &gone).await;
        assert_eq!(open(&c).await, vec![n.c.clone()]);
        let gone = remove_project(&w.store, &w.secrets, &n.p1).unwrap();
        close_hosts(&c.manager, &gone).await;
        assert!(open(&c).await.is_empty());
    }
}

/// A connect paused in the host-key prompt while the host is moved or deleted, then accepted.
mod races {
    use std::future::Future;

    use tokio::sync::mpsc;

    use super::*;
    use crate::ssh::test_server::{SERVER_PASSWORD, isolated_manager_with, start_server};
    use crate::ssh::{ConnectEvent, ConnectionInfo, Credential, SshError};

    fn literal(name: &str, port: u16) -> HostInput {
        HostInput {
            name: name.into(),
            hostname: "127.0.0.1".into(),
            port: port.to_string(),
            username: "me".into(),
            auth: AuthMethod::Password { password: None },
        }
    }

    /// Connects with a typed password to remember, runs `during` while the host-key prompt is
    /// open, then accepts the key.
    async fn connect_racing(
        w: &World,
        ssh: &SshManager,
        host: &str,
        during: impl Future<Output = ()>,
    ) -> Result<ConnectionInfo, SshError> {
        let target = resolve::target(&w.store, host).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let emit: Arc<dyn Fn(ConnectEvent) + Send + Sync> = Arc::new(move |e| {
            let _ = tx.send(e);
        });
        let current = || resolve::target(&w.store, host).is_ok_and(|now| now == target);
        let credential: Credential = serde_json::from_value(
            serde_json::json!({"secret": SERVER_PASSWORD, "remember": true}),
        )
        .unwrap();
        let connecting = ssh.connect(&target, Some(credential), &current, emit);
        let driving = async {
            loop {
                if let ConnectEvent::HostKeyPrompt { request_id, .. } =
                    rx.recv().await.expect("no host key prompt")
                {
                    during.await;
                    ssh.answer_host_key(&request_id, true).unwrap();
                    return;
                }
            }
        };
        let (result, ()) = tokio::join!(connecting, driving);
        result
    }

    struct Setup {
        _dir: tempfile::TempDir,
        w: World,
        ssh: SshManager,
        port: u16,
        _server: crate::ssh::test_server::TestServer,
    }

    async fn setup(seed: u8) -> Setup {
        let server = start_server(seed).await;
        let dir = tempfile::tempdir().unwrap();
        let w = world();
        let ssh = isolated_manager_with(dir.path(), w.secrets.clone());
        Setup {
            _dir: dir,
            w,
            ssh,
            port: server.port,
            _server: server,
        }
    }

    #[tokio::test]
    async fn control_an_unchanged_host_is_connected_and_remembered() {
        let s = setup(40).await;
        let h =
            s.w.store
                .create_host(None, None, &literal("h", s.port))
                .unwrap()
                .id;
        let info = connect_racing(&s.w, &s.ssh, &h, async {}).await.unwrap();
        assert_eq!(info.connection_id, h);
        assert_eq!(conn_accounts(&s.w, &h), 1);
        assert_eq!(s.ssh.list().await.len(), 1);
    }

    #[tokio::test]
    async fn home_host_moved_into_a_project_during_the_prompt() {
        let s = setup(41).await;
        let p = s.w.store.create_project("P").unwrap().id;
        let h =
            s.w.store
                .create_host(None, None, &literal("h", s.port))
                .unwrap()
                .id;
        let err = connect_racing(&s.w, &s.ssh, &h, async {
            let m = move_node_in(&s.w.store, &s.w.secrets, &s.ssh, &h, Some(&p), None)
                .await
                .unwrap();
            assert!(m.scope_changed);
        })
        .await
        .unwrap_err();
        assert_eq!(err, SshError::HostChanged);
        assert_eq!(conn_accounts(&s.w, &h), 0, "no conn/{h}/none entry");
        assert!(s.ssh.list().await.is_empty());
    }

    #[tokio::test]
    async fn project_host_moved_to_another_project_during_the_prompt() {
        let s = setup(42).await;
        let p = s.w.store.create_project("P").unwrap().id;
        let q = s.w.store.create_project("Q").unwrap().id;
        let h =
            s.w.store
                .create_host(Some(&p), None, &literal("h", s.port))
                .unwrap()
                .id;
        let err = connect_racing(&s.w, &s.ssh, &h, async {
            move_node_in(&s.w.store, &s.w.secrets, &s.ssh, &h, Some(&q), None)
                .await
                .unwrap();
        })
        .await
        .unwrap_err();
        assert_eq!(err, SshError::HostChanged);
        assert_eq!(conn_accounts(&s.w, &h), 0);
        assert!(s.ssh.list().await.is_empty());
    }

    /// Each case gets its own manager: an accepted prompt trusts the key, so a second connect
    /// on the same manager would not prompt again.
    async fn deleted_during_the_prompt(seed: u8, delete: fn(&World, &str, &str, &str)) {
        let s = setup(seed).await;
        let p = s.w.store.create_project("P").unwrap().id;
        let c = s.w.store.create_collection(Some(&p), None, "c").unwrap().id;
        let h =
            s.w.store
                .create_host(Some(&p), Some(&c), &literal("h", s.port))
                .unwrap()
                .id;
        let err = connect_racing(&s.w, &s.ssh, &h, async { delete(&s.w, &p, &c, &h) })
            .await
            .unwrap_err();
        assert_eq!(err, SshError::HostChanged);
        assert_eq!(conn_accounts(&s.w, &h), 0);
        assert!(s.ssh.list().await.is_empty());
    }

    #[tokio::test]
    async fn host_deleted_during_the_prompt_leaves_no_session() {
        deleted_during_the_prompt(44, |w, _, _, h| {
            remove_host(&w.store, &w.secrets, h).unwrap();
        })
        .await;
    }

    #[tokio::test]
    async fn collection_deleted_during_the_prompt_leaves_no_session() {
        deleted_during_the_prompt(45, |w, _, c, _| {
            remove_collection(&w.store, &w.secrets, c).unwrap();
        })
        .await;
    }

    #[tokio::test]
    async fn project_deleted_during_the_prompt_leaves_no_session() {
        deleted_during_the_prompt(46, |w, p, _, _| {
            remove_project(&w.store, &w.secrets, p).unwrap();
        })
        .await;
    }
}
