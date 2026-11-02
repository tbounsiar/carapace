use super::*;
use crate::config::model::{AuthMethod, VariableKind};

fn store() -> (tempfile::TempDir, ConfigStore) {
    let dir = tempfile::tempdir().unwrap();
    let s = ConfigStore::new(dir.path().to_path_buf());
    (dir, s)
}

fn abs_key() -> String {
    if cfg!(windows) {
        "C:\\keys\\id_ed25519".into()
    } else {
        "/home/u/.ssh/id_ed25519".into()
    }
}

fn input(name: &str) -> HostInput {
    HostInput {
        name: name.into(),
        hostname: "example.com".into(),
        port: "22".into(),
        username: "deploy".into(),
        auth: AuthMethod::Agent,
    }
}

fn setup() -> (tempfile::TempDir, ConfigStore, Project, Environment) {
    let (d, s) = store();
    let p = s.create_project("Alpha").unwrap();
    let e = s.create_environment(&p.id, "dev").unwrap();
    (d, s, p, e)
}

fn invalid<T: std::fmt::Debug>(r: Result<T, ConfigError>) {
    assert!(matches!(r, Err(ConfigError::InvalidInput(_))), "{r:?}");
}

fn plain(name: &str, value: &str) -> Variable {
    Variable {
        name: name.into(),
        kind: VariableKind::Plain,
        value: Some(value.into()),
    }
}

fn secret(name: &str) -> Variable {
    Variable {
        name: name.into(),
        kind: VariableKind::Secret,
        value: None,
    }
}

#[test]
fn missing_file_is_empty_v2() {
    let (_d, s) = store();
    let cfg = s.snapshot().unwrap();
    assert_eq!(cfg.version, 2);
    assert!(cfg.projects.is_empty() && cfg.variables.is_empty());
}

#[test]
fn corrupt_file_is_reported_and_preserved() {
    let (d, s) = store();
    let path = d.path().join(FILE_NAME);
    fs::write(&path, "{ not json").unwrap();
    assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)));
    assert!(matches!(s.create_project("x"), Err(ConfigError::Corrupt)));
    assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
}

#[test]
fn unsupported_version_is_corrupt() {
    let (d, s) = store();
    for raw in [r#"{"version":3,"projects":[]}"#, r#"{"projects":[]}"#] {
        fs::write(d.path().join(FILE_NAME), raw).unwrap();
        assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)));
        assert_eq!(fs::read_to_string(d.path().join(FILE_NAME)).unwrap(), raw);
    }
}

#[test]
fn version_2_with_bad_shape_is_corrupt() {
    let (d, s) = store();
    fs::write(d.path().join(FILE_NAME), r#"{"version":2,"projects":7}"#).unwrap();
    assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)));
}

#[test]
fn version_1_is_backed_up_and_the_app_starts_empty() {
    let (d, s) = store();
    let v1 = r#"{"version":1,"projects":[{"id":"p","name":"Old","environments":[]}]}"#;
    fs::write(d.path().join(FILE_NAME), v1).unwrap();
    assert!(s.snapshot().unwrap().projects.is_empty());
    assert_eq!(fs::read_to_string(d.path().join(V1_BACKUP)).unwrap(), v1);
    assert!(!d.path().join(FILE_NAME).exists());

    s.create_project("New").unwrap();
    assert_eq!(s.snapshot().unwrap().projects[0].name, "New");

    fs::write(d.path().join(FILE_NAME), v1).unwrap();
    assert!(s.create_project("Again").is_ok());
    assert_eq!(
        fs::read_to_string(d.path().join("config.json.v1.2.bak")).unwrap(),
        v1
    );
    assert_eq!(fs::read_to_string(d.path().join(V1_BACKUP)).unwrap(), v1);
    let names: Vec<_> = s
        .snapshot()
        .unwrap()
        .projects
        .into_iter()
        .map(|p| p.name)
        .collect();
    assert_eq!(names, vec!["Again"]);
}

