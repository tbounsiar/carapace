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
fn project_and_environment_secrets_use_their_accounts() {
    let w = world();
    let p = w.store.create_project("p").unwrap();
    let e = w.store.create_environment(&p.id, "dev").unwrap();
    let ps = VariableScope::Project {
        project_id: p.id.clone(),
    };
    let es = VariableScope::Environment {
        project_id: p.id.clone(),
        environment_id: e.id.clone(),
    };
    save_variables(&w.store, &w.secrets, &ps, vec![secret("a", Some("1"))]).unwrap();
    save_variables(
        &w.store,
        &w.secrets,
        &es,
        vec![secret("b", Some("2")), secret("c", None)],
    )
    .unwrap();
    assert_eq!(
        w.mem.accounts(),
        vec![
            format!("var/env/{}/b", e.id),
            format!("var/project/{}/a", p.id)
        ]
    );
    let view = config_view(&w.store, &w.secrets).unwrap();
    let env = &view.projects[0].environments[0];
    assert!(env.variables[0].has_value);
    assert!(!env.variables[1].has_value);
    assert!(view.projects[0].variables[0].has_value);
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
    e1: String,
    e2: String,
    e3: String,
    h1: String,
    h2: String,
    h3: String,
}

fn tree(w: &World) -> Tree {
    let s = &w.store;
    let p1 = s.create_project("p1").unwrap().id;
    let p2 = s.create_project("p2").unwrap().id;
    let e1 = s.create_environment(&p1, "dev").unwrap().id;
    let e2 = s.create_environment(&p1, "prod").unwrap().id;
    let e3 = s.create_environment(&p2, "dev").unwrap().id;
    let h1 = s.create_host(&p1, &host_input("a")).unwrap().id;
    let h2 = s.create_host(&p1, &host_input("b")).unwrap().id;
    let h3 = s.create_host(&p2, &host_input("c")).unwrap().id;
    for (scope, name) in [
        (VariableScope::Global, "g"),
        (
            VariableScope::Project {
                project_id: p1.clone(),
            },
            "p",
        ),
        (
            VariableScope::Environment {
                project_id: p1.clone(),
                environment_id: e1.clone(),
            },
            "e",
        ),
        (
            VariableScope::Environment {
                project_id: p1.clone(),
                environment_id: e2.clone(),
            },
            "e",
        ),
        (
            VariableScope::Environment {
                project_id: p2.clone(),
                environment_id: e3.clone(),
            },
            "e",
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
    Tree {
        p1,
        p2,
        e1,
        e2,
        e3,
        h1,
        h2,
        h3,
    }
}

fn save_conn(w: &World, host: &str, env: Option<&str>) {
    let key = SavedKey::new(host, env).unwrap();
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
    for h in [&t.h1, &t.h2] {
        save_conn(w, h, None);
        save_conn(w, h, Some(&t.e1));
        save_conn(w, h, Some(&t.e2));
    }
    save_conn(w, &t.h3, None);
    save_conn(w, &t.h3, Some(&t.e3));
}

#[test]
fn delete_host_removes_its_saved_secrets_for_every_environment() {
    let w = world();
    let t = tree(&w);
    seed_conns(&w, &t);
    remove_host(&w.store, &w.secrets, &t.p1, &t.h1).unwrap();
    assert_eq!(conn_accounts(&w, &t.h1), 0);
    assert_eq!(conn_accounts(&w, &t.h2), 6);
    assert_eq!(conn_accounts(&w, &t.h3), 4);
}

#[test]
fn delete_environment_removes_its_variables_and_connection_secrets() {
    let w = world();
    let t = tree(&w);
    seed_conns(&w, &t);
    w.store.set_active_environment(&t.p1, Some(&t.e1)).unwrap();
    remove_environment(&w.store, &w.secrets, &t.p1, &t.e1).unwrap();
    let accounts = w.mem.accounts();
    assert!(!accounts.iter().any(|a| a.contains(&t.e1)));
    assert!(accounts.contains(&format!("var/env/{}/e", t.e2)));
    assert_eq!(conn_accounts(&w, &t.h1), 4);
    let view = config_view(&w.store, &w.secrets).unwrap();
    assert!(view.projects[0].active_environment_id.is_none());
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
        format!("conn/{}/{}/passphrase", t.h3, t.e3),
        format!("conn/{}/{}/password", t.h3, t.e3),
        format!("var/env/{}/e", t.e3),
        "var/global/g".to_string(),
    ];
    expected.sort();
    assert_eq!(w.mem.accounts(), expected);
    let _ = &t.p2;
}

#[test]
fn failed_deletes_keep_secrets() {
    let w = world();
    let t = tree(&w);
    seed_conns(&w, &t);
    let before = w.mem.accounts();
    assert!(remove_host(&w.store, &w.secrets, &t.p2, &t.h1).is_err());
    assert!(remove_environment(&w.store, &w.secrets, &t.p2, &t.e1).is_err());
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
    remove_host(&w.store, &w.secrets, &t.p1, &t.h1).unwrap();
    remove_environment(&w.store, &w.secrets, &t.p1, &t.e2).unwrap();
    remove_project(&w.store, &w.secrets, &t.p2).unwrap();
    assert_eq!(w.store.snapshot().unwrap().projects.len(), 1);
}

#[test]
fn resolve_view_per_environment() {
    let w = world();
    let p = w.store.create_project("p").unwrap();
    let dev = w.store.create_environment(&p.id, "dev").unwrap();
    let other = w.store.create_project("q").unwrap();
    let foreign = w.store.create_environment(&other.id, "x").unwrap();
    let h = w.store.create_host(&p.id, &host_input("web")).unwrap();
    save_variables(
        &w.store,
        &w.secrets,
        &VariableScope::Global,
        vec![plain("user", "carapace")],
    )
    .unwrap();
    save_variables(
        &w.store,
        &w.secrets,
        &VariableScope::Environment {
            project_id: p.id.clone(),
            environment_id: dev.id.clone(),
        },
        vec![
            plain("host", "127.0.0.1"),
            plain("port", "2223"),
            secret("pw", Some("hunter2")),
        ],
    )
    .unwrap();

    let r = resolve::view(&w.store, &p.id, &h.id, Some(&dev.id)).unwrap();
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

    let none = resolve::view(&w.store, &p.id, &h.id, None).unwrap();
    assert_eq!(none.missing, vec!["host", "port", "pw"]);
    assert_eq!(none.username.as_deref(), Some("carapace"));

    let code = |r: Res<ResolvedView>| r.unwrap_err().code;
    assert_eq!(
        code(resolve::view(&w.store, &p.id, &h.id, Some(&foreign.id))),
        "not_found"
    );
    assert_eq!(
        code(resolve::view(&w.store, &other.id, &h.id, None)),
        "not_found"
    );
    assert_eq!(
        code(resolve::view(&w.store, &p.id, " ", None)),
        "invalid_input"
    );
}

#[test]
fn views_serialize_as_contract() {
    let w = world();
    let p = w.store.create_project("p").unwrap();
    let json = serde_json::to_value(project_view(&w.secrets, &p)).unwrap();
    for field in ["id", "name", "variables", "environments", "hosts"] {
        assert!(json.get(field).is_some(), "{field}");
    }
    assert!(json["activeEnvironmentId"].is_null());
}

#[test]
fn keychain_cleanup_waits_for_a_running_lifecycle_step() {
    let w = world();
    let t = tree(&w);
    seed_conns(&w, &t);
    let guard = w.secrets.lifecycle();
    std::thread::scope(|s| {
        let deleting = s.spawn(|| remove_host(&w.store, &w.secrets, &t.p1, &t.h1));
        let saving = s.spawn(|| {
            save_variables(
                &w.store,
                &w.secrets,
                &VariableScope::Global,
                vec![secret("late", Some("x"))],
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert_eq!(conn_accounts(&w, &t.h1), 6);
        assert!(w.mem.raw("var/global/late").is_none());
        assert!(
            w.store.snapshot().unwrap().projects[0]
                .host(&t.h1)
                .is_some()
        );
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
