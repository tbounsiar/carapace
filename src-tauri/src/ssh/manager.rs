use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

use super::ends::{ConnectionEnd, EndEmit, Ends};
use super::error::SshError;
use super::known_hosts::{HostKeyStatus, KnownHosts, fingerprint};
use crate::secrets::{KeyPassKey, SavedKey, SecretKind, SecretStore, VarKey, fits_saved};
use crate::text::Text;

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
    pub connection_id: String,
    pub host_id: String,
    pub state: ConnectState,
}

/// Where a password or passphrase comes from when none is typed: the secret variable the host
/// field references (if any), then the secret saved for this connection, then (passphrase
/// only) the one remembered for the registered key whose public key the file holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetAuth {
    Password {
        variable: Option<VarKey>,
    },
    Key {
        key_path: String,
        passphrase: Option<VarKey>,
        registered: Vec<RegisteredKey>,
    },
    Agent,
}

/// A registered key with a remembered passphrase. It is matched by the fingerprint of the
/// file actually read at connect time, never by path, so a file swapped in after resolution
/// never gets another key's passphrase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredKey {
    pub fingerprint: String,
    pub passphrase: KeyPassKey,
}

/// A resolved host: what a connection is made from. `connection_id` is the host id.
/// `project_id` is the host's scope (None: Home); it is part of the comparison done by
/// `still_current`, so a host moved to another scope during a connect is stale.
/// `saved` is `None` for an unsaved draft: no saved connection secret is a candidate then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub connection_id: String,
    pub host_id: String,
    pub project_id: Option<String>,
    pub saved: Option<SavedKey>,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: TargetAuth,
}

impl Target {
    /// What a saved secret of `kind` is bound to: a password to one remote account, a
    /// passphrase to one key file.
    pub fn bound_to(&self, kind: SecretKind) -> String {
        match (kind, &self.auth) {
            (SecretKind::Passphrase, TargetAuth::Key { key_path, .. }) => key_path.clone(),
            _ => format!("{}@{}:{}", self.username, self.hostname, self.port),
        }
    }

    fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            connection_id: self.connection_id.clone(),
            host_id: self.host_id.clone(),
            state: ConnectState::Connected,
        }
    }

    fn auth_kind(&self) -> AuthKind {
        match self.auth {
            TargetAuth::Password { .. } => AuthKind::Password,
            TargetAuth::Key { .. } => AuthKind::Key,
            TargetAuth::Agent => AuthKind::Agent,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Password,
    Key,
    Agent,
}

/// Where the secret that authenticated came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretSource {
    Typed,
    Variable,
    Saved,
    KeyPassphrase,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTestResult {
    /// `user@host:port`, resolved.
    pub address: String,
    pub auth_kind: AuthKind,
    /// `None` for the agent and unencrypted keys.
    pub secret_source: Option<SecretSource>,
    /// Connect and authentication time, host key prompts excluded.
    pub duration_ms: u64,
}

/// A connect result; `opened` is the time a new connection took, host key prompts excluded.
#[derive(Debug, Clone)]
pub struct Connected {
    pub info: ConnectionInfo,
    pub opened: Option<Duration>,
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
    UserKnownHostsUnreadable(std::io::ErrorKind),
}

#[derive(Default)]
struct Shared {
    in_prompt: AtomicBool,
    prompt_time: Mutex<Duration>,
    // Held while writing known_hosts so a finished connect can never be followed by a write.
    closed: Mutex<bool>,
    request_id: Mutex<Option<String>>,
    rejection: Mutex<Option<Rejection>>,
    /// SHA256 fingerprint of the host key the check accepted.
    accepted: Mutex<Option<String>>,
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
            Some(Rejection::UserKnownHostsUnreadable(kind)) => {
                SshError::UserKnownHostsUnreadable(kind)
            }
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

struct InPrompt {
    shared: Arc<Shared>,
    since: Instant,
}

impl Drop for InPrompt {
    fn drop(&mut self) {
        self.shared.in_prompt.store(false, Ordering::SeqCst);
        if let Ok(mut total) = self.shared.prompt_time.lock() {
            *total += self.since.elapsed();
        }
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
    pub identity: Arc<HostIdentity>,
}

/// Which server a session reached: the accepted host key and the resolved endpoint. Used to
/// tell whether work queued for a host id still targets the same server. Never sent to the
/// frontend.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostIdentity {
    pub fingerprint: String,
    /// `hostname:port:username`.
    pub endpoint: String,
}

pub struct ClientHandler {
    ended: EndSignal,
    connection_id: String,
    hostname: String,
    port: u16,
    known_hosts: Arc<KnownHosts>,
    pending: Pending,
    /// `None` for a test: a changed key it meets is never offered to `replace_host_key`.
    changed: Option<ChangedKeys>,
    emit: Emit,
    prompt_timeout: Duration,
    shared: Arc<Shared>,
}

/// russh skips `disconnected` when shutting down the socket fails after the peer went away;
/// the handler is dropped with the session task in every case, so the end is marked here too.
impl Drop for ClientHandler {
    fn drop(&mut self) {
        mark_ended(&self.ended, SessionEnd::Lost);
    }
}

impl ClientHandler {
    /// `Some(true)` for a known key, `Some(false)` for a refusal (reason stored, changed key
    /// remembered for replace on a connect and reported), `None` for an unknown key.
    fn verdict(&self, status: Result<HostKeyStatus, SshError>, key: &PublicKey) -> Option<bool> {
        let status = match status {
            Ok(status) => status,
            Err(SshError::UserKnownHostsUnreadable(kind)) => {
                self.shared
                    .reject(Rejection::UserKnownHostsUnreadable(kind));
                return Some(false);
            }
            Err(_) => {
                self.shared.reject(Rejection::Io);
                return Some(false);
            }
        };
        match status {
            HostKeyStatus::Known => Some(true),
            HostKeyStatus::Unknown => None,
            HostKeyStatus::Revoked => {
                self.shared.reject(Rejection::Revoked);
                Some(false)
            }
            HostKeyStatus::Changed { known_fingerprints } => {
                if let Some(changed) = &self.changed {
                    match changed.lock() {
                        Ok(mut map) => {
                            map.insert(
                                self.connection_id.clone(),
                                ChangedKey {
                                    hostname: self.hostname.clone(),
                                    port: self.port,
                                    key: key.clone(),
                                },
                            );
                        }
                        Err(_) => {
                            self.shared.reject(Rejection::Io);
                            return Some(false);
                        }
                    }
                }
                self.shared.reject(Rejection::Changed);
                (self.emit)(ConnectEvent::HostKeyChanged {
                    hostname: self.hostname.clone(),
                    port: self.port,
                    algorithm: key.algorithm().to_string(),
                    fingerprint: fingerprint(key),
                    known_fingerprints,
                });
                Some(false)
            }
        }
    }
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
        let accepted = self.check_key(server_public_key).await;
        if let Ok((true, fp)) = &accepted
            && let Ok(mut slot) = self.shared.accepted.lock()
        {
            *slot = Some(fp.clone());
        }
        accepted.map(|(ok, _)| ok)
    }
}

impl ClientHandler {
    /// The verdict, and the fingerprint of the key it is about.
    async fn check_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<(bool, String), russh::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        let fp = fingerprint(&key);
        let status = self.known_hosts.check(&self.hostname, self.port, &key);
        if let Some(verdict) = self.verdict(status, &key) {
            return Ok((verdict, fp));
        }

        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        match self.pending.lock() {
            Ok(mut map) => map.insert(request_id.clone(), tx),
            Err(_) => {
                self.shared.reject(Rejection::Io);
                return Ok((false, fp));
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
        let _in_prompt = InPrompt {
            shared: self.shared.clone(),
            since: Instant::now(),
        };
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
                return Ok((false, fp));
            }
            Err(_) => {
                self.shared.reject(Rejection::TimedOut);
                return Ok((false, fp));
            }
        }
        let Ok(closed) = self.shared.closed.lock() else {
            self.shared.reject(Rejection::Io);
            return Ok((false, fp));
        };
        if *closed {
            drop(closed);
            self.shared.reject(Rejection::Rejected);
            return Ok((false, fp));
        }
        // Re-checked with the write: another connect or test may have trusted a key for this
        // host while the user was deciding.
        let stored = self
            .known_hosts
            .trust_if_unknown(&self.hostname, self.port, &key);
        drop(closed);
        let ok = match stored {
            Ok(HostKeyStatus::Unknown) => true,
            other => self.verdict(other, &key).unwrap_or(false),
        };
        Ok((ok, fp))
    }
}

