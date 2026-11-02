use tauri::State;

use super::error::CommandError;
use super::secrets::{forget, same_endpoint};
use crate::config::model::AuthMethod;
use crate::config::{ConfigStore, Environment, Host, HostInput, Project};
use crate::secrets::{SecretKind, SecretScope, SecretStore};

type Res<T> = Result<T, CommandError>;

#[tauri::command]
pub async fn list_projects(store: State<'_, ConfigStore>) -> Res<Vec<Project>> {
    Ok(store.list_projects()?)
}

#[tauri::command]
pub async fn create_project(store: State<'_, ConfigStore>, name: String) -> Res<Project> {
    Ok(store.create_project(&name)?)
}

#[tauri::command]
pub async fn rename_project(
    store: State<'_, ConfigStore>,
    project_id: String,
    name: String,
) -> Res<Project> {
    Ok(store.rename_project(&project_id, &name)?)
}

fn scopes_where(store: &ConfigStore, keep: impl Fn(&str, &str) -> bool) -> Res<Vec<SecretScope>> {
    let mut out = Vec::new();
    for p in store.list_projects()? {
        for e in &p.environments {
            if keep(&p.id, &e.id) {
                // A non-UUID id can never have a keychain entry.
                out.extend(
                    e.hosts
                        .iter()
                        .filter_map(|h| SecretScope::new(&p.id, &e.id, &h.id).ok()),
                );
            }
        }
    }
    Ok(out)
}

fn forget_all(secrets: &SecretStore, scopes: &[SecretScope]) {
    for scope in scopes {
        forget(secrets, scope, &SecretKind::ALL);
    }
}

fn remove_project(store: &ConfigStore, secrets: &SecretStore, project_id: &str) -> Res<()> {
    let scopes = scopes_where(store, |p, _| p == project_id)?;
    store.delete_project(project_id)?;
    forget_all(secrets, &scopes);
    Ok(())
}

fn remove_environment(
    store: &ConfigStore,
    secrets: &SecretStore,
    project_id: &str,
    environment_id: &str,
) -> Res<()> {
    let scopes = scopes_where(store, |p, e| p == project_id && e == environment_id)?;
    store.delete_environment(project_id, environment_id)?;
    forget_all(secrets, &scopes);
    Ok(())
}

fn remove_host(
    store: &ConfigStore,
    secrets: &SecretStore,
    project_id: &str,
    environment_id: &str,
    host_id: &str,
) -> Res<()> {
    store.delete_host(project_id, environment_id, host_id)?;
    if let Ok(scope) = SecretScope::new(project_id, environment_id, host_id) {
        forget_all(secrets, &[scope]);
    }
    Ok(())
}

/// Secrets that no longer fit the host once the update is saved: a password belongs to one
/// remote account, a passphrase to one key file.
fn obsolete_secrets(old: Option<&Host>, new: &Host) -> Vec<SecretKind> {
    let mut out = Vec::new();
    let same_account = old.is_some_and(|o| same_endpoint(o, new));
    if !matches!(new.auth, AuthMethod::Password) || !same_account {
        out.push(SecretKind::Password);
    }
    let same_key = matches!(
        (old.map(|o| &o.auth), &new.auth),
        (Some(AuthMethod::Key { key_path: a }), AuthMethod::Key { key_path: b }) if a == b
    );
    if !same_key {
        out.push(SecretKind::Passphrase);
    }
    out
}

fn change_host(
    store: &ConfigStore,
    secrets: &SecretStore,
    project_id: &str,
    environment_id: &str,
    host_id: &str,
    input: &HostInput,
) -> Res<Host> {
    let old = store
        .list_projects()?
        .into_iter()
        .filter(|p| p.id == project_id)
        .flat_map(|p| p.environments)
        .filter(|e| e.id == environment_id)
        .flat_map(|e| e.hosts)
        .find(|h| h.id == host_id);
    let host = store.update_host(project_id, environment_id, host_id, input)?;
    let kinds = obsolete_secrets(old.as_ref(), &host);
    if let Ok(scope) = SecretScope::new(project_id, environment_id, host_id) {
        forget(secrets, &scope, &kinds);
    }
    Ok(host)
}

