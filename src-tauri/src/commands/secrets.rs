use std::path::PathBuf;
use std::sync::Arc;

use secrecy::{ExposeSecret, SecretString};
use tauri::State;

use super::error::CommandError;
use super::resolve::{self, required};
use crate::config::{
    ConfigFile, ConfigStore, Held, KeychainMigration, LegacyProject, MigrationPlan, Variable,
    VariableKind,
};
use crate::secrets::{SavedKey, SecretKind, SecretStore, VarKey};

type Res<T> = Result<T, CommandError>;

/// Upper bound for a typed secret; storing one is further limited by the keychain.
const MAX_SECRET_CHARS: usize = 4096;

fn invalid(message: &str) -> CommandError {
    CommandError::new("invalid_input", message)
}

/// Checked before the value is used; the message never includes it.
pub(super) fn check_secret(value: &SecretString) -> Res<()> {
    let value = value.expose_secret();
    if value.is_empty() {
        return Err(invalid("the secret must not be empty"));
    }
    if value.chars().count() > MAX_SECRET_CHARS {
        return Err(invalid("the secret is too long"));
    }
    Ok(())
}

/// Secret variable keys of a list; `key` builds the account for the list's level.
pub(super) fn secret_keys(
    variables: &[Variable],
    key: impl Fn(&str) -> Option<VarKey>,
) -> Vec<VarKey> {
    variables
        .iter()
        .filter(|v| v.kind == VariableKind::Secret)
        .filter_map(|v| key(&v.name))
        .collect()
}

/// Best effort: a keychain failure must not undo a config change that already happened.
/// Logged by scope id only.
pub(super) fn forget_variables(secrets: &SecretStore, scope_id: &str, keys: &[VarKey]) {
    for key in keys {
        if secrets.delete_var(key).is_err() {
            log::warn!("could not delete a secret variable of {scope_id} from the keychain");
        }
    }
}

/// Bounds the keychain calls one cleanup makes, whatever the file held.
const MAX_LEGACY_ACCOUNTS: usize = 20_000;

/// The keychain side of a configuration migration. Every store operation holds the lifecycle
/// lock through `enter`, so `before_save` runs under lifecycle + store lock, like `move_node`.
pub struct Migration {
    secrets: SecretStore,
}

impl KeychainMigration for Migration {
    fn enter(&self) -> Box<dyn Held + '_> {
        Box::new(self.secrets.lifecycle())
    }

    fn before_save(&self, plan: &MigrationPlan) -> Result<(), ()> {
        move_environment_secrets(&self.secrets, plan)
    }
}

/// The store the app uses: it migrates environment secrets through `secrets`.
pub fn config_store(dir: PathBuf, secrets: &SecretStore) -> ConfigStore {
    ConfigStore::with_migration(
        dir,
        Arc::new(Migration {
            secrets: secrets.clone(),
        }),
    )
}

/// Moves the secrets of every flattened active environment into its project before the migrated
/// file is written. Every environment value is read first, then the replaced project secrets
/// are deleted, then each copied secret is set, or deleted from the project when the
/// environment has no value. Any failure aborts the migration, which is retried as a whole on
/// the next load (every step is idempotent). Values stay in `SecretString`; logs carry ids only.
///
/// Run again after the cleanup deleted the environment accounts (an old file restored, or a
/// second instance migrating the same file), a copied secret finds no value and its project
/// account is deleted: the host then asks for it instead of using a stale or leftover value.
fn move_environment_secrets(secrets: &SecretStore, plan: &MigrationPlan) -> Result<(), ()> {
    let mut copies: Vec<(&str, VarKey, Option<SecretString>)> = Vec::new();
    for p in &plan.projects {
        let fail = |what: &str| log::warn!("could not {what} for project {}", p.project_id);
        for name in &p.copy {
            let key = VarKey::project(&p.project_id, name).map_err(|_| fail("name a secret"))?;
            let value = secrets
                .get_legacy_env_var(&p.environment_id, name)
                .map_err(|_| fail("read an environment secret"))?;
            copies.push((&p.project_id, key, value));
        }
    }
    for p in &plan.projects {
        for old in &p.delete {
            let key = VarKey::project(&p.project_id, old).map_err(|_| ())?;
            secrets.delete_var(&key).map_err(|_| {
                log::warn!(
                    "could not delete a replaced secret variable for project {}",
                    p.project_id
                );
            })?;
        }
    }
    for (project_id, key, value) in &copies {
        let done = match value {
            Some(v) => secrets.set_var(key, v),
            None => secrets.delete_var(key),
        };
        done.map_err(|_| {
            log::warn!("could not store a moved secret variable for project {project_id}")
        })?;
    }
    Ok(())
}