enum Credentials {
    Key(Arc<PrivateKey>),
    Password(SecretString),
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    Typed,
    /// The secret variable's name.
    Variable(String),
    Saved,
    Key,
}

impl Source {
    fn public(&self) -> SecretSource {
        match self {
            Self::Typed => SecretSource::Typed,
            Self::Variable(_) => SecretSource::Variable,
            Self::Saved => SecretSource::Saved,
            Self::Key => SecretSource::KeyPassphrase,
        }
    }

    /// The server refused this stored password; names the variable, never the value. `None`
    /// when typed.
    fn password_refused(&self) -> Option<Text> {
        match self {
            Self::Typed | Self::Key => None,
            Self::Variable(name) => Some(crate::text!(
                "errors.ssh.variablePasswordRefused",
                "the password from variable {name} was refused by the server",
                name = name.as_str()
            )),
            Self::Saved => Some(crate::text!(
                "errors.ssh.savedPasswordRefused",
                "the saved password was refused by the server"
            )),
        }
    }

    /// This stored passphrase does not unlock the key; `None` when typed.
    fn passphrase_refused(&self) -> Option<Text> {
        match self {
            Self::Typed => None,
            Self::Variable(name) => Some(crate::text!(
                "errors.ssh.variablePassphraseRefused",
                "the passphrase from variable {name} does not unlock the private key",
                name = name.as_str()
            )),
            Self::Saved => Some(crate::text!(
                "errors.ssh.savedPassphraseRefused",
                "the saved passphrase does not unlock the private key"
            )),
            Self::Key => Some(crate::text!(
                "errors.ssh.rememberedPassphraseRefused",
                "the remembered key passphrase does not unlock the private key"
            )),
        }
    }
}

/// A test never forgets a refused saved secret, and its errors say which stored secret failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Purpose {
    Connect,
    Test,
}

struct Loaded {
    credentials: Credentials,
    remember: Option<(SecretKind, SecretString)>,
    /// `None` when no secret is involved (agent, unencrypted key).
    source: Option<Source>,
}

struct Resolved {
    value: SecretString,
    remember: Option<(SecretKind, SecretString)>,
    source: Source,
}

pub type Session = Arc<Handle<ClientHandler>>;

struct Connection {
    handle: Session,
    ended: EndSignal,
    info: ConnectionInfo,
    identity: Arc<HostIdentity>,
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

/// A second handle on a test's socket. russh runs the handshake in a spawned task that would
/// outlive a cancelled test; shutting the socket down ends that task at once.
struct SocketCloser {
    socket: std::net::TcpStream,
    armed: bool,
}

impl Drop for SocketCloser {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.socket.shutdown(std::net::Shutdown::Both);
        }
    }
}

fn closable(stream: TcpStream) -> Result<(TcpStream, SocketCloser), SshError> {
    let socket = stream.into_std().map_err(|_| SshError::Network)?;
    let second = socket.try_clone().map_err(|_| SshError::Network)?;
    let stream = TcpStream::from_std(socket).map_err(|_| SshError::Network)?;
    Ok((
        stream,
        SocketCloser {
            socket: second,
            armed: true,
        },
    ))
}

/// An authenticated session, not registered anywhere yet.
struct Opened {
    handle: Handle<ClientHandler>,
    ended: EndSignal,
    shared: Arc<Shared>,
    guard: ConnectGuard,
    socket: Option<SocketCloser>,
}

