//! Extra connections: when a server refuses another session channel on a connection (OpenSSH
//! `MaxSessions` counts every channel), the channel is opened on another connection to the same
//! host. They belong to the primary connection id and are never listed as connections.

use std::sync::{Arc, Weak};
use std::time::Duration;

use russh::client::Msg;
use russh::{Channel, ChannelOpenFailure};
use tokio::sync::{oneshot, watch};
use tokio::time::timeout;

use super::{
    Emit, EndSignal, Mode, Opened, Purpose, Session, SessionEnd, SessionRef, SshError, SshManager,
    load_blocking, mark_ended,
};

const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// Extra connections at once per connection id; with OpenSSH's default `MaxSessions` (10)
/// that is room for every terminal allowed on a connection.
pub const MAX_EXTRAS: usize = 4;

/// Why a session channel could not be opened.
#[derive(Debug, PartialEq)]
pub enum ChannelError {
    NotConnected,
    /// The server refused it for lack of sessions and no extra connection could take it.
    Refused,
    /// The server refused it for another reason (no session channels for this account, an
    /// unknown code): another connection would not help.
    Rejected,
    Timeout,
    Network,
    /// An extra connection was needed and could not be made.
    Connect(SshError),
}

impl ChannelError {
    fn code(&self) -> &'static str {
        match self {
            Self::NotConnected => "not_connected",
            Self::Refused => "channel_refused",
            Self::Rejected => "channel_rejected",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Connect(e) => e.code(),
        }
    }
}

/// An extra connection. Dropping the last lease of it closes it.
pub(super) struct Extra {
    handle: Session,
    ended: EndSignal,
    /// russh keeps a session running (keepalives) after every `Handle` is dropped, so the
    /// disconnect is always spawned, on the runtime the extra was opened on.
    runtime: tokio::runtime::Handle,
    /// Dropped with the extra, which ends its watcher task.
    _alive: oneshot::Sender<()>,
}

impl Drop for Extra {
    fn drop(&mut self) {
        mark_ended(&self.ended, SessionEnd::Disconnected);
        let handle = self.handle.clone();
        self.runtime.spawn(async move {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        });
    }
}

impl Extra {
    fn is_live(&self) -> bool {
        !self.handle.is_closed() && self.ended.borrow().is_none()
    }
}

/// Keeps an extra connection open; held by the terminal or SFTP channel opened on it.
#[derive(Clone)]
pub struct Lease {
    _extra: Arc<Extra>,
}

enum Attempt {
    Refused(ChannelOpenFailure),
    Failed(ChannelError),
}

fn gone(session: &SessionRef) -> bool {
    session.handle.is_closed() || session.ended.borrow().is_some()
}

/// A fixed name for the log: the `Display` of a russh error can carry text the peer sent.
fn error_kind(e: &russh::Error) -> &'static str {
    match e {
        russh::Error::Disconnect => "disconnect",
        russh::Error::HUP => "hup",
        russh::Error::SendError => "send_error",
        russh::Error::IO(_) => "io",
        russh::Error::ConnectionTimeout => "connection_timeout",
        russh::Error::KeepaliveTimeout => "keepalive_timeout",
        russh::Error::InactivityTimeout => "inactivity_timeout",
        russh::Error::WrongChannel => "wrong_channel",
        _ => "other",
    }
}

async fn try_open(session: &SessionRef, connection_id: &str) -> Result<Channel<Msg>, Attempt> {
    match timeout(OPEN_TIMEOUT, session.handle.channel_open_session()).await {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(russh::Error::ChannelOpenFailure(reason))) => Err(Attempt::Refused(reason)),
        Ok(Err(e)) => {
            log::warn!(
                "connection {connection_id}: opening a session channel failed ({})",
                error_kind(&e)
            );
            Err(Attempt::Failed(if gone(session) {
                ChannelError::NotConnected
            } else {
                ChannelError::Network
            }))
        }
        Err(_) => {
            log::warn!("connection {connection_id}: opening a session channel timed out");
            Err(Attempt::Failed(if gone(session) {
                ChannelError::NotConnected
            } else {
                ChannelError::Timeout
            }))
        }
    }
}

fn refused(connection_id: &str, reason: &ChannelOpenFailure, on: &str) {
    log::warn!(
        "connection {connection_id}: the server refused a session channel on {on} (reason code {})",
        reason.code()
    );
}