/// Deletes the keychain entries the config no longer references: the iteration-2 entries of
/// hosts whose version 1 config was moved aside, and those of environments dropped from a
/// version 2 or 3 file (their secrets that still matter were moved before the file was
/// written). Best effort, bounded by `MAX_LEGACY_ACCOUNTS`, logged by id or count only.
pub fn forget_legacy(store: &ConfigStore, secrets: &SecretStore) {
    // A migration running elsewhere reads environment values under this lock.
    let _lifecycle = secrets.lifecycle();
    forget_environments(secrets, &store.take_legacy_projects());
    for h in store.take_legacy_hosts() {
        if secrets
            .delete_legacy(&h.project_id, &h.environment_id, &h.host_id)
            .is_err()
        {
            log::warn!(
                "could not delete the legacy secrets of host {} from the keychain",
                h.host_id
            );
        }
    }
}

fn forget_environments(secrets: &SecretStore, projects: &[LegacyProject]) {
    let mut budget = MAX_LEGACY_ACCOUNTS;
    let total: usize = projects.iter().map(|p| p.environments.len()).sum();
    let mut done = 0usize;
    for p in projects {
        for e in &p.environments {
            let calls = e.secret_variables.len() + 2 * p.host_ids.len();
            if calls > budget {
                log::warn!(
                    "environment cleanup cap hit: {} of {total} environments keep their keychain entries",
                    total - done
                );
                return;
            }
            budget -= calls;
            done += 1;
            if secrets
                .delete_legacy_environment(&e.environment_id, &e.secret_variables, &p.host_ids)
                .is_err()
            {
                log::warn!(
                    "could not delete the secrets of environment {} from the keychain",
                    e.environment_id
                );
            }
        }
    }
}

/// Deletes the saved connection secrets of `host_id`. Best effort, logged by host id only.
pub(super) fn forget_saved(secrets: &SecretStore, host_id: &str) {
    // A non-UUID id can never have a keychain entry.
    let Ok(key) = SavedKey::new(host_id) else {
        return;
    };
    for kind in SecretKind::ALL {
        if secrets.delete_saved(&key, kind).is_err() {
            log::warn!("could not delete the saved {kind} of host {host_id} from the keychain");
        }
    }
}

