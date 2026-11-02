use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, Handle};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::AgentClient;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, watch};
use tokio::time::timeout;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::error::SshError;
use super::known_hosts::{HostKeyStatus, KnownHosts, fingerprint};
use crate::config::Host;
use crate::config::model::AuthMethod;
use crate::secrets::{SecretKind, SecretScope, SecretStore, fits_keychain};

pub type Emit = Arc<dyn Fn(ConnectEvent) + Send + Sync>;

/// Tells whether the host is still configured as it was when the connect started.
pub type StillCurrent<'a> = &'a (dyn Fn() -> bool + Send + Sync);

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectState {
    Connecting,
    Authenticating,
    Connected,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptStatus {
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectEvent {
    HostKeyPrompt {
        request_id: String,
        status: PromptStatus,
        hostname: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    HostKeyChanged {
        hostname: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
        known_fingerprints: Vec<String>,
    },
    Status {
        state: ConnectState,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub host_id: String,
    pub state: ConnectState,
}

/// A password or passphrase typed by the user for one connect attempt.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub secret: SecretString,
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub connect: Duration,
    pub prompt: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(15),
            prompt: Duration::from_secs(120),
        }
    }
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

struct ChangedKey {
    hostname: String,
    port: u16,
    key: PublicKey,
}

type ChangedKeys = Arc<Mutex<HashMap<String, ChangedKey>>>;

#[derive(Debug, Clone, Copy)]
enum Rejection {
    Rejected,
    TimedOut,
    Changed,
    Revoked,
    Io,
}

#[derive(Default)]
struct Shared {
    in_prompt: AtomicBool,
    // Held while writing known_hosts so a finished connect can never be followed by a write.
    closed: Mutex<bool>,
    request_id: Mutex<Option<String>>,
    rejection: Mutex<Option<Rejection>>,
}

impl Shared {
    fn reject(&self, why: Rejection) {
        if let Ok(mut slot) = self.rejection.lock() {
            *slot = Some(why);
        }
    }

    fn error(&self) -> SshError {
        match self.rejection.lock().ok().and_then(|r| *r) {
            Some(Rejection::Rejected) => SshError::HostKeyRejected,
            Some(Rejection::TimedOut) => SshError::Timeout,
            Some(Rejection::Changed) => SshError::HostKeyChanged,
            Some(Rejection::Revoked) => SshError::HostKeyRevoked,
            Some(Rejection::Io) => SshError::Io,
            None => SshError::Network,
        }
    }
}

struct PendingGuard {
    pending: Pending,
    id: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&self.id);
        }
    }
}

struct InPrompt(Arc<Shared>);

impl Drop for InPrompt {
    fn drop(&mut self) {
        self.0.in_prompt.store(false, Ordering::SeqCst);
    }
}

/// Ends the connect attempt: any prompt it still owns stops being answerable and cannot write.
struct ConnectGuard {
    shared: Arc<Shared>,
    pending: Pending,
}

impl Drop for ConnectGuard {
    fn drop(&mut self) {
        if let Ok(mut closed) = self.shared.closed.lock() {
            *closed = true;
        }
        let id = self
            .shared
            .request_id
            .lock()
            .ok()
            .and_then(|mut r| r.take());
        if let (Some(id), Ok(mut map)) = (id, self.pending.lock()) {
            map.remove(&id);
        }
    }
}

/// Why a live session ended, as seen by the modules sharing it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SessionEnd {
    Disconnected,
    Lost,
}

type EndSignal = Arc<watch::Sender<Option<SessionEnd>>>;

fn mark_ended(signal: &EndSignal, end: SessionEnd) {
    signal.send_if_modified(|current| {
        let first = current.is_none();
        if first {
            *current = Some(end);
        }
        first
    });
}

/// A live connection to a host, for opening channels on it.
#[derive(Clone)]
pub struct SessionRef {
    pub handle: Session,
    /// Becomes `Some` once when the connection ends; a closed sender also means it ended.
    pub ended: watch::Receiver<Option<SessionEnd>>,
}

