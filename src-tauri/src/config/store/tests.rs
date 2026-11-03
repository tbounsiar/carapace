use super::*;
use crate::config::model::{AuthMethod, HostInput, VariableKind};

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
fn missing_file_is_empty_v3() {
    let (_d, s) = store();
    let cfg = s.snapshot().unwrap();
    assert_eq!(cfg.version, 3);
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
    for raw in [r#"{"version":4,"projects":[]}"#, r#"{"projects":[]}"#] {
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
    let h = s.create_host(Some(&p.id), None, &i).unwrap();
    s.set_variables(&VariableScope::Global, &[plain("user", "me"), secret("pp")])
        .unwrap();
    s.set_active_environment(&p.id, Some(&e.id)).unwrap();
    let fresh = ConfigStore::new(d.path().to_path_buf());
    let cfg = fresh.snapshot().unwrap();
    assert_eq!(cfg.nodes, vec![Node::Host(h)]);
    assert_eq!(
        cfg.projects[0].active_environment_id.as_deref(),
        Some(e.id.as_str())
    );
    let raw: serde_json::Value =
        serde_json::from_slice(&fs::read(d.path().join(FILE_NAME)).unwrap()).unwrap();
    assert_eq!(raw["version"], 3);
    assert_eq!(
        raw["variables"][0],
        serde_json::json!({"name":"user","kind":"plain","value":"me"})
    );
    assert_eq!(
        raw["variables"][1],
        serde_json::json!({"name":"pp","kind":"secret","value":null})
    );
    assert!(raw["projects"][0].get("hosts").is_none());
    let host = &raw["nodes"][0];
    assert_eq!(host["kind"], "host");
    assert_eq!(host["projectId"], p.id);
    assert!(host["parentId"].is_null());
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
    assert_eq!(s.delete_project(&p.id).unwrap().0.id, p.id);
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
    let h = s.create_host(Some(&p.id), None, &input("web")).unwrap();
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
    let h = s.create_host(Some(&p.id), None, &input("web")).unwrap();
    assert!(matches!(
        s.create_host(Some(&p.id), None, &input("WEB")),
        Err(ConfigError::Conflict(_))
    ));
    let other = s.create_project("Beta").unwrap();
    assert!(s.create_host(Some(&other.id), None, &input("web")).is_ok());
    let db = s.create_host(Some(&p.id), None, &input("db")).unwrap();
    assert!(matches!(
        s.update_host(&db.id, &input("web")),
        Err(ConfigError::Conflict(_))
    ));
    let mut upd = input("web");
    upd.port = "2222".into();
    upd.auth = AuthMethod::Password { password: None };
    let out = s.update_host(&h.id, &upd).unwrap();
    assert_eq!(
        (out.id.as_str(), out.port.as_str()),
        (h.id.as_str(), "2222")
    );
    assert!(matches!(
        s.update_host("nope", &upd),
        Err(ConfigError::NotFound(_))
    ));
    assert!(matches!(
        s.create_host(Some("nope"), None, &upd),
        Err(ConfigError::NotFound(_))
    ));
    let (removed, envs) = s.delete_host(&h.id).unwrap();
    assert_eq!(removed.id, h.id);
    assert_eq!(envs, vec![e.id]);
    assert!(matches!(
        s.delete_host(&h.id),
        Err(ConfigError::NotFound(_))
    ));
}

#[test]
fn literal_host_fields_are_validated_at_save_time() {
    let (_d, s, p, _) = setup();
    let try_with = |f: &dyn Fn(&mut HostInput)| {
        let mut i = input("h");
        f(&mut i);
        s.create_host(Some(&p.id), None, &i)
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
    invalid(s.create_host(Some(&p.id), None, &i));
    i.hostname = "${host}".into();
    i.port = "${port}".into();
    i.username = "${user}".into();
    i.auth = AuthMethod::Key {
        key_path: "${keys}/id".into(),
        passphrase: None,
    };
    assert!(s.create_host(Some(&p.id), None, &i).is_ok());
    let mut long = input("long");
    long.hostname = format!("${{h}}{}", "a".repeat(1024));
    invalid(s.create_host(Some(&p.id), None, &long));
}

#[test]
fn secret_fields_must_be_a_single_reference() {
    let (_d, s, p, _) = setup();
    let with = |n: &str, auth: AuthMethod| {
        let mut i = input(n);
        i.auth = auth;
        s.create_host(Some(&p.id), None, &i)
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

#[test]
fn keys_default_to_empty_and_stay_unique() {
    let (d, s) = store();
    fs::write(d.path().join(FILE_NAME), r#"{"version":3,"projects":[]}"#).unwrap();
    assert!(s.snapshot().unwrap().keys.is_empty());
    let key = |id: &str, name: &str, path: &str| KeyEntry {
        id: id.into(),
        name: name.into(),
        path: path.into(),
        managed: false,
        algorithm: crate::config::KeyAlgorithm::Ed25519,
        bits: None,
        public_key: "ssh-ed25519 AAAA".into(),
        fingerprint: "SHA256:x".into(),
        comment: String::new(),
        encrypted: false,
    };
    s.add_key(key("1", " a ", "/k/a")).unwrap();
    assert_eq!(s.snapshot().unwrap().keys[0].name, "a");
    assert!(matches!(
        s.add_key(key("2", "A", "/k/b")),
        Err(ConfigError::Exists(_))
    ));
    assert!(matches!(
        s.add_key(key("2", "b", "/k/a")),
        Err(ConfigError::Exists(_))
    ));
    invalid(s.add_key(key("2", &"x".repeat(65), "/k/c")));
    s.add_key(key("2", "b", "/k/b")).unwrap();
    assert!(matches!(
        s.rename_key("2", "A"),
        Err(ConfigError::Exists(_))
    ));
    assert_eq!(s.rename_key("2", "c").unwrap().name, "c");
    assert!(matches!(
        s.delete_key("9"),
        Err(ConfigError::NotFound("key"))
    ));
    assert_eq!(s.delete_key("1").unwrap().path, "/k/a");
    assert_eq!(s.snapshot().unwrap().keys.len(), 1);
}

const V2_FIXTURE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/config-v2.json"
));

fn json(raw: &[u8]) -> serde_json::Value {
    serde_json::from_slice(raw).unwrap()
}

/// The v3 document a v2 document must become: projects lose `hosts`, every host becomes a
/// root node of its project, everything else is copied as is.
fn expected_v3(v2: &serde_json::Value) -> serde_json::Value {
    let mut projects = Vec::new();
    let mut nodes = Vec::new();
    for p in v2["projects"].as_array().unwrap() {
        let mut project = p.as_object().unwrap().clone();
        for h in project.remove("hosts").unwrap().as_array().unwrap() {
            let mut node = h.as_object().unwrap().clone();
            node.insert("kind".into(), "host".into());
            node.insert("projectId".into(), p["id"].clone());
            node.insert("parentId".into(), serde_json::Value::Null);
            nodes.push(serde_json::Value::Object(node));
        }
        projects.push(serde_json::Value::Object(project));
    }
    serde_json::json!({
        "version": 3,
        "variables": v2["variables"],
        "projects": projects,
        "nodes": nodes,
        "keys": v2["keys"],
    })
}

#[test]
fn v2_fixture_holds_no_secret_value() {
    let v2 = json(V2_FIXTURE);
    assert_eq!(v2["version"], 2);
    let mut lists = vec![&v2["variables"]];
    for p in v2["projects"].as_array().unwrap() {
        lists.push(&p["variables"]);
        for e in p["environments"].as_array().unwrap() {
            lists.push(&e["variables"]);
        }
        for h in p["hosts"].as_array().unwrap() {
            for field in ["password", "passphrase"] {
                if let Some(v) = h["auth"].get(field).and_then(|v| v.as_str()) {
                    assert!(crate::vars::single_reference(v).is_some(), "{v}");
                }
            }
        }
    }
    let mut secrets = 0;
    for v in lists.into_iter().flat_map(|l| l.as_array().unwrap()) {
        if v["kind"] == "secret" {
            secrets += 1;
            assert!(v["value"].is_null(), "{v}");
        }
    }
    assert!(secrets > 0, "the fixture covers secret variables");
}

#[test]
fn v2_fixture_migrates_losslessly_with_a_byte_identical_backup() {
    let (d, s) = store();
    fs::write(d.path().join(FILE_NAME), V2_FIXTURE).unwrap();
    let cfg = s.snapshot().unwrap();
    assert_eq!(fs::read(d.path().join(V2_BACKUP)).unwrap(), V2_FIXTURE);
    let expected = expected_v3(&json(V2_FIXTURE));
    assert_eq!(json(&fs::read(d.path().join(FILE_NAME)).unwrap()), expected);
    assert_eq!(serde_json::to_value(&cfg).unwrap(), expected);
    assert_eq!(cfg.nodes.len(), 5);
    assert!(!d.path().join(TMP_NAME).exists());

    let again = ConfigStore::new(d.path().to_path_buf()).snapshot().unwrap();
    assert_eq!(again, cfg);
    assert!(!d.path().join("config.json.v2.2.bak").exists());
}

#[test]
fn v2_fields_are_copied_one_by_one() {
    let (d, s) = store();
    let (p, e, h) = (
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
    );
    let v2 = format!(
        r#"{{"version":2,
        "variables":[{{"name":"g","kind":"plain","value":"1"}}],
        "projects":[
          {{"id":"{p}","name":"P","variables":[{{"name":"s","kind":"secret","value":null}}],
            "environments":[{{"id":"{e}","name":"dev","variables":[{{"name":"x","kind":"plain","value":"y"}}]}}],
            "hosts":[{{"id":"{h}","name":"web","hostname":"${{host}}","port":"2222","username":"u",
              "auth":{{"kind":"key","keyPath":"~/.ssh/id","passphrase":"${{s}}"}}}}],
            "activeEnvironmentId":"{e}"}},
          {{"id":"00000000-0000-4000-8000-000000000004","name":"Bare"}}],
        "keys":[{{"id":"k","name":"key","path":"/k","managed":false,"algorithm":"rsa","bits":4096,
          "publicKey":"ssh-rsa AAAA","fingerprint":"SHA256:x","comment":"c","encrypted":true}}]}}"#
    );
    fs::write(d.path().join(FILE_NAME), &v2).unwrap();
    let cfg = s.snapshot().unwrap();
    assert_eq!(cfg.version, 3);
    assert_eq!(cfg.variables, vec![plain("g", "1")]);
    let project = &cfg.projects[0];
    assert_eq!((project.id.as_str(), project.name.as_str()), (p, "P"));
    assert_eq!(project.variables, vec![secret("s")]);
    assert_eq!(project.environments.len(), 1);
    assert_eq!(project.environments[0].id, e);
    assert_eq!(project.environments[0].name, "dev");
    assert_eq!(project.environments[0].variables, vec![plain("x", "y")]);
    assert_eq!(project.active_environment_id.as_deref(), Some(e));
    let bare = &cfg.projects[1];
    assert_eq!(bare.name, "Bare");
    assert!(bare.variables.is_empty() && bare.environments.is_empty());
    assert!(bare.active_environment_id.is_none());
    assert_eq!(
        cfg.nodes,
        vec![Node::Host(Host {
            id: h.into(),
            name: "web".into(),
            project_id: Some(p.into()),
            parent_id: None,
            hostname: "${host}".into(),
            port: "2222".into(),
            username: "u".into(),
            auth: AuthMethod::Key {
                key_path: "~/.ssh/id".into(),
                passphrase: Some("${s}".into()),
            },
        })]
    );
    let key = &cfg.keys[0];
    assert_eq!(
        (key.id.as_str(), key.name.as_str(), key.path.as_str()),
        ("k", "key", "/k")
    );
    assert!(!key.managed && key.encrypted);
    assert_eq!(key.algorithm, crate::config::KeyAlgorithm::Rsa);
    assert_eq!(key.bits, Some(4096));
    assert_eq!(
        (
            key.public_key.as_str(),
            key.fingerprint.as_str(),
            key.comment.as_str()
        ),
        ("ssh-rsa AAAA", "SHA256:x", "c")
    );
    assert_eq!(fs::read_to_string(d.path().join(V2_BACKUP)).unwrap(), v2);
}

#[test]
fn v2_backups_are_never_overwritten() {
    let (d, s) = store();
    fs::write(d.path().join(V2_BACKUP), "older").unwrap();
    fs::write(d.path().join(FILE_NAME), V2_FIXTURE).unwrap();
    s.snapshot().unwrap();
    assert_eq!(
        fs::read_to_string(d.path().join(V2_BACKUP)).unwrap(),
        "older"
    );
    assert_eq!(
        fs::read(d.path().join("config.json.v2.2.bak")).unwrap(),
        V2_FIXTURE
    );
}

#[test]
fn failed_v2_backup_changes_nothing() {
    let (d, s) = store();
    fs::write(d.path().join(V2_BACKUP), "taken").unwrap();
    for n in 2..=MAX_BACKUPS {
        fs::write(d.path().join(format!("config.json.v2.{n}.bak")), "taken").unwrap();
    }
    fs::write(d.path().join(FILE_NAME), V2_FIXTURE).unwrap();
    assert!(matches!(s.snapshot(), Err(ConfigError::Io)));
    assert!(matches!(s.create_project("x"), Err(ConfigError::Io)));
    assert_eq!(fs::read(d.path().join(FILE_NAME)).unwrap(), V2_FIXTURE);
    assert_eq!(
        fs::read_to_string(d.path().join(V2_BACKUP)).unwrap(),
        "taken"
    );
}

#[test]
fn v2_breaking_the_invariants_is_corrupt_and_left_alone() {
    let (d, s) = store();
    let raw = r#"{"version":2,"projects":[{"id":"p1","name":"A","hosts":[]}]}"#;
    fs::write(d.path().join(FILE_NAME), raw).unwrap();
    assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)));
    assert_eq!(fs::read_to_string(d.path().join(FILE_NAME)).unwrap(), raw);
    assert!(!d.path().join(V2_BACKUP).exists());
}