type Tests = Mutex<HashMap<String, (u64, oneshot::Sender<()>)>>;

/// Each test holds a TCP connection and maybe a prompt; a few at once is plenty for one form.
const MAX_TESTS: usize = 4;

/// A registered test; dropping it unregisters the id.
pub struct TestTicket<'a> {
    _guard: TestGuard<'a>,
    cancelled: oneshot::Receiver<()>,
}

/// Unregisters a test, unless a later test reused its id after a cancel.
struct TestGuard<'a> {
    tests: &'a Tests,
    id: String,
    token: u64,
}

impl Drop for TestGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.tests.lock()
            && map.get(&self.id).is_some_and(|(t, _)| *t == self.token)
        {
            map.remove(&self.id);
        }
    }
}

pub struct SshManager {
    known_hosts: Arc<KnownHosts>,
    timeouts: Timeouts,
    sessions: tokio::sync::Mutex<HashMap<String, Connection>>,
    host_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pending: Pending,
    changed: ChangedKeys,
    secrets: SecretStore,
    tests: Tests,
    next_test: AtomicU64,
    ends: Ends,
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
            tests: Default::default(),
            next_test: AtomicU64::new(0),
            ends: Ends::default(),
        }
    }

    /// Trusts the key presented in the last `host_key_changed` failure, if `fingerprint` matches it.
    pub fn replace_host_key(&self, connection_id: &str, fingerprint: &str) -> Result<(), SshError> {
        let mut map = self.changed.lock().map_err(|_| SshError::Io)?;
        let entry = map
            .get(connection_id)
            .ok_or(SshError::NotFound("host key"))?;
        if self::fingerprint(&entry.key) != fingerprint {
            return Err(SshError::InvalidInput(crate::text!(
                "errors.ssh.fingerprintMismatch",
                "the fingerprint does not match the presented host key"
            )));
        }
        self.known_hosts
            .trust(&entry.hostname, entry.port, &entry.key)?;
        map.remove(connection_id);
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

    pub async fn disconnect(&self, connection_id: &str) -> Result<(), SshError> {
        let conn = self.sessions.lock().await.remove(connection_id);
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

    /// The live session of `connection_id`, shared by every terminal and SFTP pane of it.
    pub async fn session(&self, connection_id: &str) -> Option<SessionRef> {
        let mut sessions = self.sessions.lock().await;
        match sessions.get(connection_id) {
            Some(c) if c.is_live() => Some(SessionRef {
                handle: c.handle.clone(),
                ended: c.ended.subscribe(),
                identity: c.identity.clone(),
            }),
            Some(_) => {
                if let Some(c) = sessions.remove(connection_id) {
                    forget_connection(c);
                }
                None
            }
            None => None,
        }
    }

    /// Live `connectionEnded` events go to `emit` from now on; returns how the connections that
    /// are not connected again ended.
    pub fn subscribe_ends(&self, emit: EndEmit) -> Vec<ConnectionEnd> {
        self.ends.subscribe(emit)
    }

    pub fn unsubscribe_ends(&self) {
        self.ends.unsubscribe();
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
        let mut out: Vec<ConnectionInfo> = sessions.values().map(|c| c.info.clone()).collect();
        out.sort_by(|a, b| a.connection_id.cmp(&b.connection_id));
        out
    }

    /// `credential` overrides any stored secret.
    #[cfg(test)]
    pub async fn connect(
        &self,
        target: &Target,
        credential: Option<Credential>,
        still_current: StillCurrent<'_>,
        emit: Emit,
    ) -> Result<ConnectionInfo, SshError> {
        self.connect_timed(target, credential, still_current, emit)
            .await
            .map(|c| c.info)
    }

    /// Like `connect`; `opened` is `None` when the connection was already open.
    pub async fn connect_timed(
        &self,
        target: &Target,
        credential: Option<Credential>,
        still_current: StillCurrent<'_>,
        emit: Emit,
    ) -> Result<Connected, SshError> {
        let started = Instant::now();
        let lock = {
            let mut locks = self.host_locks.lock().map_err(|_| SshError::Io)?;
            locks
                .entry(target.connection_id.clone())
                .or_default()
                .clone()
        };
        let _serial = lock.lock().await;

        let info = target.info();
        {
            let mut sessions = self.sessions.lock().await;
            match sessions.get(&target.connection_id) {
                Some(c) if c.is_live() => return Ok(Connected { info, opened: None }),
                Some(_) => {
                    if let Some(c) = sessions.remove(&target.connection_id) {
                        forget_connection(c);
                    }
                }
                None => {}
            }
        }

        let Loaded {
            credentials,
            remember,
            source,
        } = load_blocking(&self.secrets, target, credential, Purpose::Connect).await?;
        if let Ok(mut map) = self.changed.lock() {
            map.remove(&target.connection_id);
        }
        let Opened {
            handle,
            ended,
            shared,
            guard: _guard,
            ..
        } = match self.open(target, &credentials, &emit, false).await {
            Ok(opened) => opened,
            Err(e) => {
                if let (SshError::AuthFailed(_), Some(Source::Saved), Credentials::Password(p)) =
                    (&e, &source, &credentials)
                {
                    forget_if_unchanged(&self.secrets, target, SecretKind::Password, p);
                }
                return Err(e);
            }
        };

        // The host-key prompt can last minutes; the host may have been edited, moved or deleted
        // meanwhile. Checked under the lifecycle lock, which deletes and moves hold while they
        // change the config and the keychain, and with the sessions lock held until the insert:
        // a delete or move that ran before the check makes it fail, one that runs after it
        // finds the session when it closes the host's connections.
        let mut sessions = self.sessions.lock().await;
        let current = {
            let _lifecycle = self.secrets.lifecycle();
            let current = still_current();
            if current
                && let Some((kind, secret)) = remember
                && let Some(saved) = &target.saved
            {
                let bound = target.bound_to(kind);
                if fits_saved(&bound, &secret)
                    && self
                        .secrets
                        .set_saved(saved, kind, &bound, &secret)
                        .is_err()
                {
                    log::warn!(
                        "could not store the {kind} of connection {} in the keychain",
                        target.connection_id
                    );
                }
            }
            current
        };
        if !current {
            drop(sessions);
            mark_ended(&ended, SessionEnd::Disconnected);
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            log::info!(
                "connection {} dropped: the host changed while connecting",
                target.connection_id
            );
            return Err(SshError::HostChanged);
        }
        self.ends.watch(&target.connection_id, ended.subscribe());
        sessions.insert(
            target.connection_id.clone(),
            Connection {
                handle: Arc::new(handle),
                ended,
                info: info.clone(),
                identity: Arc::new(HostIdentity {
                    fingerprint: shared
                        .accepted
                        .lock()
                        .ok()
                        .and_then(|a| a.clone())
                        .unwrap_or_default(),
                    endpoint: format!("{}:{}:{}", target.hostname, target.port, target.username),
                }),
            },
        );
        emit(ConnectEvent::Status {
            state: ConnectState::Connected,
        });
        let prompts = shared.prompt_time.lock().map(|t| *t).unwrap_or_default();
        Ok(Connected {
            info,
            opened: Some(started.elapsed().saturating_sub(prompts)),
        })
    }

    /// TCP connect, handshake with the host key check, authentication. `test` keeps a changed
    /// key away from `replace_host_key` and makes the socket closable from outside russh.
    async fn open(
        &self,
        target: &Target,
        credentials: &Credentials,
        emit: &Emit,
        test: bool,
    ) -> Result<Opened, SshError> {
        emit(ConnectEvent::Status {
            state: ConnectState::Connecting,
        });

        let stream = timeout(
            self.timeouts.connect,
            TcpStream::connect((target.hostname.as_str(), target.port)),
        )
        .await
        .map_err(|_| SshError::Timeout)?
        .map_err(|_| SshError::Network)?;
        let (stream, socket) = if test {
            let (stream, closer) = closable(stream)?;
            (stream, Some(closer))
        } else {
            (stream, None)
        };

        let ended: EndSignal = Arc::new(watch::channel(None).0);
        let shared = Arc::new(Shared::default());
        let guard = ConnectGuard {
            shared: shared.clone(),
            pending: self.pending.clone(),
        };
        let handler = ClientHandler {
            ended: ended.clone(),
            connection_id: target.connection_id.clone(),
            hostname: target.hostname.clone(),
            port: target.port,
            known_hosts: self.known_hosts.clone(),
            pending: self.pending.clone(),
            changed: (!test).then(|| self.changed.clone()),
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
            authenticate(&mut handle, &target.username, credentials),
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
            return Err(e);
        }
        Ok(Opened {
            handle,
            ended,
            shared,
            guard,
            socket,
        })
    }

    /// Registers a test before anything else runs, so a `cancel_test` sent at any point
    /// afterwards is seen. A running id is `invalid_input`; more than `MAX_TESTS` is `busy`.
    pub fn start_test(&self, test_id: &str) -> Result<TestTicket<'_>, SshError> {
        let token = self.next_test.fetch_add(1, Ordering::Relaxed);
        let (tx, cancelled) = oneshot::channel();
        let mut tests = self.tests.lock().map_err(|_| SshError::Io)?;
        if tests.contains_key(test_id) {
            return Err(SshError::InvalidInput(crate::text!(
                "errors.ssh.testRunning",
                "a test with this id is already running"
            )));
        }
        if tests.len() >= MAX_TESTS {
            return Err(SshError::Busy);
        }
        tests.insert(test_id.to_owned(), (token, tx));
        Ok(TestTicket {
            _guard: TestGuard {
                tests: &self.tests,
                id: test_id.to_owned(),
                token,
            },
            cancelled,
        })
    }

    /// Connects, checks the host key and authenticates like `connect`, then disconnects.
    /// Nothing is registered, remembered or forgotten.
    pub async fn probe(
        &self,
        ticket: TestTicket<'_>,
        target: &Target,
        credential: Option<Credential>,
        emit: Emit,
    ) -> Result<HostTestResult, SshError> {
        let TestTicket { _guard, cancelled } = ticket;
        tokio::select! {
            biased;
            _ = cancelled => Err(SshError::Cancelled),
            result = self.run_probe(target, credential, emit) => result,
        }
    }

    /// Dropping the test's future closes its socket and resolves its host key prompt as
    /// rejected (`ConnectGuard`). An unknown id is not an error.
    pub fn cancel_test(&self, test_id: &str) -> Result<(), SshError> {
        let entry = self.tests.lock().map_err(|_| SshError::Io)?.remove(test_id);
        if let Some((_, tx)) = entry {
            let _ = tx.send(());
        }
        Ok(())
    }

    async fn run_probe(
        &self,
        target: &Target,
        credential: Option<Credential>,
        emit: Emit,
    ) -> Result<HostTestResult, SshError> {
        let started = Instant::now();
        let credential = credential.map(|c| Credential {
            secret: c.secret,
            remember: false,
        });
        let Loaded {
            credentials,
            source,
            ..
        } = load_blocking(&self.secrets, target, credential, Purpose::Test).await?;
        let Opened {
            handle,
            shared,
            mut socket,
            ..
        } = match self.open(target, &credentials, &emit, true).await {
            Ok(opened) => opened,
            Err(SshError::AuthFailed(message)) => {
                let refused = match (&credentials, &source) {
                    (Credentials::Password(_), Some(s)) => s.password_refused(),
                    _ => None,
                };
                return Err(SshError::AuthFailed(refused.unwrap_or(message)));
            }
            Err(e) => return Err(e),
        };
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        drop(handle);
        // A clean end: russh sends the disconnect and closes the socket itself.
        if let Some(s) = socket.as_mut() {
            s.armed = false;
        }
        emit(ConnectEvent::Status {
            state: ConnectState::Connected,
        });
        let prompts = shared.prompt_time.lock().map(|t| *t).unwrap_or_default();
        let elapsed = started.elapsed().saturating_sub(prompts);
        Ok(HostTestResult {
            address: format!("{}@{}:{}", target.username, target.hostname, target.port),
            auth_kind: target.auth_kind(),
            secret_source: source.as_ref().map(Source::public),
            duration_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
        })
    }
}

