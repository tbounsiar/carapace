use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use super::error::CommandError;
use crate::config::{ConfigStore, Host};
use crate::ssh::{ConnectEvent, ConnectionInfo, SshError, SshManager};

type Res<T> = Result<T, CommandError>;

fn resolve_host(store: &ConfigStore, host_id: &str) -> Res<Host> {
    if host_id.trim().is_empty() {
        return Err(SshError::InvalidInput("hostId is required".into()).into());
    }
    store
        .list_projects()?
        .into_iter()
        .flat_map(|p| p.environments)
        .flat_map(|e| e.hosts)
        .find(|h| h.id == host_id)
        .ok_or_else(|| SshError::NotFound("host").into())
}

#[tauri::command]
pub async fn connect_host(
    store: State<'_, ConfigStore>,
    ssh: State<'_, SshManager>,
    host_id: String,
    on_event: Channel<ConnectEvent>,
) -> Res<ConnectionInfo> {
    let host = resolve_host(&store, &host_id)?;
    let emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    Ok(ssh.connect(&host, emit).await?)
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

    #[test]
    fn resolve_host_finds_and_rejects() {
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
        assert_eq!(resolve_host(&store, &h.id).unwrap().hostname, "web.example");
        assert_eq!(resolve_host(&store, "nope").unwrap_err().code, "not_found");
        assert_eq!(resolve_host(&store, " ").unwrap_err().code, "invalid_input");
    }
}