#[test]
fn version_1_hosts_are_reported_once_for_keychain_cleanup() {
    let (d, s) = store();
    let v1 = r#"{"version":1,"projects":[
        {"id":"p1","name":"A","environments":[
            {"id":"e1","name":"dev","hosts":[{"id":"h1"},{"id":"h2"},{"name":"no id"}]},
            {"id":"e2","name":"prod","hosts":"garbage"}]},
        {"name":"no id","environments":[{"id":"e3","hosts":[{"id":"h3"}]}]}]}"#;
    fs::write(d.path().join(FILE_NAME), v1).unwrap();
    assert!(s.take_legacy_hosts().is_empty());
    s.snapshot().unwrap();
    let host = |h: &str| LegacyHost {
        project_id: "p1".into(),
        environment_id: "e1".into(),
        host_id: h.into(),
    };
    assert_eq!(s.take_legacy_hosts(), vec![host("h1"), host("h2")]);
    assert!(s.take_legacy_hosts().is_empty());
    s.snapshot().unwrap();
    assert!(s.take_legacy_hosts().is_empty());
}

#[test]
fn round_trip_and_disk_format() {
    let (d, s, p, e) = setup();
    let mut i = input("web");
    i.hostname = "${host}".into();
    i.port = "${port}".into();
    i.auth = AuthMethod::Key {
        key_path: abs_key(),
        passphrase: Some("${pp}".into()),
    };
    let h = s.create_host(&p.id, &i).unwrap();
    s.set_variables(&VariableScope::Global, &[plain("user", "me"), secret("pp")])
        .unwrap();
    s.set_active_environment(&p.id, Some(&e.id)).unwrap();
    let fresh = ConfigStore::new(d.path().to_path_buf());
    let cfg = fresh.snapshot().unwrap();
    assert_eq!(cfg.projects[0].hosts[0], h);
    assert_eq!(
        cfg.projects[0].active_environment_id.as_deref(),
        Some(e.id.as_str())
    );
    let raw: serde_json::Value =
        serde_json::from_slice(&fs::read(d.path().join(FILE_NAME)).unwrap()).unwrap();
    assert_eq!(raw["version"], 2);
    assert_eq!(
        raw["variables"][0],
        serde_json::json!({"name":"user","kind":"plain","value":"me"})
    );
    assert_eq!(
        raw["variables"][1],
        serde_json::json!({"name":"pp","kind":"secret","value":null})
    );
    let host = &raw["projects"][0]["hosts"][0];
    assert_eq!(host["port"], "${port}");
    assert_eq!(host["auth"]["kind"], "key");
    assert_eq!(host["auth"]["keyPath"], abs_key());
    assert_eq!(host["auth"]["passphrase"], "${pp}");
    assert_eq!(raw["projects"][0]["activeEnvironmentId"], e.id);
    assert!(!d.path().join(TMP_NAME).exists());
}

#[test]
fn project_crud_and_conflicts() {
    let (_d, s) = store();
    let p = s.create_project("  Alpha  ").unwrap();
    assert_eq!(p.name, "Alpha");
    assert!(p.active_environment_id.is_none());
    assert!(matches!(
        s.create_project("alpha"),
        Err(ConfigError::Conflict(_))
    ));
    let q = s.create_project("Beta").unwrap();
    assert!(matches!(
        s.rename_project(&q.id, "ALPHA"),
        Err(ConfigError::Conflict(_))
    ));
    assert_eq!(s.rename_project(&p.id, "ALPHA").unwrap().name, "ALPHA");
    assert_eq!(s.delete_project(&p.id).unwrap().id, p.id);
    assert_eq!(s.snapshot().unwrap().projects.len(), 1);
    assert!(matches!(
        s.delete_project(&p.id),
        Err(ConfigError::NotFound(_))
    ));
    assert!(matches!(
        s.rename_project("nope", "x"),
        Err(ConfigError::NotFound(_))
    ));
}

#[test]
fn name_rules() {
    let (_d, s) = store();
    invalid(s.create_project("   "));
    invalid(s.create_project(&"a".repeat(101)));
    assert!(s.create_project(&"a".repeat(100)).is_ok());
}

