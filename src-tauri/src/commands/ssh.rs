use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use super::error::CommandError;
use super::secrets::{check_secret, locate_host, still_current};
use crate::config::ConfigStore;
use crate::ssh::{ConnectEvent, ConnectionInfo, Credential, SshError, SshManager};

type Res<T> = Result<T, CommandError>;

#[tauri::command]
pub async fn connect_host(
    store: State<'_, ConfigStore>,
    ssh: State<'_, SshManager>,
    host_id: String,
    on_event: Channel<ConnectEvent>,
    credential: Option<Credential>,
) -> Res<ConnectionInfo> {
    let (scope, host) = locate_host(&store, &host_id)?;
    if let Some(c) = &credential {
        check_secret(&c.secret)?;
    }
    let emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    let current = || still_current(&store, &host_id, &scope, &host);
    Ok(ssh
        .connect(&scope, &host, credential, &current, emit)
        .await?)
}

#[tauri::command]
pub async fn answer_host_key(
    ssh: State<'_, SshManager>,
    request_id: String,
    accept: bool,
) -> Res<()> {
    if request_id.trim().is_empty() {
        return Err(SshError::InvalidInput("requestId is required".into()).into());
    }
    Ok(ssh.answer_host_key(&request_id, accept)?)
}

#[tauri::command]
pub async fn replace_host_key(
    ssh: State<'_, SshManager>,
    host_id: String,
    fingerprint: String,
) -> Res<()> {
    if host_id.trim().is_empty() || fingerprint.trim().is_empty() {
        return Err(SshError::InvalidInput("hostId and fingerprint are required".into()).into());
    }
    Ok(ssh.replace_host_key(&host_id, &fingerprint)?)
}

#[tauri::command]
pub async fn disconnect_host(ssh: State<'_, SshManager>, host_id: String) -> Res<()> {
    if host_id.trim().is_empty() {
        return Err(SshError::InvalidInput("hostId is required".into()).into());
    }
    Ok(ssh.disconnect(&host_id).await?)
}

#[tauri::command]
pub async fn list_connections(ssh: State<'_, SshManager>) -> Res<Vec<ConnectionInfo>> {
    Ok(ssh.list().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostInput;
    use crate::config::model::AuthMethod;
    use crate::secrets::SecretScope;

    #[test]
    fn locate_host_finds_scope_and_rejects() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let p = store.create_project("p").unwrap();
        let e = store.create_environment(&p.id, "dev").unwrap();
        let h = store
            .create_host(
                &p.id,
                &e.id,
                &HostInput {
                    name: "web".into(),
                    hostname: "web.example".into(),
                    port: 22,
                    username: "me".into(),
                    auth: AuthMethod::Agent,
                },
            )
            .unwrap();
        let (scope, host) = locate_host(&store, &h.id).unwrap();
        assert_eq!(host.hostname, "web.example");
        assert_eq!(scope, SecretScope::new(&p.id, &e.id, &h.id).unwrap());
        assert!(still_current(&store, &h.id, &scope, &host));

        let mut moved = host.clone();
        moved.port = 2200;
        assert!(!still_current(&store, &h.id, &scope, &moved));
        let mut other_auth = host.clone();
        other_auth.auth = AuthMethod::Password;
        assert!(!still_current(&store, &h.id, &scope, &other_auth));
        store.delete_host(&p.id, &e.id, &h.id).unwrap();
        assert!(!still_current(&store, &h.id, &scope, &host));
        assert_eq!(locate_host(&store, "nope").unwrap_err().code, "not_found");
        assert_eq!(locate_host(&store, " ").unwrap_err().code, "invalid_input");
    }

    #[test]
    fn credential_deserializes_with_optional_remember_and_redacted_debug() {
        let c: Credential = serde_json::from_str(r#"{"secret":"hunter2"}"#).unwrap();
        assert!(!c.remember);
        assert!(!format!("{c:?}").contains("hunter2"));
        let c: Credential =
            serde_json::from_str(r#"{"secret":"hunter2","remember":true}"#).unwrap();
        assert!(c.remember);
        let none: Option<Credential> = serde_json::from_str("null").unwrap();
        assert!(none.is_none());
    }
}