pub struct ClientHandler {
    ended: EndSignal,
    host_id: String,
    hostname: String,
    port: u16,
    known_hosts: Arc<KnownHosts>,
    pending: Pending,
    changed: ChangedKeys,
    emit: Emit,
    prompt_timeout: Duration,
    shared: Arc<Shared>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        mark_ended(&self.ended, SessionEnd::Lost);
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(e) => Err(e),
        }
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        let status = match self.known_hosts.check(&self.hostname, self.port, &key) {
            Ok(status) => status,
            Err(_) => {
                self.shared.reject(Rejection::Io);
                return Ok(false);
            }
        };
        match status {
            HostKeyStatus::Known => return Ok(true),
            HostKeyStatus::Unknown => {}
            HostKeyStatus::Revoked => {
                self.shared.reject(Rejection::Revoked);
                return Ok(false);
            }
            HostKeyStatus::Changed { known_fingerprints } => {
                match self.changed.lock() {
                    Ok(mut map) => {
                        map.insert(
                            self.host_id.clone(),
                            ChangedKey {
                                hostname: self.hostname.clone(),
                                port: self.port,
                                key: key.clone(),
                            },
                        );
                    }
                    Err(_) => {
                        self.shared.reject(Rejection::Io);
                        return Ok(false);
                    }
                }
                self.shared.reject(Rejection::Changed);
                (self.emit)(ConnectEvent::HostKeyChanged {
                    hostname: self.hostname.clone(),
                    port: self.port,
                    algorithm: key.algorithm().to_string(),
                    fingerprint: fingerprint(&key),
                    known_fingerprints,
                });
                return Ok(false);
            }
        }

        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        match self.pending.lock() {
            Ok(mut map) => map.insert(request_id.clone(), tx),
            Err(_) => {
                self.shared.reject(Rejection::Io);
                return Ok(false);
            }
        };
        let _guard = PendingGuard {
            pending: self.pending.clone(),
            id: request_id.clone(),
        };
        if let Ok(mut slot) = self.shared.request_id.lock() {
            *slot = Some(request_id.clone());
        }
        self.shared.in_prompt.store(true, Ordering::SeqCst);
        let _in_prompt = InPrompt(self.shared.clone());
        (self.emit)(ConnectEvent::HostKeyPrompt {
            request_id,
            status: PromptStatus::Unknown,
            hostname: self.hostname.clone(),
            port: self.port,
            algorithm: key.algorithm().to_string(),
            fingerprint: fingerprint(&key),
        });

        match timeout(self.prompt_timeout, rx).await {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) | Ok(Err(_)) => {
                self.shared.reject(Rejection::Rejected);
                return Ok(false);
            }
            Err(_) => {
                self.shared.reject(Rejection::TimedOut);
                return Ok(false);
            }
        }
        let Ok(closed) = self.shared.closed.lock() else {
            self.shared.reject(Rejection::Io);
            return Ok(false);
        };
        if *closed {
            drop(closed);
            self.shared.reject(Rejection::Rejected);
            return Ok(false);
        }
        let stored = self.known_hosts.trust(&self.hostname, self.port, &key);
        drop(closed);
        if stored.is_err() {
            self.shared.reject(Rejection::Io);
            return Ok(false);
        }
        Ok(true)
    }
}

enum Credentials {
    Key(Arc<PrivateKey>),
    Password(SecretString),
    Agent,
}

struct Loaded {
    credentials: Credentials,
    remember: Option<(SecretKind, SecretString)>,
    from_keychain: bool,
}

struct Resolved {
    value: SecretString,
    remember: Option<(SecretKind, SecretString)>,
    from_keychain: bool,
}

pub type Session = Arc<Handle<ClientHandler>>;

struct Connection {
    handle: Session,
    ended: EndSignal,
}

impl Connection {
    fn is_live(&self) -> bool {
        !self.handle.is_closed() && self.ended.borrow().is_none()
    }
}

/// Any connection leaving the map without `disconnect` was lost.
fn forget_connection(conn: Connection) {
    mark_ended(&conn.ended, SessionEnd::Lost);
}

pub struct SshManager {
    known_hosts: Arc<KnownHosts>,
    timeouts: Timeouts,
    sessions: tokio::sync::Mutex<HashMap<String, Connection>>,
    host_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pending: Pending,
    changed: ChangedKeys,
    secrets: SecretStore,
}

impl SshManager {
    pub fn new(config_dir: &Path, secrets: SecretStore) -> Self {
        let user_file = std::env::home_dir().map(|h| h.join(".ssh").join("known_hosts"));
        Self::with_parts(
            KnownHosts::new(config_dir.join("known_hosts"), user_file),
            Timeouts::default(),
            secrets,
        )
    }