fn provided_or_stored(
    secrets: &SecretStore,
    target: &Target,
    kind: SecretKind,
    variable: Option<&VarKey>,
    registered: Option<&KeyPassKey>,
    credential: Option<Credential>,
    purpose: Purpose,
) -> Result<Resolved, SshError> {
    if let Some(c) = credential {
        let remember = c
            .remember
            .then(|| (kind, SecretString::from(c.secret.expose_secret())));
        return Ok(Resolved {
            value: c.secret,
            remember,
            source: Source::Typed,
        });
    }
    if let Some(key) = variable
        && let Some(value) = secrets.get_var(key)?
    {
        return Ok(Resolved {
            value,
            remember: None,
            source: Source::Variable(key.name().to_owned()),
        });
    }
    let bound = target.bound_to(kind);
    let saved = match (&target.saved, purpose) {
        (None, _) => None,
        (Some(key), Purpose::Connect) => secrets.get_saved(key, kind, &bound)?,
        (Some(key), Purpose::Test) => secrets.peek_saved(key, kind, &bound)?,
    };
    if let Some(value) = saved {
        return Ok(Resolved {
            value,
            remember: None,
            source: Source::Saved,
        });
    }
    if let Some(key) = registered
        && let Some(value) = secrets.get_key_passphrase(key)?
    {
        return Ok(Resolved {
            value,
            remember: None,
            source: Source::Key,
        });
    }
    Err(SshError::SecretRequired)
}

