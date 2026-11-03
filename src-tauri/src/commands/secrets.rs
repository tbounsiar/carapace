use secrecy::{ExposeSecret, SecretString};
use tauri::State;

use super::error::CommandError;
use super::resolve::{self, required};
use crate::config::{ConfigFile, ConfigStore, Variable, VariableKind};
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

/// Deletes the iteration-2 keychain entries of hosts whose version 1 config was moved aside.
/// Best effort, logged by host id only.
pub fn forget_legacy(store: &ConfigStore, secrets: &SecretStore) {
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

/// Deletes the saved connection secrets of `host_id` for each environment (None: no environment).
pub(super) fn forget_saved(secrets: &SecretStore, host_id: &str, environments: &[Option<&str>]) {
    for env in environments {
        // A non-UUID id can never have a keychain entry.
        let Ok(key) = SavedKey::new(host_id, *env) else {
            continue;
        };
        for kind in SecretKind::ALL {
            if secrets.delete_saved(&key, kind).is_err() {
                log::warn!("could not delete the saved {kind} of host {host_id} from the keychain");
            }
        }
    }
}

fn forget_saved_of(
    store: &ConfigStore,
    secrets: &SecretStore,
    host_id: &str,
    environment_id: Option<&str>,
) -> Res<()> {
    required("hostId", host_id)?;
    let config: ConfigFile = store.snapshot()?;
    resolve::locate(&config, host_id, environment_id)?;
    let key = SavedKey::new(host_id, environment_id)?;
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
    environment_id: Option<String>,
) -> Res<()> {
    forget_saved_of(&store, &secrets, &host_id, environment_id.as_deref())
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

    #[test]
    fn forget_saved_secrets_of_one_connection() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let (secrets, mem) = MemoryBackend::store();
        let p = store.create_project("p").unwrap();
        let e = store.create_environment(&p.id, "dev").unwrap();
        let other = store.create_project("q").unwrap();
        let other_env = store.create_environment(&other.id, "dev").unwrap();
        let h = store
            .create_host(
                Some(&p.id),
                None,
                &HostInput {
                    name: "h".into(),
                    hostname: "a".into(),
                    port: "22".into(),
                    username: "u".into(),
                    auth: AuthMethod::Password { password: None },
                },
            )
            .unwrap();
        let s = SecretString::from("x");
        for env in [None, Some(e.id.as_str())] {
            let key = SavedKey::new(&h.id, env).unwrap();
            for kind in SecretKind::ALL {
                secrets.set_saved(&key, kind, "t", &s).unwrap();
            }
        }
        forget_saved_of(&store, &secrets, &h.id, Some(&e.id)).unwrap();
        assert_eq!(mem.accounts().len(), 2);
        assert!(mem.accounts().iter().all(|a| a.contains("/none/")));
        forget_saved_of(&store, &secrets, &h.id, None).unwrap();
        assert!(mem.accounts().is_empty());

        let code = |r: Res<()>| r.unwrap_err().code;
        assert_eq!(
            code(forget_saved_of(&store, &secrets, "nope", None)),
            "not_found"
        );
        assert_eq!(
            code(forget_saved_of(&store, &secrets, " ", None)),
            "invalid_input"
        );
        assert_eq!(
            code(forget_saved_of(
                &store,
                &secrets,
                &h.id,
                Some(&other_env.id)
            )),
            "invalid_input"
        );
        let home = store
            .create_host(
                None,
                None,
                &HostInput {
                    name: "home".into(),
                    hostname: "a".into(),
                    port: "22".into(),
                    username: "u".into(),
                    auth: AuthMethod::Agent,
                },
            )
            .unwrap();
        assert_eq!(
            code(forget_saved_of(&store, &secrets, &home.id, Some(&e.id))),
            "invalid_input"
        );
        forget_saved_of(&store, &secrets, &home.id, None).unwrap();
        mem.set_failing(true);
        assert_eq!(
            code(forget_saved_of(&store, &secrets, &h.id, None)),
            "keychain_unavailable"
        );
    }
}