#[test]
fn environment_crud_conflicts_and_active() {
    let (_d, s, p, e) = setup();
    assert!(matches!(
        s.create_environment(&p.id, "DEV"),
        Err(ConfigError::Conflict(_))
    ));
    let other = s.create_project("Beta").unwrap();
    assert!(s.create_environment(&other.id, "dev").is_ok());
    let prod = s.create_environment(&p.id, "prod").unwrap();
    assert!(matches!(
        s.rename_environment(&p.id, &prod.id, "dev"),
        Err(ConfigError::Conflict(_))
    ));
    assert_eq!(
        s.rename_environment(&p.id, &e.id, "Dev").unwrap().name,
        "Dev"
    );
    assert!(matches!(
        s.create_environment("nope", "x"),
        Err(ConfigError::NotFound(_))
    ));

    assert!(matches!(
        s.set_active_environment(&p.id, Some("nope")),
        Err(ConfigError::NotFound(_))
    ));
    assert!(matches!(
        s.set_active_environment(&other.id, Some(&e.id)),
        Err(ConfigError::NotFound(_))
    ));
    s.set_active_environment(&p.id, Some(&prod.id)).unwrap();
    s.delete_environment(&p.id, &e.id).unwrap();
    let project = s.snapshot().unwrap().projects.remove(0);
    assert_eq!(
        project.active_environment_id.as_deref(),
        Some(prod.id.as_str())
    );
    let h = s.create_host(&p.id, &input("web")).unwrap();
    let (removed, hosts) = s.delete_environment(&p.id, &prod.id).unwrap();
    assert_eq!(removed.id, prod.id);
    assert_eq!(hosts, vec![h.id]);
    assert!(
        s.snapshot().unwrap().projects[0]
            .active_environment_id
            .is_none()
    );
    assert!(matches!(
        s.delete_environment(&p.id, &e.id),
        Err(ConfigError::NotFound(_))
    ));
    s.create_environment(&p.id, "x").unwrap();
    assert!(
        s.set_active_environment(&p.id, None)
            .unwrap()
            .active_environment_id
            .is_none()
    );
}

#[test]
fn hosts_belong_to_the_project() {
    let (_d, s, p, e) = setup();
    let h = s.create_host(&p.id, &input("web")).unwrap();
    assert!(matches!(
        s.create_host(&p.id, &input("WEB")),
        Err(ConfigError::Conflict(_))
    ));
    let other = s.create_project("Beta").unwrap();
    assert!(s.create_host(&other.id, &input("web")).is_ok());
    let db = s.create_host(&p.id, &input("db")).unwrap();
    assert!(matches!(
        s.update_host(&p.id, &db.id, &input("web")),
        Err(ConfigError::Conflict(_))
    ));
    let mut upd = input("web");
    upd.port = "2222".into();
    upd.auth = AuthMethod::Password { password: None };
    let out = s.update_host(&p.id, &h.id, &upd).unwrap();
    assert_eq!(
        (out.id.as_str(), out.port.as_str()),
        (h.id.as_str(), "2222")
    );
    assert!(matches!(
        s.update_host(&p.id, "nope", &upd),
        Err(ConfigError::NotFound(_))
    ));
    assert!(matches!(
        s.update_host(&other.id, &h.id, &upd),
        Err(ConfigError::NotFound(_))
    ));
    assert!(matches!(
        s.create_host("nope", &upd),
        Err(ConfigError::NotFound(_))
    ));
    let (removed, envs) = s.delete_host(&p.id, &h.id).unwrap();
    assert_eq!(removed.id, h.id);
    assert_eq!(envs, vec![e.id]);
    assert!(matches!(
        s.delete_host(&p.id, &h.id),
        Err(ConfigError::NotFound(_))
    ));
}