/// OpenSSH refuses a session over `MaxSessions` with `ConnectFailed` (the default reason of
/// `server_input_channel_open`, checked against the e2e sshd); russh-based servers default to
/// `AdministrativelyProhibited`; Dropbear sends `ResourceShortage` when its channel table is
/// full. `UnknownChannelType` and unknown codes are not about the number of sessions.
fn for_lack_of_sessions(reason: &ChannelOpenFailure) -> bool {
    matches!(
        reason,
        ChannelOpenFailure::ConnectFailed
            | ChannelOpenFailure::AdministrativelyProhibited
            | ChannelOpenFailure::ResourceShortage
    )
}

fn refusal(reason: &ChannelOpenFailure) -> ChannelError {
    if for_lack_of_sessions(reason) {
        ChannelError::Refused
    } else {
        ChannelError::Rejected
    }
}

fn no_extra(connection_id: &str, why: &str) -> ChannelError {
    log::warn!("connection {connection_id}: no extra connection: {why}");
    ChannelError::Refused
}

fn count_live(extras: &[Weak<Extra>]) -> usize {
    extras
        .iter()
        .filter_map(Weak::upgrade)
        .filter(|x| x.is_live())
        .count()
}

impl SshManager {
    /// A session channel on `connection_id`, on an extra connection to the same host when the
    /// connection refuses one for lack of sessions. The returned session is the one the channel
    /// lives on.
    pub async fn open_channel(
        &self,
        connection_id: &str,
    ) -> Result<(Channel<Msg>, SessionRef), ChannelError> {
        let session = self
            .session(connection_id)
            .await
            .ok_or(ChannelError::NotConnected)?;
        match try_open(&session, connection_id).await {
            Ok(channel) => return Ok((channel, session)),
            Err(Attempt::Refused(reason)) => {
                refused(connection_id, &reason, "the connection");
                if !for_lack_of_sessions(&reason) {
                    return Err(ChannelError::Rejected);
                }
            }
            Err(Attempt::Failed(e)) => return Err(e),
        }
        for extra in self.live_extras(connection_id).await {
            match try_open(&extra, connection_id).await {
                Ok(channel) => return Ok((channel, extra)),
                Err(Attempt::Refused(reason)) => {
                    refused(connection_id, &reason, "an extra connection")
                }
                Err(Attempt::Failed(_)) => {}
            }
        }
        let extra = self.open_extra(connection_id).await?;
        match try_open(&extra, connection_id).await {
            Ok(channel) => Ok((channel, extra)),
            Err(Attempt::Refused(reason)) => {
                refused(connection_id, &reason, "a new extra connection");
                Err(refusal(&reason))
            }
            Err(Attempt::Failed(e)) => Err(e),
        }
    }