fn forget_saved_of(store: &ConfigStore, secrets: &SecretStore, host_id: &str) -> Res<()> {
    required("hostId", host_id)?;
    let config: ConfigFile = store.snapshot()?;
    resolve::locate(&config, host_id)?;
    let key = SavedKey::new(host_id)?;
    let _lifecycle = secrets.lifecycle();
    for kind in SecretKind::ALL {
        secrets.delete_saved(&key, kind)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn forget_saved_secrets(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    host_id: String,
) -> Res<()> {
    forget_saved_of(&store, &secrets, &host_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostInput;
    use crate::config::model::AuthMethod;
    use crate::secrets::MemoryBackend;

    #[test]
    fn typed_secret_is_validated_without_echoing_it() {
        let empty = check_secret(&SecretString::from("")).unwrap_err();
        assert_eq!(empty.code, "invalid_input");
        assert!(check_secret(&SecretString::from("a".repeat(MAX_SECRET_CHARS))).is_ok());
        let long = "é".repeat(MAX_SECRET_CHARS + 1);
        let err = check_secret(&SecretString::from(long)).unwrap_err();
        assert!(!err.message.contains('é'));
    }

    #[test]
    fn value_deserializes_into_a_redacted_secret() {
        let v: SecretString = serde_json::from_str("\"hunter2\"").unwrap();
        assert_eq!(v.expose_secret(), "hunter2");
        assert!(!format!("{v:?}").contains("hunter2"));
    }

    fn agent_host(store: &ConfigStore, project: Option<&str>, name: &str) -> String {
        store
            .create_host(
                project,
                None,
                &HostInput {
                    name: name.into(),
                    hostname: "a".into(),
                    port: "22".into(),
                    username: "u".into(),
                    auth: AuthMethod::Agent,
                },
            )
            .unwrap()
            .id
    }

    #[test]
    fn forget_saved_secrets_of_one_host() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let (secrets, mem) = MemoryBackend::store();
        let p = store.create_project("p").unwrap();
        let h = agent_host(&store, Some(&p.id), "h");
        let other = agent_host(&store, None, "home");
        let s = SecretString::from("x");
        for host in [&h, &other] {
            let key = SavedKey::new(host).unwrap();
            for kind in SecretKind::ALL {
                secrets.set_saved(&key, kind, "t", &s).unwrap();
            }
        }
        forget_saved_of(&store, &secrets, &h).unwrap();
        assert_eq!(
            mem.accounts(),
            vec![
                format!("conn/{other}/none/passphrase"),
                format!("conn/{other}/none/password"),
            ]
        );
        forget_saved_of(&store, &secrets, &other).unwrap();
        assert!(mem.accounts().is_empty());

        let code = |r: Res<()>| r.unwrap_err().code;
        assert_eq!(code(forget_saved_of(&store, &secrets, "nope")), "not_found");
        assert_eq!(
            code(forget_saved_of(&store, &secrets, " ")),
            "invalid_input"
        );
        mem.set_failing(true);
        assert_eq!(
            code(forget_saved_of(&store, &secrets, &h)),
            "keychain_unavailable"
        );
    }

    const P: &str = "00000000-0000-4000-8000-000000000001";
    const E: &str = "00000000-0000-4000-8000-000000000002";
    const D: &str = "00000000-0000-4000-8000-000000000003";
    const H: &str = "00000000-0000-4000-8000-000000000004";
    const HOME: &str = "00000000-0000-4000-8000-000000000005";

    fn var(name: &str, value: Option<&str>) -> serde_json::Value {
        match value {
            Some(v) => serde_json::json!({"name":name,"kind":"plain","value":v}),
            None => serde_json::json!({"name":name,"kind":"secret","value":null}),
        }
    }

    /// Writes a v3 file left by a build with environments: project `P` with `E` (prod) and `D`
    /// (dev), host `H` in `P`, host `HOME` at Home. Returns the raw file and the app's store.
    fn legacy_file(
        dir: &std::path::Path,
        secrets: &SecretStore,
        project: &[serde_json::Value],
        prod: &[serde_json::Value],
        active: Option<&str>,
    ) -> (String, ConfigStore) {
        let host = |id: &str, project: Option<&str>| {
            serde_json::json!({"kind":"host","id":id,"name":id,"projectId":project,"parentId":null,
                "hostname":"h","port":"22","username":"u","auth":{"kind":"agent"}})
        };
        let raw =
            serde_json::json!({"version":3,"projects":[{"id":P,"name":"P","variables":project,
            "environments":[{"id":E,"name":"prod","variables":prod},
                {"id":D,"name":"dev","variables":[var("pw", None)]}],
            "activeEnvironmentId":active}],
            "nodes":[host(H, Some(P)), host(HOME, None)]})
            .to_string();
        std::fs::write(dir.join("config.json"), &raw).unwrap();
        (raw, config_store(dir.to_path_buf(), secrets))
    }

    fn raw_file(dir: &std::path::Path) -> String {
        std::fs::read_to_string(dir.join("config.json")).unwrap()
    }

    #[test]
    fn active_environment_secrets_move_before_the_file_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let (_, store) = legacy_file(
            dir.path(),
            &secrets,
            &[var("pw", None), var("token", None), var("keep", None)],
            &[var("pw", None), var("token", Some("t")), var("unset", None)],
            Some(E),
        );
        for (account, value) in [
            (format!("var/project/{P}/pw"), "dev password"),
            (format!("var/project/{P}/token"), "old token"),
            (format!("var/project/{P}/keep"), "kept"),
            (format!("var/env/{E}/pw"), "prod password"),
            (format!("var/env/{D}/pw"), "dev env password"),
            (format!("conn/{H}/{E}/password"), "x"),
            (format!("conn/{H}/{D}/passphrase"), "x"),
            (format!("conn/{H}/none/password"), "saved"),
            (format!("conn/{HOME}/{E}/password"), "not a project host"),
        ] {
            mem.put_raw(&account, value);
        }
        let config = store.snapshot().unwrap();
        assert_eq!(
            mem.ops(),
            vec![
                format!("get var/env/{E}/pw"),
                format!("get var/env/{E}/unset"),
                format!("delete var/project/{P}/token"),
                format!("set var/project/{P}/pw"),
                format!("delete var/project/{P}/unset"),
            ],
            "reads, then deletes, then sets, all inside the load"
        );
        assert_eq!(
            mem.raw(&format!("var/project/{P}/pw")).as_deref(),
            Some("prod password")
        );
        let kinds: Vec<(&str, VariableKind)> = config.projects[0]
            .variables
            .iter()
            .map(|v| (v.name.as_str(), v.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("pw", VariableKind::Secret),
                ("token", VariableKind::Plain),
                ("keep", VariableKind::Secret),
                ("unset", VariableKind::Secret),
            ]
        );

        forget_legacy(&store, &secrets);
        assert_eq!(
            mem.accounts(),
            vec![
                format!("conn/{H}/none/password"),
                format!("conn/{HOME}/{E}/password"),
                format!("var/project/{P}/keep"),
                format!("var/project/{P}/pw"),
            ]
        );
        assert!(!mem.ops().iter().any(|o| o.contains(HOME)));
        forget_legacy(&store, &secrets);
        assert_eq!(mem.accounts().len(), 4);
    }

    #[test]
    fn moved_secret_lands_in_one_account_when_names_are_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        mem.set_case_insensitive(true);
        let (_, store) = legacy_file(
            dir.path(),
            &secrets,
            &[var("pw", None)],
            &[var("pw", None)],
            Some(E),
        );
        mem.put_raw(&format!("var/project/{P}/PW"), "dev password");
        mem.put_raw(&format!("var/env/{E}/pw"), "prod password");
        store.snapshot().unwrap();
        forget_legacy(&store, &secrets);
        assert_eq!(
            mem.raw(&format!("var/project/{P}/pw")).as_deref(),
            Some("prod password")
        );
        assert_eq!(
            mem.accounts(),
            vec![format!("var/project/{P}/pw").to_lowercase()]
        );
    }

    #[test]
    fn a_case_only_difference_is_refused_without_keychain_calls() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let (raw, store) = legacy_file(
            dir.path(),
            &secrets,
            &[var("PW", None)],
            &[var("pw", None)],
            Some(E),
        );
        let err = CommandError::from(store.snapshot().unwrap_err());
        assert_eq!(err.code, "corrupt_config");
        assert_eq!(raw_file(dir.path()), raw);
        assert!(mem.ops().is_empty());
    }

    #[test]
    fn a_failed_keychain_step_writes_nothing_and_the_next_load_retries() {
        let failing = [
            format!("get var/env/{E}/pw"),
            format!("delete var/project/{P}/token"),
            format!("set var/project/{P}/pw"),
        ];
        for op in failing {
            let dir = tempfile::tempdir().unwrap();
            let (secrets, mem) = MemoryBackend::store();
            let (raw, store) = legacy_file(
                dir.path(),
                &secrets,
                &[var("pw", None), var("token", None)],
                &[var("pw", None), var("token", Some("t"))],
                Some(E),
            );
            mem.put_raw(&format!("var/project/{P}/pw"), "dev password");
            mem.put_raw(&format!("var/project/{P}/token"), "old token");
            mem.put_raw(&format!("var/env/{E}/pw"), "prod password");
            mem.fail_on(std::slice::from_ref(&op));
            let err = CommandError::from(store.snapshot().unwrap_err());
            assert_eq!(err.code, "keychain_unavailable", "{op}");
            assert!(!err.message.contains("password"));
            assert_eq!(raw_file(dir.path()), raw, "{op}");
            forget_legacy(&store, &secrets);
            assert_eq!(
                mem.raw(&format!("var/env/{E}/pw")).as_deref(),
                Some("prod password"),
                "the environment value is kept for the retry"
            );

            mem.fail_on(&[]);
            store.snapshot().unwrap();
            assert_ne!(raw_file(dir.path()), raw);
            forget_legacy(&store, &secrets);
            assert_eq!(mem.accounts(), vec![format!("var/project/{P}/pw")], "{op}");
            assert_eq!(
                mem.raw(&format!("var/project/{P}/pw")).as_deref(),
                Some("prod password")
            );
        }
    }

    #[test]
    fn a_leftover_project_account_never_becomes_the_moved_secret() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let (_, store) = legacy_file(dir.path(), &secrets, &[], &[var("pw", None)], Some(E));
        mem.put_raw(&format!("var/project/{P}/pw"), "leftover");
        let cfg = store.snapshot().unwrap();
        assert_eq!(cfg.projects[0].variables[0].name, "pw");
        assert!(mem.raw(&format!("var/project/{P}/pw")).is_none());
    }

    #[test]
    fn an_old_file_restored_after_the_cleanup_loses_the_secret_instead_of_reverting_it() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let (raw, store) = legacy_file(dir.path(), &secrets, &[], &[var("pw", None)], Some(E));
        mem.put_raw(&format!("var/env/{E}/pw"), "prod password");
        store.snapshot().unwrap();
        forget_legacy(&store, &secrets);
        assert_eq!(
            mem.raw(&format!("var/project/{P}/pw")).as_deref(),
            Some("prod password")
        );
        std::fs::write(dir.path().join("config.json"), raw).unwrap();
        store.snapshot().unwrap();
        assert!(
            mem.accounts().is_empty(),
            "asked again, never a stale value"
        );
    }

    #[test]
    fn the_cleanup_waits_for_the_lifecycle_lock() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let (_, store) = legacy_file(dir.path(), &secrets, &[], &[var("x", Some("1"))], Some(E));
        mem.put_raw(&format!("var/env/{D}/pw"), "x");
        store.snapshot().unwrap();
        let held = secrets.lifecycle();
        std::thread::scope(|s| {
            let cleanup = s.spawn(|| forget_legacy(&store, &secrets));
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(!cleanup.is_finished());
            assert_eq!(mem.accounts().len(), 1);
            drop(held);
            cleanup.join().unwrap();
        });
        assert!(mem.accounts().is_empty());
    }

    #[test]
    fn without_an_active_environment_project_secrets_stay() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let (_, store) = legacy_file(
            dir.path(),
            &secrets,
            &[var("pw", None)],
            &[var("pw", None)],
            None,
        );
        mem.put_raw(&format!("var/project/{P}/pw"), "project");
        mem.put_raw(&format!("var/env/{E}/pw"), "env");
        store.snapshot().unwrap();
        forget_legacy(&store, &secrets);
        assert_eq!(mem.accounts(), vec![format!("var/project/{P}/pw")]);
        assert_eq!(
            mem.raw(&format!("var/project/{P}/pw")).as_deref(),
            Some("project")
        );
    }

    #[test]
    fn an_all_plain_migration_does_not_need_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let (raw, store) = legacy_file(
            dir.path(),
            &secrets,
            &[var("x", Some("1"))],
            &[var("x", Some("2"))],
            Some(E),
        );
        mem.set_failing(true);
        let cfg = store.snapshot().unwrap();
        assert_eq!(cfg.projects[0].variables[0].value.as_deref(), Some("2"));
        assert_ne!(raw_file(dir.path()), raw);
        forget_legacy(&store, &secrets);
        assert!(store.take_legacy_projects().is_empty());
    }

    #[test]
    fn a_file_replaced_at_runtime_is_migrated_by_the_next_command() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let store = config_store(dir.path().to_path_buf(), &secrets);
        store.create_project("Before").unwrap();
        legacy_file(dir.path(), &secrets, &[], &[var("pw", None)], Some(E));
        mem.put_raw(&format!("var/env/{E}/pw"), "prod password");
        store.create_project("After").unwrap();
        assert_eq!(
            mem.raw(&format!("var/project/{P}/pw")).as_deref(),
            Some("prod password")
        );
        let names: Vec<String> = store
            .snapshot()
            .unwrap()
            .projects
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["P", "After"]);
    }

    #[test]
    fn store_operations_take_the_lifecycle_lock_reentrantly() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, _) = MemoryBackend::store();
        let store = config_store(dir.path().to_path_buf(), &secrets);
        let held = secrets.lifecycle();
        store.create_project("same thread").unwrap();
        std::thread::scope(|s| {
            let other = s.spawn(|| store.create_project("other thread"));
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(!other.is_finished(), "waits for the lifecycle lock");
            drop(held);
            other.join().unwrap().unwrap();
        });
        assert_eq!(store.snapshot().unwrap().projects.len(), 2);
    }

    #[test]
    fn cleanup_is_bounded() {
        let (secrets, mem) = MemoryBackend::store();
        let hosts: Vec<String> = (0..4000)
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect();
        let envs: Vec<String> = (0..4).map(|_| uuid::Uuid::new_v4().to_string()).collect();
        let project = LegacyProject {
            project_id: P.into(),
            host_ids: hosts.clone(),
            environments: envs
                .iter()
                .map(|e| crate::config::LegacyEnvironment {
                    environment_id: e.clone(),
                    secret_variables: Vec::new(),
                })
                .collect(),
        };
        for e in &envs {
            mem.put_raw(&format!("conn/{}/{e}/password", hosts[0]), "x");
        }
        forget_environments(&secrets, &[project]);
        assert_eq!(mem.ops().len(), 16_000);
        assert!(mem.ops().len() <= MAX_LEGACY_ACCOUNTS);
        let mut left = vec![
            format!("conn/{}/{}/password", hosts[0], envs[2]),
            format!("conn/{}/{}/password", hosts[0], envs[3]),
        ];
        left.sort();
        assert_eq!(mem.accounts(), left);
    }

    #[test]
    fn failed_legacy_cleanup_is_only_logged() {
        let dir = tempfile::tempdir().unwrap();
        let (secrets, mem) = MemoryBackend::store();
        let (_, store) = legacy_file(dir.path(), &secrets, &[], &[var("x", Some("1"))], Some(E));
        store.snapshot().unwrap();
        mem.set_failing(true);
        forget_legacy(&store, &secrets);
        assert!(store.take_legacy_projects().is_empty());
    }
}
