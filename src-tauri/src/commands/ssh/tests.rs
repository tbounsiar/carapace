use super::*;
use crate::config::model::AuthMethod;
use crate::config::{HostInput, VariableScope};
use crate::secrets::{SavedKey, VarKey};
use crate::ssh::{Target, TargetAuth};

struct World {
    _dir: tempfile::TempDir,
    store: ConfigStore,
    project: String,
    dev: String,
    host: String,
}

fn set(store: &ConfigStore, scope: VariableScope, vars: &[(&str, &str)]) {
    let list: Vec<_> = vars
        .iter()
        .map(|(n, v)| crate::config::Variable {
            name: (*n).into(),
            kind: if v.is_empty() {
                crate::config::VariableKind::Secret
            } else {
                crate::config::VariableKind::Plain
            },
            value: (!v.is_empty()).then(|| (*v).to_owned()),
        })
        .collect();
    store.set_variables(&scope, &list).unwrap();
}

fn world(auth: AuthMethod) -> World {
    let dir = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(dir.path().to_path_buf());
    let p = store.create_project("p").unwrap().id;
    let dev = store.create_environment(&p, "dev").unwrap().id;
    let host = store
        .create_host(
            Some(&p),
            None,
            &HostInput {
                name: "web".into(),
                hostname: "${host}".into(),
                port: "${port}".into(),
                username: "${user}".into(),
                auth,
            },
        )
        .unwrap()
        .id;
    set(&store, VariableScope::Global, &[("user", "carapace")]);
    set(
        &store,
        VariableScope::Project {
            project_id: p.clone(),
        },
        &[("host", "project.example"), ("port", "22"), ("pw", "")],
    );
    set(
        &store,
        VariableScope::Environment {
            project_id: p.clone(),
            environment_id: dev.clone(),
        },
        &[("host", "127.0.0.1"), ("port", "2223")],
    );
    World {
        _dir: dir,
        store,
        project: p,
        dev,
        host,
    }
}

fn pw_ref() -> AuthMethod {
    AuthMethod::Password {
        password: Some("${pw}".into()),
    }
}

#[test]
fn target_is_keyed_by_host_and_environment() {
    let w = world(pw_ref());
    let t = resolve::target(&w.store, &w.host, Some(&w.dev)).unwrap();
    assert_eq!(
        t,
        Target {
            connection_id: format!("{}@{}", w.host, w.dev),
            host_id: w.host.clone(),
            project_id: Some(w.project.clone()),
            environment_id: Some(w.dev.clone()),
            saved: SavedKey::new(&w.host, Some(&w.dev)).unwrap(),
            hostname: "127.0.0.1".into(),
            port: 2223,
            username: "carapace".into(),
            auth: TargetAuth::Password {
                variable: Some(VarKey::project(&w.project, "pw").unwrap()),
            },
        }
    );
    let none = resolve::target(&w.store, &w.host, None).unwrap();
    assert_eq!(none.connection_id, format!("{}@none", w.host));
    assert_eq!(none.hostname, "project.example");
    assert_eq!(none.port, 22);
    assert_ne!(none.saved, t.saved);
}

#[test]
fn missing_variables_fail_before_connecting() {
    let w = world(pw_ref());
    set(
        &w.store,
        VariableScope::Project {
            project_id: w.project.clone(),
        },
        &[],
    );
    let err = resolve::target(&w.store, &w.host, None).unwrap_err();
    assert_eq!(err.code, "missing_variables");
    assert_eq!(err.message, "missing variables: host, port, pw");
}

#[test]
fn secret_variable_in_a_plain_field_is_invalid_input() {
    let w = world(AuthMethod::Agent);
    set(
        &w.store,
        VariableScope::Environment {
            project_id: w.project.clone(),
            environment_id: w.dev.clone(),
        },
        &[("host", ""), ("port", "2223")],
    );
    let err = resolve::target(&w.store, &w.host, Some(&w.dev)).unwrap_err();
    assert_eq!(err.code, "invalid_input");
    assert_eq!(
        err.message,
        "secret variable host used in a non-secret field"
    );
    assert!(resolve::target(&w.store, &w.host, None).is_ok());
}

