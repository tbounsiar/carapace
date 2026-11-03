use std::collections::HashMap;
use std::path::Path;
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
use crate::secrets::{KeyPassKey, SavedKey, SecretKind, SecretStore, VarKey, fits_saved};

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
    pub environment_id: Option<String>,
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

/// A host resolved for one environment (or none): what a connection is made from.
/// `project_id` is the host's scope (None: Home); it is part of the comparison done by
/// `still_current`, so a host moved to another scope during a connect is stale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub connection_id: String,
    pub host_id: String,
    pub project_id: Option<String>,
    pub environment_id: Option<String>,
    pub saved: SavedKey,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: TargetAuth,
}

impl Target {
    pub fn connection_id_of(host_id: &str, environment_id: Option<&str>) -> String {
        format!("{host_id}@{}", environment_id.unwrap_or("none"))
    }

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
            environment_id: self.environment_id.clone(),
            state: ConnectState::Connected,
        }
    }
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
    connection_id: String,
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
            Err(SshError::UserKnownHostsUnreadable(kind)) => {
                self.shared
                    .reject(Rejection::UserKnownHostsUnreadable(kind));
                return Ok(false);
            }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Typed,
    Variable,
    Saved,
    Key,
}

struct Loaded {
    credentials: Credentials,
    remember: Option<(SecretKind, SecretString)>,
    source: Source,
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
    pub fn replace_host_key(&self, connection_id: &str, fingerprint: &str) -> Result<(), SshError> {
        let mut map = self.changed.lock().map_err(|_| SshError::Io)?;
        let entry = map
            .get(connection_id)
            .ok_or(SshError::NotFound("host key"))?;
        if self::fingerprint(&entry.key) != fingerprint {
            return Err(SshError::InvalidInput(
                "the fingerprint does not match the presented host key".into(),
            ));
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
    pub async fn connect(
        &self,
        target: &Target,
        credential: Option<Credential>,
        still_current: StillCurrent<'_>,
        emit: Emit,
    ) -> Result<ConnectionInfo, SshError> {
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
                Some(c) if c.is_live() => return Ok(info),
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
        } = load_credentials(&self.secrets, target, credential)?;
        if let Ok(mut map) = self.changed.lock() {
            map.remove(&target.connection_id);
        }
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

        let ended: EndSignal = Arc::new(watch::channel(None).0);
        let shared = Arc::new(Shared::default());
        let _end = ConnectGuard {
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
            authenticate(&mut handle, &target.username, &credentials),
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
            if let (SshError::AuthFailed(_), Source::Saved, Credentials::Password(p)) =
                (&e, source, &credentials)
            {
                forget_if_unchanged(&self.secrets, target, SecretKind::Password, p);
            }
            return Err(e);
        }

        // The host-key prompt can last minutes; the host may have been edited, moved or deleted
        // meanwhile. Checked under the lifecycle lock, which deletes and moves hold while they
        // change the config and the keychain, and with the sessions lock held until the insert:
        // a delete or move that ran before the check makes it fail, one that runs after it
        // finds the session when it closes the host's connections.
        let mut sessions = self.sessions.lock().await;
        let current = {
            let _lifecycle = self.secrets.lifecycle();
            let current = still_current();
            if current && let Some((kind, secret)) = remember {
                let bound = target.bound_to(kind);
                if fits_saved(&bound, &secret)
                    && self
                        .secrets
                        .set_saved(&target.saved, kind, &bound, &secret)
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
        sessions.insert(
            target.connection_id.clone(),
            Connection {
                handle: Arc::new(handle),
                ended,
                info: info.clone(),
            },
        );
        emit(ConnectEvent::Status {
            state: ConnectState::Connected,
        });
        Ok(info)
    }
}

fn provided_or_stored(
    secrets: &SecretStore,
    target: &Target,
    kind: SecretKind,
    variable: Option<&VarKey>,
    registered: Option<&KeyPassKey>,
    credential: Option<Credential>,
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
            source: Source::Variable,
        });
    }
    if let Some(value) = secrets.get_saved(&target.saved, kind, &target.bound_to(kind))? {
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
    let bound = target.bound_to(kind);
    if secrets
        .forget_saved_if_unchanged(&target.saved, kind, &bound, rejected)
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
    let path = crate::fsutil::expand_tilde(key_path);
    match crate::fsutil::read_regular_capped(&path, crate::keys::MAX_KEY_FILE_BYTES, true) {
        Ok(mut raw) => String::from_utf8(std::mem::take(&mut *raw))
            .map(Zeroizing::new)
            .map_err(|e| {
                drop(Zeroizing::new(e.into_bytes()));
                unparseable_key()
            }),
        Err(e) if e.kind() == ErrorKind::InvalidInput => Err(SshError::InvalidInput(
            "the private key path is not a regular file".into(),
        )),
        Err(e) if e.kind() == ErrorKind::FileTooLarge => Err(SshError::InvalidInput(
            "the private key file is too large".into(),
        )),
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
    SshError::InvalidInput("the private key file could not be parsed".into())
}

/// Resolves everything authentication needs before any network traffic.
fn load_credentials(
    secrets: &SecretStore,
    target: &Target,
    credential: Option<Credential>,
) -> Result<Loaded, SshError> {
    use russh::keys::Error as KeyError;
    match &target.auth {
        TargetAuth::Agent => Ok(Loaded {
            credentials: Credentials::Agent,
            remember: None,
            source: Source::Typed,
        }),
        TargetAuth::Password { variable } => {
            let r = provided_or_stored(
                secrets,
                target,
                SecretKind::Password,
                variable.as_ref(),
                None,
                credential,
            )?;
            Ok(Loaded {
                credentials: Credentials::Password(r.value),
                remember: r.remember,
                source: r.source,
            })
        }
        TargetAuth::Key {
            key_path,
            passphrase,
            registered,
        } => {
            let text = read_key_file(key_path)?;
            let remembered = registered_for(&text, registered);
            let (key, remember) = match russh::keys::decode_secret_key(&text, None) {
                Ok(key) => (key, None),
                Err(KeyError::KeyIsEncrypted) => {
                    let r = provided_or_stored(
                        secrets,
                        target,
                        SecretKind::Passphrase,
                        passphrase.as_ref(),
                        remembered,
                        credential,
                    )?;
                    match russh::keys::decode_secret_key(&text, Some(r.value.expose_secret())) {
                        Ok(key) => (key, r.remember),
                        Err(KeyError::IO(_)) => return Err(SshError::Io),
                        Err(_) => {
                            if r.source == Source::Saved {
                                forget_if_unchanged(
                                    secrets,
                                    target,
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
                source: Source::Typed,
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
