use secrecy::{ExposeSecret, SecretString};
use tauri::State;

use super::error::CommandError;
use crate::config::model::AuthMethod;
use crate::config::{ConfigStore, Host};
use crate::secrets::{SecretKind, SecretScope, SecretStore, fits_keychain};

type Res<T> = Result<T, CommandError>;

/// Upper bound for a typed one-shot credential; storing one is further limited by `fits_keychain`.
const MAX_SECRET_CHARS: usize = 4096;

fn invalid(message: &str) -> CommandError {
    CommandError::new("invalid_input", message)
}

pub(super) fn locate_host(store: &ConfigStore, host_id: &str) -> Res<(SecretScope, Host)> {
    if host_id.trim().is_empty() {
        return Err(invalid("hostId is required"));
    }
    for project in store.list_projects()? {
        for env in project.environments {
            if let Some(host) = env.hosts.into_iter().find(|h| h.id == host_id) {
                return Ok((SecretScope::new(&project.id, &env.id, &host.id)?, host));
            }
        }
    }
    Err(CommandError::new("not_found", "host not found"))
}

fn parse_kind(kind: &str) -> Res<SecretKind> {
    SecretKind::parse(kind).ok_or_else(|| invalid("kind must be \"password\" or \"passphrase\""))
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

/// Same remote account: a stored password is only valid for this triple.
pub(super) fn same_endpoint(a: &Host, b: &Host) -> bool {
    a.hostname == b.hostname && a.port == b.port && a.username == b.username
}

/// True if `host_id` still resolves to `scope` with the same endpoint and authentication as `host`.
pub(super) fn still_current(
    store: &ConfigStore,
    host_id: &str,
    scope: &SecretScope,
    host: &Host,
) -> bool {
    matches!(
        locate_host(store, host_id),
        Ok((s, h)) if s == *scope && same_endpoint(&h, host) && h.auth == host.auth
    )
}

fn kind_fits_auth(kind: SecretKind, auth: &AuthMethod) -> bool {
    matches!(
        (kind, auth),
        (SecretKind::Password, AuthMethod::Password)
            | (SecretKind::Passphrase, AuthMethod::Key { .. })
    )
}

fn set_secret(
    store: &ConfigStore,
    secrets: &SecretStore,
    host_id: &str,
    kind: &str,
    value: &SecretString,
) -> Res<()> {
    let kind = parse_kind(kind)?;
    check_secret(value)?;
    if !fits_keychain(value) {
        return Err(invalid("the secret is too long for the system keychain"));
    }
    let (scope, host) = locate_host(store, host_id)?;
    if !kind_fits_auth(kind, &host.auth) {
        return Err(invalid(
            "this kind of secret does not match the host authentication",
        ));
    }
    Ok(secrets.set(&scope, kind, value)?)
}

fn delete_secret(store: &ConfigStore, secrets: &SecretStore, host_id: &str, kind: &str) -> Res<()> {
    let kind = parse_kind(kind)?;
    let (scope, _) = locate_host(store, host_id)?;
    Ok(secrets.delete(&scope, kind)?)
}

fn has_secret(store: &ConfigStore, secrets: &SecretStore, host_id: &str, kind: &str) -> Res<bool> {
    let kind = parse_kind(kind)?;
    let (scope, _) = locate_host(store, host_id)?;
    Ok(secrets.has(&scope, kind)?)
}

/// Best effort: a keychain failure must not undo a config change that already happened.
pub(super) fn forget(secrets: &SecretStore, scope: &SecretScope, kinds: &[SecretKind]) {
    for &kind in kinds {
        if secrets.delete(scope, kind).is_err() {
            log::warn!(
                "could not delete the {kind} of host {} from the keychain",
                scope.host_id()
            );
        }
    }
}

#[tauri::command]
pub async fn set_host_secret(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    host_id: String,
    kind: String,
    value: SecretString,
) -> Res<()> {
    set_secret(&store, &secrets, &host_id, &kind, &value)
}

#[tauri::command]
pub async fn delete_host_secret(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    host_id: String,
    kind: String,
) -> Res<()> {
    delete_secret(&store, &secrets, &host_id, &kind)
}

#[tauri::command]
pub async fn has_host_secret(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    host_id: String,
    kind: String,
) -> Res<bool> {
    has_secret(&store, &secrets, &host_id, &kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostInput;
    use crate::secrets::{MAX_SECRET_UTF16_UNITS, MemoryBackend};

    struct Fixture {
        _dir: tempfile::TempDir,
        store: ConfigStore,
        secrets: SecretStore,
        mem: std::sync::Arc<MemoryBackend>,
        password_host: String,
        key_host: String,
        agent_host: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let p = store.create_project("p").unwrap();
        let e = store.create_environment(&p.id, "dev").unwrap();
        let host = |name: &str, auth: AuthMethod| {
            store
                .create_host(
                    &p.id,
                    &e.id,
                    &HostInput {
                        name: name.into(),
                        hostname: "web.example".into(),
                        port: 22,
                        username: "me".into(),
                        auth,
                    },
                )
                .unwrap()
                .id
        };
        let password_host = host("pw", AuthMethod::Password);
        let key_host = host(
            "key",
            AuthMethod::Key {
                key_path: "~/.ssh/id_ed25519".into(),
            },
        );
        let agent_host = host("agent", AuthMethod::Agent);
        let (secrets, mem) = MemoryBackend::store();
        Fixture {
            _dir: dir,
            store,
            secrets,
            mem,
            password_host,
            key_host,
            agent_host,
        }
    }

    fn secret(s: &str) -> SecretString {
        SecretString::from(s)
    }

    #[test]
    fn set_has_delete_for_matching_kinds() {
        let f = fixture();
        let (s, st) = (&f.secrets, &f.store);
        assert!(!has_secret(st, s, &f.password_host, "password").unwrap());
        set_secret(st, s, &f.password_host, "password", &secret("pw")).unwrap();
        set_secret(st, s, &f.key_host, "passphrase", &secret("pp")).unwrap();
        assert!(has_secret(st, s, &f.password_host, "password").unwrap());
        assert!(has_secret(st, s, &f.key_host, "passphrase").unwrap());
        assert!(!has_secret(st, s, &f.key_host, "password").unwrap());
        assert_eq!(f.mem.accounts().len(), 2);
        let (scope, _) = locate_host(st, &f.key_host).unwrap();
        assert!(
            f.mem
                .accounts()
                .contains(&scope.account(SecretKind::Passphrase))
        );
        delete_secret(st, s, &f.password_host, "password").unwrap();
        delete_secret(st, s, &f.password_host, "password").unwrap();
        assert!(!has_secret(st, s, &f.password_host, "password").unwrap());
    }

    #[test]
    fn rejects_mismatched_kind_unknown_kind_and_unknown_host() {
        let f = fixture();
        let (s, st) = (&f.secrets, &f.store);
        let code = |r: Res<()>| r.unwrap_err().code;
        assert_eq!(
            code(set_secret(
                st,
                s,
                &f.password_host,
                "passphrase",
                &secret("x")
            )),
            "invalid_input"
        );
        assert_eq!(
            code(set_secret(st, s, &f.key_host, "password", &secret("x"))),
            "invalid_input"
        );
        assert_eq!(
            code(set_secret(st, s, &f.agent_host, "password", &secret("x"))),
            "invalid_input"
        );
        assert_eq!(
            code(set_secret(st, s, &f.agent_host, "passphrase", &secret("x"))),
            "invalid_input"
        );
        assert_eq!(
            code(set_secret(st, s, &f.password_host, "token", &secret("x"))),
            "invalid_input"
        );
        assert_eq!(
            code(set_secret(st, s, "nope", "password", &secret("x"))),
            "not_found"
        );
        assert_eq!(
            code(set_secret(st, s, " ", "password", &secret("x"))),
            "invalid_input"
        );
        assert_eq!(code(delete_secret(st, s, "nope", "password")), "not_found");
        assert_eq!(
            has_secret(st, s, &f.key_host, "other").unwrap_err().code,
            "invalid_input"
        );
        assert!(f.mem.accounts().is_empty());
    }

    #[test]
    fn validates_value_without_echoing_it() {
        let f = fixture();
        let (s, st) = (&f.secrets, &f.store);
        let empty = set_secret(st, s, &f.password_host, "password", &secret("")).unwrap_err();
        assert_eq!(empty.code, "invalid_input");
        let long = "é".repeat(MAX_SECRET_UTF16_UNITS + 1);
        let err = set_secret(st, s, &f.password_host, "password", &secret(&long)).unwrap_err();
        assert_eq!(err.code, "invalid_input");
        assert!(!err.message.contains('é'));
        let max = "é".repeat(MAX_SECRET_UTF16_UNITS);
        set_secret(st, s, &f.password_host, "password", &secret(&max)).unwrap();
        assert!(check_secret(&secret(&"a".repeat(MAX_SECRET_CHARS))).is_ok());
        assert!(check_secret(&secret(&"a".repeat(MAX_SECRET_CHARS + 1))).is_err());
    }

    #[test]
    fn keychain_failure_maps_to_keychain_unavailable() {
        let f = fixture();
        f.mem.set_failing(true);
        let err = set_secret(
            &f.store,
            &f.secrets,
            &f.password_host,
            "password",
            &secret("hunter2"),
        )
        .unwrap_err();
        assert_eq!(err.code, "keychain_unavailable");
        assert!(!err.message.contains("hunter2"));
        assert_eq!(
            has_secret(&f.store, &f.secrets, &f.password_host, "password")
                .unwrap_err()
                .code,
            "keychain_unavailable"
        );
    }

    #[test]
    fn value_deserializes_into_a_redacted_secret() {
        let v: SecretString = serde_json::from_str("\"hunter2\"").unwrap();
        assert_eq!(v.expose_secret(), "hunter2");
        assert!(!format!("{v:?}").contains("hunter2"));
    }
}