#[tauri::command]
pub async fn delete_project(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
) -> Res<()> {
    remove_project(&store, &secrets, &project_id)
}

#[tauri::command]
pub async fn create_environment(
    store: State<'_, ConfigStore>,
    project_id: String,
    name: String,
) -> Res<Environment> {
    Ok(store.create_environment(&project_id, &name)?)
}

#[tauri::command]
pub async fn rename_environment(
    store: State<'_, ConfigStore>,
    project_id: String,
    environment_id: String,
    name: String,
) -> Res<Environment> {
    Ok(store.rename_environment(&project_id, &environment_id, &name)?)
}

#[tauri::command]
pub async fn delete_environment(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    environment_id: String,
) -> Res<()> {
    remove_environment(&store, &secrets, &project_id, &environment_id)
}

#[tauri::command]
pub async fn create_host(
    store: State<'_, ConfigStore>,
    project_id: String,
    environment_id: String,
    host: HostInput,
) -> Res<Host> {
    Ok(store.create_host(&project_id, &environment_id, &host)?)
}

#[tauri::command]
pub async fn update_host(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    environment_id: String,
    host_id: String,
    host: HostInput,
) -> Res<Host> {
    change_host(
        &store,
        &secrets,
        &project_id,
        &environment_id,
        &host_id,
        &host,
    )
}