    /// Extra connections of `connection_id` that are still open.
    async fn live_extras(&self, connection_id: &str) -> Vec<SessionRef> {
        let mut sessions = self.sessions.lock().await;
        let Some(conn) = sessions.get_mut(connection_id) else {
            return Vec::new();
        };
        conn.extras.retain(|w| w.strong_count() > 0);
        let identity = conn.identity.clone();
        conn.extras
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|x| x.is_live())
            .map(|x| SessionRef {
                handle: x.handle.clone(),
                ended: x.ended.subscribe(),
                identity: identity.clone(),
                lease: Some(Lease { _extra: x }),
            })
            .collect()
    }

    /// Connects again with the primary's resolved target and stored credentials only: a typed
    /// secret is never kept for this, so a connection that needed one gets no extra.
    async fn open_extra(&self, connection_id: &str) -> Result<SessionRef, ChannelError> {
        let (target, primary_ended, identity) = {
            let mut sessions = self.sessions.lock().await;
            let conn = sessions
                .get_mut(connection_id)
                .filter(|c| c.is_live())
                .ok_or(ChannelError::NotConnected)?;
            let Some(target) = conn.reuse.clone() else {
                return Err(no_extra(connection_id, "no reusable target"));
            };
            if count_live(&conn.extras) >= MAX_EXTRAS {
                return Err(no_extra(connection_id, "too many extra connections"));
            }
            // Before any credential read or network traffic: the stored secret of a host edited
            // since the primary connected must not be sent to the old endpoint.
            let current = {
                let _lifecycle = self.secrets.lifecycle();
                (self.is_current)(&target)
            };
            if !current {
                conn.reuse = None;
                log::warn!("connection {connection_id}: no extra connection: the host changed");
                return Err(ChannelError::Connect(SshError::HostChanged));
            }
            (target, conn.ended.subscribe(), conn.identity.clone())
        };
        // Read only (`Purpose::Test`): an extra connection never forgets a stored secret.
        let loaded = match load_blocking(&self.secrets, &target, None, Purpose::Test).await {
            Ok(loaded) => loaded,
            Err(SshError::SecretRequired) => {
                return Err(no_extra(connection_id, "no stored secret is available"));
            }
            Err(e) => {
                log::warn!(
                    "connection {connection_id}: extra connection credentials failed ({})",
                    e.code()
                );
                return Err(ChannelError::Connect(e));
            }
        };
        let emit: Emit = Arc::new(|_| {});
        let Opened {
            handle,
            ended,
            shared,
            guard: _guard,
            ..
        } = self
            .open(&target, &loaded.credentials, &emit, Mode::Extra)
            .await
            .map_err(|e| {
                log::warn!(
                    "connection {connection_id}: extra connection failed ({})",
                    e.code()
                );
                ChannelError::Connect(e)
            })?;
        drop(loaded);
        let accepted = shared.accepted.lock().ok().and_then(|a| a.clone());

        // Same rule as a connect: registered under the sessions lock after the stale check, so a
        // delete or move either fails the check or finds the extra through the primary.
        let mut sessions = self.sessions.lock().await;
        let current = {
            let _lifecycle = self.secrets.lifecycle();
            (self.is_current)(&target)
        };
        let failure = match sessions
            .get_mut(connection_id)
            .filter(|c| c.is_live() && Arc::ptr_eq(&c.identity, &identity))
        {
            None => Some(ChannelError::NotConnected),
            Some(c) if !current => {
                c.reuse = None;
                Some(ChannelError::Connect(SshError::HostChanged))
            }
            // known_hosts may list several keys for host:port (algorithms, servers behind one
            // name). Every channel of a connection id must reach the server the primary did:
            // external edit and transfers check that identity before writing.
            Some(_) if accepted.as_deref() != Some(identity.fingerprint.as_str()) => {
                Some(ChannelError::Connect(SshError::HostKeyChanged))
            }
            Some(c) if count_live(&c.extras) >= MAX_EXTRAS => {
                Some(no_extra(connection_id, "too many extra connections"))
            }
            Some(_) => None,
        };
        let primary = match (failure, sessions.get_mut(connection_id)) {
            (None, Some(primary)) => primary,
            (failure, _) => {
                drop(sessions);
                mark_ended(&ended, SessionEnd::Disconnected);
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
                let failure = failure.unwrap_or(ChannelError::NotConnected);
                log::warn!(
                    "connection {connection_id}: extra connection dropped before use ({})",
                    failure.code()
                );
                return Err(failure);
            }
        };
        let (alive, dropped) = oneshot::channel();
        let extra = Arc::new(Extra {
            handle: Arc::new(handle),
            ended,
            runtime: tokio::runtime::Handle::current(),
            _alive: alive,
        });
        primary.extras.retain(|w| w.strong_count() > 0);
        primary.extras.push(Arc::downgrade(&extra));
        drop(sessions);
        follow_primary(primary_ended, Arc::downgrade(&extra), dropped);
        log::info!("connection {connection_id}: extra connection opened");
        Ok(SessionRef {
            handle: extra.handle.clone(),
            ended: extra.ended.subscribe(),
            identity,
            lease: Some(Lease { _extra: extra }),
        })
    }
}

/// Ends the extra connection with the primary, for the same reason.
fn follow_primary(
    mut primary: watch::Receiver<Option<SessionEnd>>,
    extra: Weak<Extra>,
    dropped: oneshot::Receiver<()>,
) {
    tokio::spawn(async move {
        let end = tokio::select! {
            end = primary.wait_for(|e| e.is_some()) => {
                end.ok().and_then(|e| *e).unwrap_or(SessionEnd::Lost)
            }
            _ = dropped => return,
        };
        if let Some(extra) = extra.upgrade() {
            mark_ended(&extra.ended, end);
            let _ = extra
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    });
}

#[cfg(test)]
impl SshManager {
    /// Extra connections of `connection_id` still open.
    pub async fn extra_count(&self, connection_id: &str) -> usize {
        self.live_extras(connection_id).await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_session_limit_reasons_lead_to_extras() {
        use ChannelOpenFailure as F;
        for reason in [
            F::ConnectFailed,
            F::AdministrativelyProhibited,
            F::ResourceShortage,
        ] {
            assert_eq!(refusal(&reason), ChannelError::Refused, "{reason:?}");
        }
        let other = F::Other {
            code: 42,
            reason: "x".into(),
        };
        for reason in [F::UnknownChannelType, other] {
            assert_eq!(refusal(&reason), ChannelError::Rejected, "{reason:?}");
        }
    }
}