#[test]
fn v3_breaking_the_invariants_is_corrupt() {
    let id = |n: u8| format!("0000000a-0000-4000-8000-0000000000{n:02}");
    let (p, e) = (id(1), id(2));
    let coll = |i: &str, project: Option<&str>, parent: Option<&str>| serde_json::json!({"kind":"collection","id":i,"name":i,"projectId":project,"parentId":parent});
    let host = |i: &str, project: Option<&str>, parent: Option<&str>| {
        serde_json::json!({"kind":"host","id":i,"name":i,"projectId":project,"parentId":parent,
            "hostname":"h","port":"22","username":"u","auth":{"kind":"agent"}})
    };
    let file = |nodes: Vec<serde_json::Value>| {
        serde_json::json!({"version":3,"projects":[{"id":p,"name":"P",
            "environments":[{"id":e,"name":"dev"}]}],"nodes":nodes})
    };
    let (a, b) = (id(10), id(11));
    let good = file(vec![coll(&a, Some(&p), None), host(&b, Some(&p), Some(&a))]);
    let bad = [
        file(vec![coll(&a.to_uppercase(), None, None)]),
        file(vec![coll("c1", None, None)]),
        file(vec![coll(&a, None, None), host(&a, None, None)]),
        file(vec![coll(&e, None, None)]),
        file(vec![coll(&a, Some(&id(99)), None)]),
        file(vec![host(&b, None, Some(&id(99)))]),
        file(vec![host(&a, None, None), host(&b, None, Some(&a))]),
        file(vec![coll(&a, Some(&p), None), host(&b, None, Some(&a))]),
        file(vec![coll(&a, None, Some(&b)), coll(&b, None, Some(&a))]),
        file(vec![coll(&a, None, Some(&a))]),
        file(vec![serde_json::json!({"kind":"folder","id":a,"name":"x"})]),
    ];
    let (d, s) = store();
    fs::write(d.path().join(FILE_NAME), good.to_string()).unwrap();
    assert_eq!(s.snapshot().unwrap().nodes.len(), 2);
    for raw in bad {
        let raw = raw.to_string();
        fs::write(d.path().join(FILE_NAME), &raw).unwrap();
        assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)), "{raw}");
        assert!(matches!(s.create_project("x"), Err(ConfigError::Corrupt)));
        assert_eq!(fs::read_to_string(d.path().join(FILE_NAME)).unwrap(), raw);
    }
}

