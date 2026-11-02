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
            &p,
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
    let t = resolve::target(&w.store, &w.project, &w.host, Some(&w.dev)).unwrap();
    assert_eq!(
        t,
        Target {
            connection_id: format!("{}@{}", w.host, w.dev),
            host_id: w.host.clone(),
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
    let none = resolve::target(&w.store, &w.project, &w.host, None).unwrap();
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
    let err = resolve::target(&w.store, &w.project, &w.host, None).unwrap_err();
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
    let err = resolve::target(&w.store, &w.project, &w.host, Some(&w.dev)).unwrap_err();
    assert_eq!(err.code, "invalid_input");
    assert_eq!(
        err.message,
        "secret variable host used in a non-secret field"
    );
    assert!(resolve::target(&w.store, &w.project, &w.host, None).is_ok());
}

#[test]
fn unknown_ids_are_not_found() {
    let w = world(AuthMethod::Agent);
    let code =
        |p: &str, h: &str, e: Option<&str>| resolve::target(&w.store, p, h, e).unwrap_err().code;
    assert_eq!(code(&w.project, "nope", None), "not_found");
    assert_eq!(code("nope", &w.host, None), "not_found");
    assert_eq!(code(&w.project, &w.host, Some("nope")), "not_found");
    assert_eq!(code(&w.project, "", None), "invalid_input");
}

#[test]
fn a_changed_variable_makes_the_target_stale() {
    let w = world(pw_ref());
    let t = resolve::target(&w.store, &w.project, &w.host, Some(&w.dev)).unwrap();
    let current =
        || resolve::target(&w.store, &w.project, &w.host, Some(&w.dev)).is_ok_and(|now| now == t);
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
    w.store.delete_host(&w.project, &w.host).unwrap();
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
