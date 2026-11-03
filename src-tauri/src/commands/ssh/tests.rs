use super::*;
use crate::config::model::AuthMethod;
use crate::config::{HostInput, VariableScope};
use crate::secrets::{SavedKey, VarKey};
use crate::ssh::{Target, TargetAuth};

struct World {
    _dir: tempfile::TempDir,
    store: ConfigStore,
    project: String,
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
        &[("host", "127.0.0.1"), ("port", "2223"), ("pw", "")],
    );
    World {
        _dir: dir,
        store,
        project: p,
        host,
    }
}

fn pw_ref() -> AuthMethod {
    AuthMethod::Password {
        password: Some("${pw}".into()),
    }
}

#[test]
fn target_is_keyed_by_host() {
    let w = world(pw_ref());
    let t = resolve::target(&w.store, &w.host).unwrap();
    assert_eq!(
        t,
        Target {
            connection_id: w.host.clone(),
            host_id: w.host.clone(),
            project_id: Some(w.project.clone()),
            saved: Some(SavedKey::new(&w.host).unwrap()),
            hostname: "127.0.0.1".into(),
            port: 2223,
            username: "carapace".into(),
            auth: TargetAuth::Password {
                variable: Some(VarKey::project(&w.project, "pw").unwrap()),
            },
        }
    );
    assert_eq!(
        t.saved
            .as_ref()
            .unwrap()
            .account(crate::secrets::SecretKind::Password),
        format!("conn/{}/none/password", w.host)
    );
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
    let err = resolve::target(&w.store, &w.host).unwrap_err();
    assert_eq!(err.code, "missing_variables");
    assert_eq!(err.message, "missing variables: host, port, pw");
}

#[test]
fn secret_variable_in_a_plain_field_is_invalid_input() {
    let w = world(AuthMethod::Agent);
    set(
        &w.store,
        VariableScope::Project {
            project_id: w.project.clone(),
        },
        &[("host", ""), ("port", "2223")],
    );
    let err = resolve::target(&w.store, &w.host).unwrap_err();
    assert_eq!(err.code, "invalid_input");
    assert_eq!(
        err.message,
        "secret variable host used in a non-secret field"
    );
}

#[test]
fn unknown_ids_are_not_found() {
    let w = world(AuthMethod::Agent);
    let code = |h: &str| resolve::target(&w.store, h).unwrap_err().code;
    assert_eq!(code("nope"), "not_found");
    assert_eq!(code(""), "invalid_input");
    assert_eq!(code(" "), "invalid_input");
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
    let err = resolve::target(&w.store, &home).unwrap_err();
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
    let t = resolve::target(&w.store, &home).unwrap();
    assert_eq!(t.connection_id, home);
    assert_eq!((t.hostname.as_str(), t.port), ("10.0.0.1", 2200));
    assert_eq!(t.project_id, None);
    assert_eq!(t.saved, Some(SavedKey::new(&home).unwrap()));
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
    let t = resolve::target(&w.store, &w.host).unwrap();
    let current = || resolve::target(&w.store, &w.host).is_ok_and(|now| now == t);
    assert!(current());
    let project = || VariableScope::Project {
        project_id: w.project.clone(),
    };
    set(
        &w.store,
        project(),
        &[("host", "127.0.0.1"), ("port", "2224"), ("pw", "")],
    );
    assert!(!current());
    set(
        &w.store,
        project(),
        &[("host", "127.0.0.1"), ("port", "2223"), ("pw", "")],
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

fn draft(auth: AuthMethod) -> HostInput {
    HostInput {
        name: "draft".into(),
        hostname: "${host}".into(),
        port: "${port}".into(),
        username: "${user}".into(),
        auth,
    }
}

#[test]
fn draft_resolves_in_its_scope_and_saved_secrets_need_the_host() {
    let w = world(pw_ref());
    let t = resolve::draft_target(&w.store, &draft(pw_ref()), Some(&w.project), None).unwrap();
    assert_eq!(
        (t.hostname.as_str(), t.port, t.username.as_str()),
        ("127.0.0.1", 2223, "carapace")
    );
    assert_eq!(t.project_id.as_deref(), Some(w.project.as_str()));
    assert_eq!(t.saved, None);
    assert_eq!(
        t.auth,
        TargetAuth::Password {
            variable: Some(VarKey::project(&w.project, "pw").unwrap()),
        }
    );

    let edited =
        resolve::draft_target(&w.store, &draft(pw_ref()), Some(&w.project), Some(&w.host)).unwrap();
    assert_eq!(edited.saved, Some(SavedKey::new(&w.host).unwrap()));
    assert_eq!(edited.host_id, w.host);

    let mut changed = draft(AuthMethod::Agent);
    changed.port = "2200".into();
    let t = resolve::draft_target(&w.store, &changed, Some(&w.project), Some(&w.host)).unwrap();
    assert_eq!(
        (t.port, t.auth),
        (2200, TargetAuth::Agent),
        "the draft wins"
    );
}

#[test]
fn draft_errors_match_create_and_connect() {
    let w = world(pw_ref());
    let code = |d: &HostInput, p: Option<&str>, h: Option<&str>| {
        resolve::draft_target(&w.store, d, p, h).unwrap_err()
    };
    let home = code(&draft(pw_ref()), None, None);
    assert_eq!(
        (home.code, home.message.as_str()),
        ("missing_variables", "missing variables: host, port, pw")
    );
    let mut bad = draft(AuthMethod::Agent);
    bad.port = "${port".into();
    assert_eq!(code(&bad, Some(&w.project), None).code, "invalid_input");
    let mut unnamed = draft(AuthMethod::Agent);
    unnamed.name = " ".into();
    assert_eq!(code(&unnamed, Some(&w.project), None).code, "invalid_input");
    let mut secret_host = draft(AuthMethod::Agent);
    secret_host.hostname = "${pw}".into();
    let e = code(&secret_host, Some(&w.project), None);
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            "invalid_input",
            "secret variable pw used in a non-secret field"
        )
    );

    let unknown = "00000000-0000-4000-8000-0000000000ff";
    let a = draft(AuthMethod::Agent);
    assert_eq!(code(&a, Some(unknown), None).code, "not_found");
    assert_eq!(code(&a, Some(&w.project), Some(unknown)).code, "not_found");
    let foreign = code(&a, None, Some(&w.host));
    assert_eq!(
        (foreign.code, foreign.message.as_str()),
        ("invalid_input", "the host does not belong to Home")
    );
    let other = w.store.create_project("other").unwrap().id;
    let e = code(&a, Some(&other), Some(&w.host));
    assert_eq!(
        (e.code, e.message.as_str()),
        ("invalid_input", "the host does not belong to this project")
    );
}

