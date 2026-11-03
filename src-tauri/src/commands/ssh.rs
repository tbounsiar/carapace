use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use super::analytics::auth_of;
use super::error::CommandError;
use super::resolve::{self, required};
use super::secrets::check_secret;
use crate::analytics::{Analytics, Attempt, Auth, ErrorCode, Event, TestResult, Took};
use crate::config::{ConfigStore, HostInput};
use crate::ssh::{
    ConnectEvent, Connected, ConnectionInfo, Credential, Emit, HostTestResult, SshManager,
    TestTicket,
};

type Res<T> = Result<T, CommandError>;

/// Connects `hostId` resolved with the global and project variables; the connection id is the
/// host id.
#[tauri::command]
pub async fn connect_host(
    store: State<'_, ConfigStore>,
    ssh: State<'_, SshManager>,
    analytics: State<'_, Analytics>,
    host_id: String,
    on_event: Channel<ConnectEvent>,
    credential: Option<Credential>,
) -> Res<ConnectionInfo> {
    let emit: Emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    connect_in(&store, &ssh, &analytics, &host_id, credential, emit).await
}

/// The codes after which the frontend asks for a secret and calls again with it; `typed`:
/// a refused secret is asked again only when it was typed.
fn prompts_again(auth: Auth, code: ErrorCode, typed: bool) -> bool {
    match (auth, code) {
        (Auth::Agent, _) => false,
        (_, ErrorCode::SecretRequired) => true,
        (Auth::Password, ErrorCode::AuthFailed) | (Auth::Key, ErrorCode::InvalidPassphrase) => {
            typed
        }
        _ => false,
    }
}

pub(super) async fn connect_in(
    store: &ConfigStore,
    ssh: &SshManager,
    analytics: &Analytics,
    host_id: &str,
    credential: Option<Credential>,
    emit: Emit,
) -> Res<ConnectionInfo> {
    let observed = analytics
        .collecting()
        .then(|| store.snapshot().ok())
        .flatten()
        .and_then(|cfg| cfg.host(host_id).map(|h| auth_of(&h.auth)));
    let attempt = Attempt::Connect(host_id.to_owned());
    let typed = credential.is_some();
    if observed.is_some() {
        analytics.attempt_started(&attempt, typed);
    }
    let result = connect_with(store, ssh, host_id, credential, emit).await;
    let Some(auth) = observed else {
        return result.map(|c| c.info);
    };
    match &result {
        Ok(Connected {
            info,
            opened: Some(took),
        }) => {
            analytics.connection_opened(&info.connection_id);
            analytics.attempt_done(
                &attempt,
                Some(Event::ConnectSucceeded {
                    auth,
                    duration: Took::of(*took),
                }),
            );
        }
        Ok(_) => analytics.attempt_done(&attempt, None),
        Err(e) => {
            let code = ErrorCode::from_code(e.code);
            let failed = Event::ConnectFailed { auth, code };
            // The connector asks again even when the refused secret was a stored one.
            if prompts_again(auth, code, true) {
                analytics.attempt_pending(attempt, failed);
            } else {
                analytics.attempt_done(&attempt, Some(failed));
            }
        }
    }
    result.map(|c| c.info)
}

async fn connect_with(
    store: &ConfigStore,
    ssh: &SshManager,
    host_id: &str,
    credential: Option<Credential>,
    emit: Emit,
) -> Res<Connected> {
    if let Some(c) = &credential {
        check_secret(&c.secret)?;
    }
    let target = resolve::target(store, host_id)?;
    let current = || resolve::target(store, host_id).is_ok_and(|now| now == target);
    Ok(ssh
        .connect_timed(&target, credential, &current, emit)
        .await?)
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
    analytics: State<'_, Analytics>,
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
    test_observed(
        &store,
        &ssh,
        &analytics,
        &host,
        &project_id,
        &host_id,
        &test_id,
        emit,
        credential,
    )
    .await
}

fn test_attempt(store: &ConfigStore, host_id: &Option<String>) -> Option<Attempt> {
    match host_id.as_deref() {
        None => Some(Attempt::Test(String::new())),
        Some(id) if !id.trim().is_empty() && id.len() <= MAX_TEST_ID_CHARS => store
            .snapshot()
            .ok()
            .filter(|cfg| cfg.host(id).is_some())
            .map(|_| Attempt::Test(id.to_owned())),
        Some(_) => None,
    }
}

/// One run of the host dialog's test may span several calls (typed secret retries); it is
/// keyed by the edited host, or by the draft when the host is new.
#[allow(clippy::too_many_arguments)]
pub(super) async fn test_observed(
    store: &ConfigStore,
    ssh: &SshManager,
    analytics: &Analytics,
    host: &HostInput,
    project_id: &Option<String>,
    host_id: &Option<String>,
    test_id: &str,
    emit: Emit,
    credential: Option<Credential>,
) -> Res<HostTestResult> {
    let collecting = analytics.collecting();
    // Held only under an id that names a saved host: the webview cannot grow the map with
    // made-up keys.
    let attempt = collecting.then(|| test_attempt(store, host_id)).flatten();
    let typed = credential.is_some();
    if let Some(a) = &attempt {
        analytics.attempt_started(a, typed);
    }
    let result = run_test(
        store, ssh, host, project_id, host_id, test_id, emit, credential,
    )
    .await;
    if !collecting {
        return result;
    }
    let done = |event| match &attempt {
        Some(a) => analytics.attempt_done(a, Some(event)),
        None => analytics.record(event),
    };
    match &result {
        Ok(_) => done(Event::test_ended(TestResult::Success)),
        Err(e) => match ErrorCode::from_code(e.code) {
            ErrorCode::Cancelled => done(Event::test_ended(TestResult::Cancelled)),
            // The dialog shows a prompt the user closed as cancelled.
            code if attempt.is_some() && prompts_again(auth_of(&host.auth), code, typed) => {
                if let Some(a) = attempt.clone() {
                    analytics.attempt_pending(a, Event::test_ended(TestResult::Cancelled));
                }
            }
            code => done(Event::test_failed(code)),
        },
    }
    result
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