    pub fn with_parts(known_hosts: KnownHosts, timeouts: Timeouts, secrets: SecretStore) -> Self {
        Self {
            known_hosts: Arc::new(known_hosts),
            timeouts,
            secrets,
            sessions: Default::default(),
            host_locks: Default::default(),
            pending: Default::default(),
            changed: Default::default(),
        }
    }

    /// Trusts the key presented in the last `host_key_changed` failure, if `fingerprint` matches it.
    pub fn replace_host_key(&self, host_id: &str, fingerprint: &str) -> Result<(), SshError> {
        let mut map = self.changed.lock().map_err(|_| SshError::Io)?;
        let entry = map.get(host_id).ok_or(SshError::NotFound("host key"))?;
        if self::fingerprint(&entry.key) != fingerprint {
            return Err(SshError::InvalidInput(
                "the fingerprint does not match the presented host key".into(),
            ));
        }
        self.known_hosts
            .trust(&entry.hostname, entry.port, &entry.key)?;
        map.remove(host_id);
        Ok(())
    }

    pub fn answer_host_key(&self, request_id: &str, accept: bool) -> Result<(), SshError> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| SshError::Io)?
            .remove(request_id)
            .ok_or(SshError::NotFound("host key request"))?;
        let _ = sender.send(accept);
        Ok(())
    }

    pub async fn disconnect(&self, host_id: &str) -> Result<(), SshError> {
        let conn = self.sessions.lock().await.remove(host_id);
        if let Some(conn) = conn {
            // Marked before the disconnect so channel users see why their channels end.
            mark_ended(&conn.ended, SessionEnd::Disconnected);
            let _ = conn
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
        Ok(())
    }

    /// The live session of `host_id`, shared by every terminal and SFTP pane of the host.
    pub async fn session(&self, host_id: &str) -> Option<SessionRef> {
        let mut sessions = self.sessions.lock().await;
        match sessions.get(host_id) {
            Some(c) if c.is_live() => Some(SessionRef {
                handle: c.handle.clone(),
                ended: c.ended.subscribe(),
            }),
            Some(_) => {
                if let Some(c) = sessions.remove(host_id) {
                    forget_connection(c);
                }
                None
            }
            None => None,
        }
    }

    pub async fn list(&self) -> Vec<ConnectionInfo> {
        let mut sessions = self.sessions.lock().await;
        let dead: Vec<String> = sessions
            .iter()
            .filter(|(_, c)| !c.is_live())
            .map(|(id, _)| id.clone())
            .collect();
        for id in dead {
            if let Some(c) = sessions.remove(&id) {
                forget_connection(c);
            }
        }
        let mut out: Vec<ConnectionInfo> = sessions
            .keys()
            .map(|id| ConnectionInfo {
                host_id: id.clone(),
                state: ConnectState::Connected,
            })
            .collect();
        out.sort_by(|a, b| a.host_id.cmp(&b.host_id));
        out
    }

    /// `scope` locates the host's keychain entries; `credential` overrides the stored secret.
    pub async fn connect(
        &self,
        scope: &SecretScope,
        host: &Host,
        credential: Option<Credential>,
        still_current: StillCurrent<'_>,
        emit: Emit,
    ) -> Result<ConnectionInfo, SshError> {
        let lock = {
            let mut locks = self.host_locks.lock().map_err(|_| SshError::Io)?;
            locks.entry(host.id.clone()).or_default().clone()
        };
        let _serial = lock.lock().await;

        let info = ConnectionInfo {
            host_id: host.id.clone(),
            state: ConnectState::Connected,
        };
        {
            let mut sessions = self.sessions.lock().await;
            match sessions.get(&host.id) {
                Some(c) if c.is_live() => return Ok(info),
                Some(_) => {
                    if let Some(c) = sessions.remove(&host.id) {
                        forget_connection(c);
                    }
                }
                None => {}
            }
        }

        let Loaded {
            credentials,
            remember,
            from_keychain,
        } = load_credentials(&self.secrets, scope, &host.auth, credential)?;
        if let Ok(mut map) = self.changed.lock() {
            map.remove(&host.id);
        }
        emit(ConnectEvent::Status {
            state: ConnectState::Connecting,
        });

        let stream = timeout(
            self.timeouts.connect,
            TcpStream::connect((host.hostname.as_str(), host.port)),
        )
        .await
        .map_err(|_| SshError::Timeout)?
        .map_err(|_| SshError::Network)?;

        let ended: EndSignal = Arc::new(watch::channel(None).0);
        let shared = Arc::new(Shared::default());
        let _end = ConnectGuard {
            shared: shared.clone(),
            pending: self.pending.clone(),
        };
        let handler = ClientHandler {
            ended: ended.clone(),
            host_id: host.id.clone(),
            hostname: host.hostname.clone(),
            port: host.port,
            known_hosts: self.known_hosts.clone(),
            pending: self.pending.clone(),
            changed: self.changed.clone(),
            emit: emit.clone(),
            prompt_timeout: self.timeouts.prompt,
            shared: shared.clone(),
        };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let handshake = client::connect_stream(config, stream, handler);
        tokio::pin!(handshake);
        // The connect timeout does not run while the user is deciding on a host key.
        let mut handle = loop {
            match timeout(self.timeouts.connect, &mut handshake).await {
                Ok(Ok(handle)) => break handle,
                Ok(Err(_)) => return Err(shared.error()),
                Err(_) if shared.in_prompt.load(Ordering::SeqCst) => continue,
                Err(_) => return Err(SshError::Timeout),
            }
        };

        emit(ConnectEvent::Status {
            state: ConnectState::Authenticating,
        });
        let auth = timeout(
            self.timeouts.connect,
            authenticate(&mut handle, &host.username, &credentials),
        )
        .await;
        let outcome = match auth {
            Ok(r) => r,
            Err(_) => Err(SshError::Timeout),
        };
        if let Err(e) = outcome {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            if let (SshError::AuthFailed(_), true, Credentials::Password(p)) =
                (&e, from_keychain, &credentials)
            {
                forget_if_unchanged(&self.secrets, scope, SecretKind::Password, p);
            }
            return Err(e);
        }

        // The host-key prompt can last minutes; the host may have been edited or deleted meanwhile.
        if let Some((kind, secret)) = remember
            && fits_keychain(&secret)
            && still_current()
            && self.secrets.set(scope, kind, &secret).is_err()
        {
            log::warn!(
                "could not store the {kind} of host {} in the keychain",
                host.id
            );
        }

        self.sessions.lock().await.insert(
            host.id.clone(),
            Connection {
                handle: Arc::new(handle),
                ended,
            },
        );
        emit(ConnectEvent::Status {
            state: ConnectState::Connected,
        });
        Ok(info)
    }
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"))
        && let Some(home) = std::env::home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(path)
}