mod test_command {
    use std::sync::Arc;

    use secrecy::SecretString;

    use super::*;
    use crate::ssh::test_server::isolated_manager;
    use crate::ssh::{Emit, SshManager};

    async fn run(
        w: &World,
        ssh: &SshManager,
        project: Option<&str>,
        host: Option<&str>,
        test_id: &str,
        credential: Option<Credential>,
    ) -> CommandError {
        let emit: Emit = Arc::new(|_| {});
        run_test(
            &w.store,
            ssh,
            &draft(AuthMethod::Agent),
            &project.map(str::to_owned),
            &host.map(str::to_owned),
            test_id,
            emit,
            credential,
        )
        .await
        .unwrap_err()
    }

    #[tokio::test]
    async fn validates_before_any_network() {
        let w = world(pw_ref());
        let dir = tempfile::tempdir().unwrap();
        let ssh = isolated_manager(dir.path());
        let p = Some(w.project.as_str());
        for id in ["", "  ", &"x".repeat(129)] {
            assert_eq!(run(&w, &ssh, p, None, id, None).await.code, "invalid_input");
        }
        assert_eq!(
            run(&w, &ssh, Some(""), None, "t", None).await.code,
            "invalid_input"
        );
        assert_eq!(
            run(&w, &ssh, p, Some(""), "t", None).await.code,
            "invalid_input"
        );
        let empty = Some(Credential {
            secret: SecretString::from(""),
            remember: true,
        });
        assert_eq!(
            run(&w, &ssh, p, None, "t", empty).await.code,
            "invalid_input"
        );
        assert_eq!(
            run(&w, &ssh, None, Some(&w.host), "t", None).await.code,
            "invalid_input"
        );
        assert_eq!(
            run(&w, &ssh, None, None, "t", None).await.code,
            "missing_variables"
        );
        assert!(ssh.list().await.is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_host_maps_like_connect() {
        let w = world(pw_ref());
        let dir = tempfile::tempdir().unwrap();
        let ssh = isolated_manager(dir.path());
        set(
            &w.store,
            VariableScope::Project {
                project_id: w.project.clone(),
            },
            &[("host", "127.0.0.1"), ("port", "1")],
        );
        let e = run(
            &w,
            &ssh,
            Some(&w.project),
            Some(&w.host),
            &"t".repeat(128),
            None,
        )
        .await;
        assert_eq!(e.code, "network");
    }

    #[test]
    fn cancel_validates_the_id() {
        assert_eq!(check_test_id("").unwrap_err().code, "invalid_input");
        assert_eq!(
            check_test_id(&"x".repeat(129)).unwrap_err().code,
            "invalid_input"
        );
        assert!(check_test_id(&"x".repeat(128)).is_ok());
    }
}

mod test_registration {
    use std::sync::Arc;

    use super::*;
    use crate::ssh::Emit;
    use crate::ssh::test_server::isolated_manager;

    fn quiet() -> Emit {
        Arc::new(|_| {})
    }

    #[tokio::test]
    async fn cancel_during_resolution_returns_cancelled() {
        let w = world(pw_ref());
        let dir = tempfile::tempdir().unwrap();
        let ssh = isolated_manager(dir.path());
        let ticket = ssh.start_test("t").unwrap();
        ssh.cancel_test("t").unwrap();
        let e = test_with(
            ticket,
            &w.store,
            &ssh,
            &draft(AuthMethod::Agent),
            &Some(w.project.clone()),
            &None,
            quiet(),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "cancelled");
        assert!(ssh.start_test("t").is_ok(), "the id is free again");
    }

    #[tokio::test]
    async fn duplicate_and_busy_map_to_their_codes() {
        let w = world(pw_ref());
        let dir = tempfile::tempdir().unwrap();
        let ssh = isolated_manager(dir.path());
        let held: Vec<_> = (0..4)
            .map(|i| ssh.start_test(&format!("t{i}")).unwrap())
            .collect();
        let agent = draft(AuthMethod::Agent);
        let (none, no_host) = (None, None);
        let dup = run_test(&w.store, &ssh, &agent, &none, &no_host, "t0", quiet(), None).await;
        assert_eq!(dup.unwrap_err().code, "invalid_input");
        let busy = run_test(&w.store, &ssh, &agent, &none, &no_host, "t9", quiet(), None)
            .await
            .unwrap_err();
        assert_eq!(
            (busy.code, busy.message.as_str()),
            ("busy", "too many connection tests are running")
        );
        drop(held);
        let after = run_test(&w.store, &ssh, &agent, &none, &no_host, "t9", quiet(), None).await;
        assert_eq!(after.unwrap_err().code, "missing_variables");
    }
}