#[test]
fn oversized_file_is_corrupt_and_left_alone() {
    let (d, s) = store();
    let mut raw = br#"{"version":3,"projects":[],"pad":""#.to_vec();
    raw.resize(MAX_FILE_BYTES as usize + 1, b' ');
    fs::write(d.path().join(FILE_NAME), &raw).unwrap();
    assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)));
    assert_eq!(fs::read(d.path().join(FILE_NAME)).unwrap().len(), raw.len());
}

#[test]
fn node_count_and_depth_limits_are_checked_on_load() {
    let id = || uuid::Uuid::new_v4().to_string();
    let coll = |i: &str, parent: Option<&str>| serde_json::json!({"kind":"collection","id":i,"name":i,"projectId":null,"parentId":parent});
    let (d, s) = store();
    let write = |nodes: Vec<serde_json::Value>| {
        fs::write(
            d.path().join(FILE_NAME),
            serde_json::json!({"version":3,"nodes":nodes}).to_string(),
        )
        .unwrap();
    };
    let many: Vec<_> = (0..=validate::MAX_NODES)
        .map(|_| coll(&id(), None))
        .collect();
    write(many[..validate::MAX_NODES].to_vec());
    assert!(s.snapshot().is_ok());
    write(many);
    assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)));

    let mut chain = Vec::new();
    let mut parent: Option<String> = None;
    for _ in 0..=validate::MAX_DEPTH {
        let i = id();
        chain.push(coll(&i, parent.as_deref()));
        parent = Some(i);
    }
    write(chain[..validate::MAX_DEPTH].to_vec());
    assert!(s.snapshot().is_ok());
    write(chain);
    assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)));
}