/// Drops a saved secret the server or the key file rejected, unless it was replaced meanwhile.
/// Secret variables are never dropped: the user manages them and other hosts may share them.
fn forget_if_unchanged(
    secrets: &SecretStore,
    target: &Target,
    kind: SecretKind,
    rejected: &SecretString,
) {
    let Some(saved) = &target.saved else {
        return;
    };
    let bound = target.bound_to(kind);
    if secrets
        .forget_saved_if_unchanged(saved, kind, &bound, rejected)
        .is_err()
    {
        log::warn!(
            "could not delete the rejected {kind} of connection {} from the keychain",
            target.connection_id
        );
    }
}

/// One bounded handle on a regular file; host key paths may be links (`~/.ssh/id` pointing
/// elsewhere), so they are followed.
fn read_key_file(key_path: &str) -> Result<Zeroizing<String>, SshError> {
    use std::io::ErrorKind;
    let path = crate::fsutil::expand_local(key_path).ok_or_else(|| {
        SshError::InvalidInput(crate::text!(
            "errors.ssh.keyPathInvalid",
            "the private key path must be absolute or start with ~/"
        ))
    })?;
    match crate::fsutil::read_regular_capped(&path, crate::keys::MAX_KEY_FILE_BYTES, true) {
        Ok(mut raw) => String::from_utf8(std::mem::take(&mut *raw))
            .map(Zeroizing::new)
            .map_err(|e| {
                drop(Zeroizing::new(e.into_bytes()));
                unparseable_key()
            }),
        Err(e) if e.kind() == ErrorKind::InvalidInput => Err(SshError::InvalidInput(crate::text!(
            "errors.ssh.keyNotRegular",
            "the private key path is not a regular file"
        ))),
        Err(e) if e.kind() == ErrorKind::FileTooLarge => Err(SshError::InvalidInput(crate::text!(
            "errors.ssh.keyTooLarge",
            "the private key file is too large"
        ))),
        Err(_) => Err(SshError::Io),
    }
}