#[test]
fn literal_host_fields_are_validated_at_save_time() {
    let (_d, s, p, _) = setup();
    let try_with = |f: &dyn Fn(&mut HostInput)| {
        let mut i = input("h");
        f(&mut i);
        s.create_host(&p.id, &i)
    };
    for bad in ["0", "65536", "-1", "", "abc", "22 "] {
        invalid(try_with(&|i| i.port = bad.into()));
    }
    invalid(try_with(&|i| i.hostname = String::new()));
    invalid(try_with(&|i| i.hostname = "a b".into()));
    invalid(try_with(&|i| i.hostname = "a\u{7}b".into()));
    invalid(try_with(&|i| i.hostname = "a".repeat(254)));
    invalid(try_with(&|i| i.hostname = "$${host}".into()));
    invalid(try_with(&|i| i.username = String::new()));
    invalid(try_with(&|i| i.username = "a b".into()));
    invalid(try_with(&|i| i.username = "a".repeat(65)));
    invalid(try_with(&|i| i.name = " ".into()));
    let key = |path: &str| AuthMethod::Key {
        key_path: path.into(),
        passphrase: None,
    };
    invalid(try_with(&|i| i.auth = key("relative/key")));
    invalid(try_with(&|i| i.auth = key("")));
    invalid(try_with(&|i| {
        i.auth = key(&format!("{}{}", abs_key(), "a".repeat(4096)))
    }));
    for bad in ["a/b", "a_b", "a@b", "[::1]", "h\u{e9}ost", "a;b"] {
        invalid(try_with(&|i| i.hostname = bad.into()));
    }
    for bad in [
        r"\\server\share\key",
        r"\\?\UNC\server\share\key",
        r"\\?\C:\keys\key",
        r"\\.\pipe\x",
        "//server/share/key",
        "~",
        "~user/key",
    ] {
        invalid(try_with(&|i| i.auth = key(bad)));
    }
    for (n, good) in ["a.example", "10.0.0.1", "fe80::1", "my-host.local"]
        .iter()
        .enumerate()
    {
        let ok = try_with(&|i| {
            i.name = format!("good{n}");
            i.hostname = (*good).into();
        });
        assert!(ok.is_ok(), "{good}");
    }
    assert!(
        try_with(&|i| {
            i.name = "tilde".into();
            i.auth = key("~/.ssh/id_ed25519");
        })
        .is_ok()
    );
    assert!(
        try_with(&|i| {
            i.name = "max".into();
            i.port = "65535".into();
        })
        .is_ok()
    );
    assert!(
        try_with(&|i| {
            i.name = "dollar".into();
            i.username = "pc$".into();
        })
        .is_ok()
    );
}

#[test]
fn templated_host_fields_are_checked_after_resolution_only() {
    let (_d, s, p, _) = setup();
    let mut i = input("t");
    i.hostname = "${a b}".into();
    invalid(s.create_host(&p.id, &i));
    i.hostname = "${host}".into();
    i.port = "${port}".into();
    i.username = "${user}".into();
    i.auth = AuthMethod::Key {
        key_path: "${keys}/id".into(),
        passphrase: None,
    };
    assert!(s.create_host(&p.id, &i).is_ok());
    let mut long = input("long");
    long.hostname = format!("${{h}}{}", "a".repeat(1024));
    invalid(s.create_host(&p.id, &long));
}

#[test]
fn secret_fields_must_be_a_single_reference() {
    let (_d, s, p, _) = setup();
    let with = |n: &str, auth: AuthMethod| {
        let mut i = input(n);
        i.auth = auth;
        s.create_host(&p.id, &i)
    };
    for bad in ["hunter2", "${pw} ", "x${pw}", "${pw}${pw}", ""] {
        let r = with(
            "a",
            AuthMethod::Password {
                password: Some(bad.into()),
            },
        );
        let Err(ConfigError::InvalidInput(msg)) = r else {
            panic!("{bad}: {r:?}");
        };
        assert!(!msg.contains("hunter2"));
        invalid(with(
            "b",
            AuthMethod::Key {
                key_path: "~/k".into(),
                passphrase: Some(bad.into()),
            },
        ));
    }
    assert!(
        with(
            "pw",
            AuthMethod::Password {
                password: Some("${pw}".into())
            }
        )
        .is_ok()
    );
    assert!(
        with(
            "key",
            AuthMethod::Key {
                key_path: "~/k".into(),
                passphrase: Some("${pp}".into())
            }
        )
        .is_ok()
    );
}

