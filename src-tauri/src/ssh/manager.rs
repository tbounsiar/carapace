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
use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::time::timeout;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::error::SshError;
use super::known_hosts::{HostKeyStatus, KnownHosts, fingerprint};
use crate::config::Host;
use crate::config::model::AuthMethod;

pub type Emit = Arc<dyn Fn(ConnectEvent) + Send + Sync>;

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

struct ClientHandler {
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
    Agent,
}

type Session = Arc<Handle<ClientHandler>>;

pub struct SshManager {
    known_hosts: Arc<KnownHosts>,
    timeouts: Timeouts,
    sessions: tokio::sync::Mutex<HashMap<String, Session>>,
    host_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pending: Pending,
    changed: ChangedKeys,
}

impl SshManager {
    pub fn new(config_dir: &Path) -> Self {
        let user_file = std::env::home_dir().map(|h| h.join(".ssh").join("known_hosts"));
        Self::with_parts(
            KnownHosts::new(config_dir.join("known_hosts"), user_file),
            Timeouts::default(),
        )
    }

    pub fn with_parts(known_hosts: KnownHosts, timeouts: Timeouts) -> Self {
        Self {
            known_hosts: Arc::new(known_hosts),
            timeouts,
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
        let session = self.sessions.lock().await.remove(host_id);
        if let Some(session) = session {
            let _ = session
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
        Ok(())
    }

    pub async fn list(&self) -> Vec<ConnectionInfo> {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, s| !s.is_closed());
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

    pub async fn connect(&self, host: &Host, emit: Emit) -> Result<ConnectionInfo, SshError> {
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
                Some(s) if !s.is_closed() => return Ok(info),
                Some(_) => {
                    sessions.remove(&host.id);
                }
                None => {}
            }
        }

        let credentials = load_credentials(&host.auth)?;
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

        let shared = Arc::new(Shared::default());
        let _end = ConnectGuard {
            shared: shared.clone(),
            pending: self.pending.clone(),
        };
        let handler = ClientHandler {
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
            authenticate(&mut handle, &host.username, credentials),
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

        self.sessions
            .lock()
            .await
            .insert(host.id.clone(), Arc::new(handle));
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

fn load_credentials(auth: &AuthMethod) -> Result<Credentials, SshError> {
    match auth {
        AuthMethod::Password => Err(SshError::Unsupported(
            "password authentication is not available yet".into(),
        )),
        AuthMethod::Agent => Ok(Credentials::Agent),
        AuthMethod::Key { key_path } => {
            use russh::keys::Error as KeyError;
            let text = Zeroizing::new(match std::fs::read_to_string(expand_home(key_path)) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                    return Err(SshError::InvalidInput(
                        "the private key file could not be parsed".into(),
                    ));
                }
                Err(_) => return Err(SshError::Io),
            });
            match russh::keys::decode_secret_key(&text, None) {
                Ok(key) => Ok(Credentials::Key(Arc::new(key))),
                Err(KeyError::KeyIsEncrypted) => Err(SshError::Unsupported(
                    "passphrase-protected keys are not available yet".into(),
                )),
                Err(KeyError::IO(_)) => Err(SshError::Io),
                Err(_) => Err(SshError::InvalidInput(
                    "the private key file could not be parsed".into(),
                )),
            }
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
    credentials: Credentials,
) -> Result<(), SshError> {
    let failed = || SshError::AuthFailed("authentication was refused by the server".into());
    match credentials {
        Credentials::Key(key) => {
            let hash = rsa_hash(handle, key.public_key()).await;
            let key = PrivateKeyWithHashAlg::new(key, hash);
            match handle.authenticate_publickey(username, key).await {
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