fn provided_or_stored(
    secrets: &SecretStore,
    scope: &SecretScope,
    kind: SecretKind,
    credential: Option<Credential>,
) -> Result<Resolved, SshError> {
    if let Some(c) = credential {
        let remember = c
            .remember
            .then(|| (kind, SecretString::from(c.secret.expose_secret())));
        return Ok(Resolved {
            value: c.secret,
            remember,
            from_keychain: false,
        });
    }
    match secrets.get(scope, kind)? {
        Some(value) => Ok(Resolved {
            value,
            remember: None,
            from_keychain: true,
        }),
        None => Err(SshError::SecretRequired),
    }
}

/// Drops a stored secret the server or the key file rejected, unless it was replaced meanwhile.
fn forget_if_unchanged(
    secrets: &SecretStore,
    scope: &SecretScope,
    kind: SecretKind,
    rejected: &SecretString,
) {
    let unchanged = matches!(
        secrets.get(scope, kind),
        Ok(Some(current)) if current.expose_secret() == rejected.expose_secret()
    );
    if unchanged && secrets.delete(scope, kind).is_err() {
        log::warn!(
            "could not delete the rejected {kind} of host {} from the keychain",
            scope.host_id()
        );
    }
}

fn read_key_file(key_path: &str) -> Result<Zeroizing<String>, SshError> {
    match std::fs::read_to_string(expand_home(key_path)) {
        Ok(t) => Ok(Zeroizing::new(t)),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => Err(unparseable_key()),
        Err(_) => Err(SshError::Io),
    }
}

fn unparseable_key() -> SshError {
    SshError::InvalidInput("the private key file could not be parsed".into())
}