#[test]
fn active_environment_must_be_one_of_the_project() {
    let (d, s) = store();
    let (p, e, q, f) = (
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
    );
    let file = |version: u32, active: &str| {
        format!(
            r#"{{"version":{version},"projects":[
              {{"id":"{p}","name":"P","environments":[{{"id":"{e}","name":"dev"}}],"activeEnvironmentId":"{active}"}},
              {{"id":"{q}","name":"Q","environments":[{{"id":"{f}","name":"dev"}}]}}]}}"#
        )
    };
    fs::write(d.path().join(FILE_NAME), file(3, e)).unwrap();
    assert!(s.snapshot().is_ok());
    for bad in [f, "00000000-0000-4000-8000-000000000009"] {
        let raw = file(3, bad);
        fs::write(d.path().join(FILE_NAME), &raw).unwrap();
        assert!(matches!(s.snapshot(), Err(ConfigError::Corrupt)));
        assert_eq!(fs::read_to_string(d.path().join(FILE_NAME)).unwrap(), raw);
    }
    let v2 = file(2, f);
    fs::write(d.path().join(FILE_NAME), &v2).unwrap();
    let cfg = s.snapshot().unwrap();
    assert!(cfg.projects[0].active_environment_id.is_none());
    assert_eq!(fs::read_to_string(d.path().join(V2_BACKUP)).unwrap(), v2);
}