#[test]
fn unknown_ids_are_not_found() {
    let w = world(AuthMethod::Agent);
    let code = |h: &str, e: Option<&str>| resolve::target(&w.store, h, e).unwrap_err().code;
    assert_eq!(code("nope", None), "not_found");
    assert_eq!(code(&w.host, Some("nope")), "not_found");
    assert_eq!(code("", None), "invalid_input");
    assert_eq!(code(&w.host, Some("")), "invalid_input");
}

#[test]
fn environment_must_belong_to_the_host_scope() {
    let w = world(AuthMethod::Agent);
    let other = w.store.create_project("q").unwrap().id;
    let foreign = w.store.create_environment(&other, "dev").unwrap().id;
    let err = resolve::target(&w.store, &w.host, Some(&foreign)).unwrap_err();
    assert_eq!(err.code, "invalid_input");
    let home = w
        .store
        .create_host(
            None,
            None,
            &HostInput {
                name: "home".into(),
                hostname: "${host}".into(),
                port: "22".into(),
                username: "${user}".into(),
                auth: AuthMethod::Agent,
            },
        )
        .unwrap()
        .id;
    let err = resolve::target(&w.store, &home, Some(&w.dev)).unwrap_err();
    assert_eq!(err.code, "invalid_input");
    assert_eq!(err.message, "a host outside a project has no environment");
    assert_eq!(
        resolve::target(&w.store, &home, Some("nope"))
            .unwrap_err()
            .code,
        "invalid_input"
    );
}

#[test]
fn home_host_resolves_with_global_variables_only() {
    let w = world(AuthMethod::Agent);
    let home = w
        .store
        .create_host(
            None,
            None,
            &HostInput {
                name: "home".into(),
                hostname: "${host}".into(),
                port: "${port}".into(),
                username: "${user}".into(),
                auth: pw_ref(),
            },
        )
        .unwrap()
        .id;
    let err = resolve::target(&w.store, &home, None).unwrap_err();
    assert_eq!(err.message, "missing variables: host, port, pw");
    set(
        &w.store,
        VariableScope::Global,
        &[
            ("user", "carapace"),
            ("host", "10.0.0.1"),
            ("port", "2200"),
            ("pw", ""),
        ],
    );
    let t = resolve::target(&w.store, &home, None).unwrap();
    assert_eq!(t.connection_id, format!("{home}@none"));
    assert_eq!((t.hostname.as_str(), t.port), ("10.0.0.1", 2200));
    assert_eq!(t.environment_id, None);
    assert_eq!(t.saved, SavedKey::new(&home, None).unwrap());
    assert_eq!(
        t.auth,
        TargetAuth::Password {
            variable: Some(VarKey::global("pw").unwrap()),
        }
    );
}

#[test]
fn a_changed_variable_makes_the_target_stale() {
    let w = world(pw_ref());
    let t = resolve::target(&w.store, &w.host, Some(&w.dev)).unwrap();
    let current = || resolve::target(&w.store, &w.host, Some(&w.dev)).is_ok_and(|now| now == t);
    assert!(current());
    set(
        &w.store,
        VariableScope::Environment {
            project_id: w.project.clone(),
            environment_id: w.dev.clone(),
        },
        &[("host", "127.0.0.1"), ("port", "2224")],
    );
    assert!(!current());
    set(
        &w.store,
        VariableScope::Environment {
            project_id: w.project.clone(),
            environment_id: w.dev.clone(),
        },
        &[("host", "127.0.0.1"), ("port", "2223")],
    );
    assert!(current());
    w.store.delete_host(&w.host).unwrap();
    assert!(!current());
}

#[test]
fn credential_deserializes_with_optional_remember_and_redacted_debug() {
    let c: Credential = serde_json::from_str(r#"{"secret":"hunter2"}"#).unwrap();
    assert!(!c.remember);
    assert!(!format!("{c:?}").contains("hunter2"));
    let c: Credential = serde_json::from_str(r#"{"secret":"hunter2","remember":true}"#).unwrap();
    assert!(c.remember);
    let none: Option<Credential> = serde_json::from_str("null").unwrap();
    assert!(none.is_none());
}