/// The remembered passphrase of the registered key the file's public header matches.
fn registered_for<'a>(text: &str, registered: &'a [RegisteredKey]) -> Option<&'a KeyPassKey> {
    if registered.is_empty() {
        return None;
    }
    let public = russh::keys::ssh_key::PrivateKey::from_openssh(text).ok()?;
    let fingerprint = public.public_key().fingerprint(HashAlg::Sha256).to_string();
    registered
        .iter()
        .find(|r| r.fingerprint == fingerprint)
        .map(|r| &r.passphrase)
}

fn unparseable_key() -> SshError {
    SshError::InvalidInput(crate::text!(
        "errors.ssh.keyUnparseable",
        "the private key file could not be parsed"
    ))
}

/// Keychain and key file reads block; they run off the async workers. A cancelled test drops
/// the join handle and lets the read finish on its own (it only reads).
async fn load_blocking(
    secrets: &SecretStore,
    target: &Target,
    credential: Option<Credential>,
    purpose: Purpose,
) -> Result<Loaded, SshError> {
    let (secrets, target) = (secrets.clone(), target.clone());
    tokio::task::spawn_blocking(move || load_credentials(&secrets, &target, credential, purpose))
        .await
        .map_err(|_| SshError::Io)?
}

/// Resolves everything authentication needs before any network traffic.
fn load_credentials(
    secrets: &SecretStore,
    target: &Target,
    credential: Option<Credential>,
    purpose: Purpose,
) -> Result<Loaded, SshError> {
    use russh::keys::Error as KeyError;
    match &target.auth {
        TargetAuth::Agent => Ok(Loaded {
            credentials: Credentials::Agent,
            remember: None,
            source: None,
        }),
        TargetAuth::Password { variable } => {
            let r = provided_or_stored(
                secrets,
                target,
                SecretKind::Password,
                variable.as_ref(),
                None,
                credential,
                purpose,
            )?;
            Ok(Loaded {
                credentials: Credentials::Password(r.value),
                remember: r.remember,
                source: Some(r.source),
            })
        }
        TargetAuth::Key {
            key_path,
            passphrase,
            registered,
        } => {
            let text = read_key_file(key_path)?;
            let remembered = registered_for(&text, registered);
            let (key, remember, source) = match russh::keys::decode_secret_key(&text, None) {
                Ok(key) => (key, None, None),
                Err(KeyError::KeyIsEncrypted) => {
                    let r = provided_or_stored(
                        secrets,
                        target,
                        SecretKind::Passphrase,
                        passphrase.as_ref(),
                        remembered,
                        credential,
                        purpose,
                    )?;
                    match russh::keys::decode_secret_key(&text, Some(r.value.expose_secret())) {
                        Ok(key) => (key, r.remember, Some(r.source)),
                        Err(KeyError::IO(_)) => return Err(SshError::Io),
                        Err(_) => {
                            if purpose == Purpose::Connect && r.source == Source::Saved {
                                forget_if_unchanged(
                                    secrets,
                                    target,
                                    SecretKind::Passphrase,
                                    &r.value,
                                );
                            }
                            let refused = match purpose {
                                Purpose::Connect => None,
                                Purpose::Test => r.source.passphrase_refused(),
                            };
                            return Err(match refused {
                                Some(text) => SshError::PassphraseRefused(text),
                                None => SshError::InvalidPassphrase,
                            });
                        }
                    }
                }
                Err(KeyError::IO(_)) => return Err(SshError::Io),
                Err(_) => return Err(unparseable_key()),
            };
            Ok(Loaded {
                credentials: Credentials::Key(Arc::new(key)),
                remember,
                source,
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
    let failed = || {
        SshError::AuthFailed(crate::text!(
            "errors.ssh.authRefused",
            "authentication was refused by the server"
        ))
    };
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
                SshError::AuthFailed(crate::text!(
                    "errors.ssh.agentListFailed",
                    "the SSH agent could not list its keys"
                ))
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
    let unavailable = || {
        SshError::AuthFailed(crate::text!(
            "errors.ssh.agentUnavailable",
            "no SSH agent is available"
        ))
    };
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