#[tauri::command]
pub async fn delete_host(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    environment_id: String,
    host_id: String,
) -> Res<()> {
    remove_host(&store, &secrets, &project_id, &environment_id, &host_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, ConfigStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = ConfigStore::new(dir.path().to_path_buf());
        (dir, s)
    }

    #[test]
    fn store_errors_map_to_contract_codes() {
        let (_d, s) = store();
        s.create_project("A").unwrap();
        let code = |r: Result<_, crate::config::ConfigError>| -> &'static str {
            let r: Res<()> = r.map(|_: Project| ()).map_err(CommandError::from);
            r.unwrap_err().code
        };
        assert_eq!(code(s.create_project("a")), "conflict");
        assert_eq!(code(s.create_project(" ")), "invalid_input");
        assert_eq!(code(s.rename_project("nope", "x")), "not_found");
    }

    #[test]
    fn corrupt_file_maps_to_corrupt_config() {
        let (d, s) = store();
        std::fs::write(d.path().join("config.json"), "garbage").unwrap();
        let err = s.list_projects().map_err(CommandError::from).unwrap_err();
        assert_eq!(err.code, "corrupt_config");
        assert!(!err.message.contains("garbage"));
    }

    mod lifecycle {
        use super::super::*;
        use crate::secrets::MemoryBackend;
        use secrecy::SecretString;
        use std::sync::Arc;

        struct World {
            _dir: tempfile::TempDir,
            store: ConfigStore,
            secrets: SecretStore,
            mem: Arc<MemoryBackend>,
        }

        fn world() -> World {
            let dir = tempfile::tempdir().unwrap();
            let store = ConfigStore::new(dir.path().to_path_buf());
            let (secrets, mem) = MemoryBackend::store();
            World {
                _dir: dir,
                store,
                secrets,
                mem,
            }
        }

        fn input(name: &str, auth: AuthMethod) -> HostInput {
            HostInput {
                name: name.into(),
                hostname: "web.example".into(),
                port: 22,
                username: "me".into(),
                auth,
            }
        }

        fn key(path: &str) -> AuthMethod {
            AuthMethod::Key {
                key_path: path.into(),
            }
        }

        fn seed(w: &World, p: &str, e: &str, h: &str) -> SecretScope {
            let scope = SecretScope::new(p, e, h).unwrap();
            for kind in SecretKind::ALL {
                w.secrets
                    .set(&scope, kind, &SecretString::from("s"))
                    .unwrap();
            }
            scope
        }

        fn kinds(w: &World, scope: &SecretScope) -> Vec<SecretKind> {
            SecretKind::ALL
                .into_iter()
                .filter(|k| w.secrets.has(scope, *k).unwrap())
                .collect()
        }

        struct Tree {
            p1: String,
            e1: String,
            e2: String,
            p2: String,
            e3: String,
            h1: String,
            h2: String,
            h3: String,
            h4: String,
        }

        fn tree(w: &World) -> Tree {
            let s = &w.store;
            let p1 = s.create_project("p1").unwrap().id;
            let p2 = s.create_project("p2").unwrap().id;
            let e1 = s.create_environment(&p1, "dev").unwrap().id;
            let e2 = s.create_environment(&p1, "prod").unwrap().id;
            let e3 = s.create_environment(&p2, "dev").unwrap().id;
            let host = |p: &str, e: &str, n: &str| {
                s.create_host(p, e, &input(n, AuthMethod::Password))
                    .unwrap()
                    .id
            };
            let h1 = host(&p1, &e1, "a");
            let h2 = host(&p1, &e1, "b");
            let h3 = host(&p1, &e2, "c");
            let h4 = host(&p2, &e3, "d");
            Tree {
                p1,
                e1,
                e2,
                p2,
                e3,
                h1,
                h2,
                h3,
                h4,
            }
        }

        #[test]
        fn delete_host_removes_only_its_secrets() {
            let w = world();
            let t = tree(&w);
            let a = seed(&w, &t.p1, &t.e1, &t.h1);
            let b = seed(&w, &t.p1, &t.e1, &t.h2);
            remove_host(&w.store, &w.secrets, &t.p1, &t.e1, &t.h1).unwrap();
            assert!(kinds(&w, &a).is_empty());
            assert_eq!(kinds(&w, &b).len(), 2);
        }

        #[test]
        fn delete_environment_and_project_remove_their_hosts_secrets() {
            let w = world();
            let t = tree(&w);
            let a = seed(&w, &t.p1, &t.e1, &t.h1);
            let b = seed(&w, &t.p1, &t.e1, &t.h2);
            let c = seed(&w, &t.p1, &t.e2, &t.h3);
            let d = seed(&w, &t.p2, &t.e3, &t.h4);
            remove_environment(&w.store, &w.secrets, &t.p1, &t.e1).unwrap();
            assert!(kinds(&w, &a).is_empty() && kinds(&w, &b).is_empty());
            assert_eq!(kinds(&w, &c).len(), 2);
            remove_project(&w.store, &w.secrets, &t.p1).unwrap();
            assert!(kinds(&w, &c).is_empty());
            assert_eq!(kinds(&w, &d).len(), 2);
            assert_eq!(w.mem.accounts().len(), 2);
        }

        #[test]
        fn failed_delete_keeps_secrets() {
            let w = world();
            let t = tree(&w);
            let a = seed(&w, &t.p1, &t.e1, &t.h1);
            assert!(remove_host(&w.store, &w.secrets, &t.p2, &t.e3, &t.h1).is_err());
            assert!(remove_environment(&w.store, &w.secrets, &t.p2, &t.e1).is_err());
            assert!(remove_project(&w.store, &w.secrets, "nope").is_err());
            assert_eq!(kinds(&w, &a).len(), 2);
        }

        #[test]
        fn keychain_failure_does_not_fail_the_delete() {
            let w = world();
            let t = tree(&w);
            w.mem.set_failing(true);
            remove_host(&w.store, &w.secrets, &t.p1, &t.e1, &t.h1).unwrap();
            remove_project(&w.store, &w.secrets, &t.p2).unwrap();
            assert_eq!(w.store.list_projects().unwrap().len(), 1);
        }

        #[test]
        fn update_host_drops_secrets_that_no_longer_fit() {
            let w = world();
            let t = tree(&w);
            let upd = |auth: AuthMethod| {
                change_host(&w.store, &w.secrets, &t.p1, &t.e1, &t.h1, &input("a", auth)).unwrap()
            };
            let a = seed(&w, &t.p1, &t.e1, &t.h1);
            upd(AuthMethod::Password);
            assert_eq!(kinds(&w, &a), vec![SecretKind::Password]);

            seed(&w, &t.p1, &t.e1, &t.h1);
            upd(key("~/.ssh/id_a"));
            assert!(kinds(&w, &a).is_empty());

            seed(&w, &t.p1, &t.e1, &t.h1);
            upd(key("~/.ssh/id_a"));
            assert_eq!(kinds(&w, &a), vec![SecretKind::Passphrase]);

            upd(key("~/.ssh/id_b"));
            assert!(kinds(&w, &a).is_empty());

            seed(&w, &t.p1, &t.e1, &t.h1);
            upd(AuthMethod::Agent);
            assert!(kinds(&w, &a).is_empty());
        }

        #[test]
        fn failed_update_keeps_secrets() {
            let w = world();
            let t = tree(&w);
            let a = seed(&w, &t.p1, &t.e1, &t.h1);
            let bad = input(" ", AuthMethod::Agent);
            assert!(change_host(&w.store, &w.secrets, &t.p1, &t.e1, &t.h1, &bad).is_err());
            assert_eq!(kinds(&w, &a).len(), 2);
        }

        fn host(auth: AuthMethod) -> Host {
            Host {
                id: "h".into(),
                name: "h".into(),
                hostname: "web.example".into(),
                port: 22,
                username: "me".into(),
                auth,
            }
        }

        #[test]
        fn obsolete_secret_rules() {
            use SecretKind::*;
            let k = host(key("~/k"));
            let pw = host(AuthMethod::Password);
            assert_eq!(obsolete_secrets(Some(&k), &pw), vec![Passphrase]);
            assert_eq!(obsolete_secrets(Some(&pw), &pw), vec![Passphrase]);
            assert_eq!(obsolete_secrets(Some(&k), &k), vec![Password]);
            assert_eq!(
                obsolete_secrets(Some(&k), &host(key("~/other"))),
                vec![Password, Passphrase]
            );
            assert_eq!(obsolete_secrets(Some(&pw), &k), vec![Password, Passphrase]);
            assert_eq!(obsolete_secrets(None, &k), vec![Password, Passphrase]);
            assert_eq!(obsolete_secrets(None, &pw), vec![Password, Passphrase]);
            let agent = host(AuthMethod::Agent);
            assert_eq!(
                obsolete_secrets(Some(&agent), &agent),
                vec![Password, Passphrase]
            );
            let renamed = Host {
                name: "other".into(),
                ..pw.clone()
            };
            assert_eq!(obsolete_secrets(Some(&pw), &renamed), vec![Passphrase]);
            for moved in [
                Host {
                    hostname: "db.example".into(),
                    ..pw.clone()
                },
                Host {
                    port: 2222,
                    ..pw.clone()
                },
                Host {
                    username: "root".into(),
                    ..pw.clone()
                },
            ] {
                assert_eq!(
                    obsolete_secrets(Some(&pw), &moved),
                    vec![Password, Passphrase]
                );
            }
            let k_moved = Host {
                hostname: "db.example".into(),
                ..k.clone()
            };
            assert_eq!(obsolete_secrets(Some(&k), &k_moved), vec![Password]);
        }

        #[test]
        fn update_host_drops_the_password_when_the_endpoint_changes() {
            let w = world();
            let t = tree(&w);
            let a = seed(&w, &t.p1, &t.e1, &t.h1);
            let mut moved = input("a", AuthMethod::Password);
            moved.port = 2222;
            change_host(&w.store, &w.secrets, &t.p1, &t.e1, &t.h1, &moved).unwrap();
            assert!(kinds(&w, &a).is_empty());

            seed(&w, &t.p1, &t.e1, &t.h1);
            let renamed = HostInput {
                name: "renamed".into(),
                ..moved
            };
            change_host(&w.store, &w.secrets, &t.p1, &t.e1, &t.h1, &renamed).unwrap();
            assert_eq!(kinds(&w, &a), vec![SecretKind::Password]);
        }
    }
}
