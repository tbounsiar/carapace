use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use super::error::CommandError;
use super::resolve::{self, required};
use super::secrets::check_secret;
use crate::config::ConfigStore;
use crate::ssh::{ConnectEvent, ConnectionInfo, Credential, SshManager};

type Res<T> = Result<T, CommandError>;

/// Connects `hostId` resolved with the global and project variables; the connection id is the
/// host id.
#[tauri::command]
pub async fn connect_host(
    store: State<'_, ConfigStore>,
    ssh: State<'_, SshManager>,
    host_id: String,
    on_event: Channel<ConnectEvent>,
    credential: Option<Credential>,
) -> Res<ConnectionInfo> {
    if let Some(c) = &credential {
        check_secret(&c.secret)?;
    }
    let target = resolve::target(&store, &host_id)?;
    let emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    let current = || resolve::target(&store, &host_id).is_ok_and(|now| now == target);
    Ok(ssh.connect(&target, credential, &current, emit).await?)
}

#[tauri::command]
pub async fn answer_host_key(
    ssh: State<'_, SshManager>,
    request_id: String,
    accept: bool,
) -> Res<()> {
    required("requestId", &request_id)?;
    Ok(ssh.answer_host_key(&request_id, accept)?)
}

#[tauri::command]
pub async fn replace_host_key(
    ssh: State<'_, SshManager>,
    connection_id: String,
    fingerprint: String,
) -> Res<()> {
    required("connectionId", &connection_id)?;
    required("fingerprint", &fingerprint)?;
    Ok(ssh.replace_host_key(&connection_id, &fingerprint)?)
}

#[tauri::command]
pub async fn disconnect_host(ssh: State<'_, SshManager>, connection_id: String) -> Res<()> {
    required("connectionId", &connection_id)?;
    Ok(ssh.disconnect(&connection_id).await?)
}

/// Closes the open connections of these hosts. Closing a connection ends its terminals, SFTP
/// channel and transfers. Failures are logged by connection id only.
pub(super) async fn close_hosts(ssh: &SshManager, host_ids: &[String]) {
    if host_ids.is_empty() {
        return;
    }
    for c in ssh.list().await {
        if host_ids.contains(&c.host_id) && ssh.disconnect(&c.connection_id).await.is_err() {
            log::warn!("could not close connection {}", c.connection_id);
        }
    }
}

#[tauri::command]
pub async fn list_connections(ssh: State<'_, SshManager>) -> Res<Vec<ConnectionInfo>> {
    Ok(ssh.list().await)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod e2e_tests;