/// Resolves everything authentication needs before any network traffic.
fn load_credentials(
    secrets: &SecretStore,
    scope: &SecretScope,
    auth: &AuthMethod,
    credential: Option<Credential>,
) -> Result<Loaded, SshError> {
    use russh::keys::Error as KeyError;
    match auth {
        AuthMethod::Agent => Ok(Loaded {
            credentials: Credentials::Agent,
            remember: None,
            from_keychain: false,
        }),
        AuthMethod::Password => {
            let r = provided_or_stored(secrets, scope, SecretKind::Password, credential)?;
            Ok(Loaded {
                credentials: Credentials::Password(r.value),
                remember: r.remember,
                from_keychain: r.from_keychain,
            })
        }
        AuthMethod::Key { key_path } => {
            let text = read_key_file(key_path)?;
            let (key, remember) = match russh::keys::decode_secret_key(&text, None) {
                Ok(key) => (key, None),
                Err(KeyError::KeyIsEncrypted) => {
                    let r = provided_or_stored(secrets, scope, SecretKind::Passphrase, credential)?;
                    match russh::keys::decode_secret_key(&text, Some(r.value.expose_secret())) {
                        Ok(key) => (key, r.remember),
                        Err(KeyError::IO(_)) => return Err(SshError::Io),
                        Err(_) => {
                            if r.from_keychain {
                                forget_if_unchanged(
                                    secrets,
                                    scope,
                                    SecretKind::Passphrase,
                                    &r.value,
                                );
                            }
                            return Err(SshError::InvalidPassphrase);
                        }
                    }
                }
                Err(KeyError::IO(_)) => return Err(SshError::Io),
                Err(_) => return Err(unparseable_key()),
            };
            Ok(Loaded {
                credentials: Credentials::Key(Arc::new(key)),
                remember,
                from_keychain: false,
            })
        }
    }
}

async fn rsa_hash(handle: &Handle<ClientHandler>, key: &PublicKey) -> Option<HashAlg> {
    if key.algorithm().is_rsa() {
        handle
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten()
    } else {
        None
    }
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    credentials: &Credentials,
) -> Result<(), SshError> {
    let failed = || SshError::AuthFailed("authentication was refused by the server".into());
    match credentials {
        Credentials::Key(key) => {
            let hash = rsa_hash(handle, key.public_key()).await;
            let key = PrivateKeyWithHashAlg::new(key.clone(), hash);
            match handle.authenticate_publickey(username, key).await {
                Ok(AuthResult::Success) => Ok(()),
                Ok(AuthResult::Failure { .. }) => Err(failed()),
                Err(_) => Err(SshError::Network),
            }
        }
        Credentials::Password(password) => {
            match handle
                .authenticate_password(username, password.expose_secret())
                .await
            {
                Ok(AuthResult::Success) => Ok(()),
                Ok(AuthResult::Failure { .. }) => Err(failed()),
                Err(_) => Err(SshError::Network),
            }
        }
        Credentials::Agent => {
            let mut agent = connect_agent().await?;
            let identities = agent.request_identities().await.map_err(|_| {
                SshError::AuthFailed("the SSH agent could not list its keys".into())
            })?;
            for identity in identities {
                let AgentIdentity::PublicKey { key, .. } = identity else {
                    continue;
                };
                let hash = rsa_hash(handle, &key).await;
                match handle
                    .authenticate_publickey_with(username, key, hash, &mut agent)
                    .await
                {
                    Ok(AuthResult::Success) => return Ok(()),
                    Ok(AuthResult::Failure { .. }) | Err(_) => continue,
                }
            }
            Err(failed())
        }
    }
}

type DynAgent = AgentClient<Box<dyn russh::keys::agent::client::AgentStream + Send + Unpin>>;

async fn connect_agent() -> Result<DynAgent, SshError> {
    let unavailable = || SshError::AuthFailed("no SSH agent is available".into());
    #[cfg(unix)]
    {
        AgentClient::connect_env()
            .await
            .map(|a| a.dynamic())
            .map_err(|_| unavailable())
    }
    #[cfg(windows)]
    {
        if let Ok(a) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            return Ok(a.dynamic());
        }
        AgentClient::connect_pageant()
            .await
            .map(|a| a.dynamic())
            .map_err(|_| unavailable())
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod e2e_tests;