#[test]
fn variables_replace_the_scope_and_return_the_previous_list() {
    let (_d, s, p, e) = setup();
    let global = VariableScope::Global;
    let project = VariableScope::Project {
        project_id: p.id.clone(),
    };
    let env = VariableScope::Environment {
        project_id: p.id.clone(),
        environment_id: e.id.clone(),
    };
    let (old, new) = s.set_variables(&global, &[plain("a", "1")]).unwrap();
    assert!(old.is_empty());
    assert_eq!(new, vec![plain("a", "1")]);
    let (old, _) = s.set_variables(&global, &[secret("b")]).unwrap();
    assert_eq!(old, vec![plain("a", "1")]);
    s.set_variables(&project, &[plain("p", "x")]).unwrap();
    s.set_variables(&env, &[plain("e", "y")]).unwrap();
    let cfg = s.snapshot().unwrap();
    assert_eq!(cfg.variables, vec![secret("b")]);
    assert_eq!(cfg.projects[0].variables, vec![plain("p", "x")]);
    assert_eq!(
        cfg.projects[0].environments[0].variables,
        vec![plain("e", "y")]
    );

    assert!(matches!(
        s.set_variables(
            &VariableScope::Project {
                project_id: "nope".into()
            },
            &[]
        ),
        Err(ConfigError::NotFound(_))
    ));
    assert!(matches!(
        s.set_variables(
            &VariableScope::Environment {
                project_id: p.id.clone(),
                environment_id: "nope".into()
            },
            &[]
        ),
        Err(ConfigError::NotFound(_))
    ));
}

#[test]
fn variable_validation() {
    let (_d, s) = store();
    let g = VariableScope::Global;
    for bad in ["", "9x", "a b", "a/b", "é", &"a".repeat(65)] {
        invalid(s.set_variables(&g, &[plain(bad, "v")]));
    }
    invalid(s.set_variables(&g, &[plain("Host", "a"), secret("host")]));
    invalid(s.set_variables(&g, &[plain("v", &"x".repeat(4097))]));
    assert!(
        s.set_variables(&g, &[plain("v", &"x".repeat(4096))])
            .is_ok()
    );
    let mut leaking = secret("pw");
    leaking.value = Some("hunter2".into());
    let Err(ConfigError::InvalidInput(msg)) = s.set_variables(&g, &[leaking]) else {
        panic!("secret with a value accepted");
    };
    assert!(!msg.contains("hunter2"));
    let many: Vec<_> = (0..201).map(|i| plain(&format!("v{i}"), "")).collect();
    invalid(s.set_variables(&g, &many));
    assert!(s.set_variables(&g, &many[..200]).is_ok());
    let none = Variable {
        name: "n".into(),
        kind: VariableKind::Plain,
        value: None,
    };
    let (_, saved) = s.set_variables(&g, &[none]).unwrap();
    assert_eq!(saved, vec![plain("n", "")]);
    assert!(
        s.snapshot()
            .unwrap()
            .variables
            .iter()
            .all(|v| v.value.as_deref() != Some("hunter2"))
    );
}

#[cfg(unix)]
#[test]
fn config_temp_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let s = ConfigStore::new(dir.path().to_path_buf());
    s.create_project("p").unwrap();
    let mode = fs::metadata(dir.path().join(FILE_NAME))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn wire_format_is_camel_case() {
    let json = serde_json::to_value(AuthMethod::Key {
        key_path: "/k".into(),
        passphrase: None,
    })
    .unwrap();
    assert_eq!(
        json,
        serde_json::json!({"kind":"key","keyPath":"/k","passphrase":null})
    );
    let a: AuthMethod = serde_json::from_str(r#"{"kind":"password"}"#).unwrap();
    assert_eq!(a, AuthMethod::Password { password: None });
    let a: AuthMethod = serde_json::from_str(r#"{"kind":"key","keyPath":"~/k"}"#).unwrap();
    assert_eq!(
        a,
        AuthMethod::Key {
            key_path: "~/k".into(),
            passphrase: None
        }
    );
    let h: HostInput = serde_json::from_str(
        r#"{"name":"a","hostname":"h","port":2222,"username":"u","auth":{"kind":"agent"}}"#,
    )
    .unwrap();
    assert_eq!(h.port, "2222");
    let h: HostInput = serde_json::from_str(
        r#"{"name":"a","hostname":"h","port":"${port}","username":"u","auth":{"kind":"agent"}}"#,
    )
    .unwrap();
    assert_eq!(h.port, "${port}");
    let scope: VariableScope =
        serde_json::from_str(r#"{"kind":"environment","projectId":"p","environmentId":"e"}"#)
            .unwrap();
    assert_eq!(
        scope,
        VariableScope::Environment {
            project_id: "p".into(),
            environment_id: "e".into()
        }
    );
    let g: VariableScope = serde_json::from_str(r#"{"kind":"global"}"#).unwrap();
    assert_eq!(g, VariableScope::Global);
}
