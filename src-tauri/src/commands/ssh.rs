use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use super::error::CommandError;
use super::resolve::{self, required};
use super::secrets::check_secret;
use crate::config::{ConfigStore, HostInput};
use crate::ssh::{
    ConnectEvent, ConnectionInfo, Credential, Emit, HostTestResult, SshManager, TestTicket,
};

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
    let emit: Emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    let current = || resolve::target(&store, &host_id).is_ok_and(|now| now == target);
    Ok(ssh.connect(&target, credential, &current, emit).await?)
}

const MAX_TEST_ID_CHARS: usize = 128;

fn check_test_id(test_id: &str) -> Res<()> {
    required("testId", test_id)?;
    if test_id.chars().count() > MAX_TEST_ID_CHARS {
        return Err(CommandError::new(
            "invalid_input",
            format!("testId is longer than {MAX_TEST_ID_CHARS} characters"),
        ));
    }
    Ok(())
}

fn optional<'a>(name: &str, value: &'a Option<String>) -> Res<Option<&'a str>> {
    match value.as_deref() {
        Some(v) => required(name, v).map(|()| Some(v)),
        None => Ok(None),
    }
}

/// Tests the host form as typed (`host`, in the scope `projectId`), not the saved host:
/// handshake, host key check, authentication, then disconnect. `hostId` (the host being
/// edited) makes its saved connection secret a candidate. A typed credential is never stored.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn test_host(
    store: State<'_, ConfigStore>,
    ssh: State<'_, SshManager>,
    host: HostInput,
    project_id: Option<String>,
    host_id: Option<String>,
    test_id: String,
    on_event: Channel<ConnectEvent>,
    credential: Option<Credential>,
) -> Res<HostTestResult> {
    let emit: Emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    run_test(
        &store,
        &ssh,
        &host,
        &project_id,
        &host_id,
        &test_id,
        emit,
        credential,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_test(
    store: &ConfigStore,
    ssh: &SshManager,
    host: &HostInput,
    project_id: &Option<String>,
    host_id: &Option<String>,
    test_id: &str,
    emit: Emit,
    credential: Option<Credential>,
) -> Res<HostTestResult> {
    check_test_id(test_id)?;
    // Registered first, so a cancel sent while the draft is resolved is not lost.
    let ticket = ssh.start_test(test_id)?;
    test_with(
        ticket, store, ssh, host, project_id, host_id, emit, credential,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn test_with(
    ticket: TestTicket<'_>,
    store: &ConfigStore,
    ssh: &SshManager,
    host: &HostInput,
    project_id: &Option<String>,
    host_id: &Option<String>,
    emit: Emit,
    credential: Option<Credential>,
) -> Res<HostTestResult> {
    if let Some(c) = &credential {
        check_secret(&c.secret)?;
    }
    let project_id = optional("projectId", project_id)?;
    let host_id = optional("hostId", host_id)?;
    let target = resolve::draft_target(store, host, project_id, host_id)?;
    Ok(ssh.probe(ticket, &target, credential, emit).await?)
}

#[tauri::command]
pub async fn cancel_host_test(ssh: State<'_, SshManager>, test_id: String) -> Res<()> {
    check_test_id(&test_id)?;
    Ok(ssh.cancel_test(&test_id)?)
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
