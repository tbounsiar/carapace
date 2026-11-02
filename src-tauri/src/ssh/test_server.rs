//! In-process russh server on 127.0.0.1 for unit tests: accepts any public key and one
//! password, runs a fake shell that echoes its input, and serves an in-memory SFTP subsystem.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::PrivateKey;
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::server::{self, Msg, Session};
use russh::{Channel, ChannelId};

use super::known_hosts::KnownHosts;
use super::manager::{Emit, Timeouts};
use super::test_sftp::{MemFs, MemSftp};
use super::{SshError, SshManager};
use crate::config::Host;
use crate::config::model::AuthMethod;
use crate::secrets::{MemoryBackend, SecretScope};

pub struct TestServer {
    pub key: PrivateKey,
    pub port: u16,
    shared: Shared,
}

#[derive(Clone, Default)]
struct Shared {
    clients: Arc<Mutex<Vec<server::Handle>>>,
    closed_channels: Arc<AtomicUsize>,
    flood_sent: Arc<AtomicUsize>,
    sftp_opens: Arc<AtomicUsize>,
    fs: MemFs,
}

impl TestServer {
    /// Channels the client has closed.
    pub fn closed_channels(&self) -> usize {
        self.shared.closed_channels.load(Ordering::SeqCst)
    }

    /// Bytes of the `SHELL_FLOOD` output the server managed to send so far.
    pub fn flood_sent(&self) -> usize {
        self.shared.flood_sent.load(Ordering::SeqCst)
    }

    /// SFTP subsystem channels opened so far.
    pub fn sftp_opens(&self) -> usize {
        self.shared.sftp_opens.load(Ordering::SeqCst)
    }

    /// The tree served over SFTP, shared by every connection.
    pub fn fs(&self) -> &MemFs {
        &self.shared.fs
    }

    /// Ends every client connection from the server side, as a dropped link would.
    pub async fn drop_clients(&self) {
        let clients: Vec<_> = self.shared.clients.lock().unwrap().drain(..).collect();
        for c in clients {
            let _ = c
                .disconnect(russh::Disconnect::ByApplication, String::new(), "en".into())
                .await;
        }
    }
}

pub const SERVER_PASSWORD: &str = "right-password";

/// Typing this into the fake shell makes it exit with `SHELL_EXIT_CODE`.
pub const SHELL_EXIT: &[u8] = b"exit\n";
pub const SHELL_EXIT_CODE: u32 = 3;
/// Typing this makes the fake shell send `FLOOD_BYTES` of numbered lines (`flood_line`) as fast
/// as the client accepts them.
pub const SHELL_FLOOD: &[u8] = b"flood
";
pub const FLOOD_BYTES: usize = 16 * 1024 * 1024;

pub fn flood_line(i: usize) -> String {
    format!(
        "{i:015}
"
    )
}

/// Longer than the keychain accepts, so it can be used but never stored.
pub fn long_password() -> String {
    "x".repeat(crate::secrets::MAX_SECRET_UTF16_UNITS + 1)
}

struct AcceptAll {
    shared: Shared,
    /// Kept only until the channel's purpose is known: a held `Channel` that nobody reads would
    /// fill its buffer and stall the server session (the shell tests flood it).
    channels: HashMap<ChannelId, Channel<Msg>>,
    /// SFTP channels, whose data belongs to the subsystem and must not reach the fake shell.
    sftp: HashSet<ChannelId>,
}

impl server::Handler for AcceptAll {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        _user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(
            if password == SERVER_PASSWORD || password == long_password() {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: server::VerifiedPublicKey<'_>,
    ) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shared.clients.lock().unwrap().push(session.handle());
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.remove(&channel);
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.remove(&channel);
        session.channel_success(channel)
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        match self.channels.remove(&channel) {
            Some(c) if name == "sftp" => {
                self.shared.sftp_opens.fetch_add(1, Ordering::SeqCst);
                self.sftp.insert(channel);
                session.channel_success(channel)?;
                russh_sftp::server::run(c.into_stream(), MemSftp::new(self.shared.fs.clone()))
                    .await;
                Ok(())
            }
            _ => session.channel_failure(channel),
        }
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.sftp.contains(&channel) {
            return Ok(());
        }
        if data == SHELL_FLOOD {
            let handle = session.handle();
            let sent = self.shared.flood_sent.clone();
            tokio::spawn(async move {
                let mut i = 0;
                while sent.load(Ordering::SeqCst) < FLOOD_BYTES {
                    let mut chunk = String::new();
                    while chunk.len() < 16 * 1024 {
                        chunk.push_str(&flood_line(i));
                        i += 1;
                    }
                    let len = chunk.len();
                    if handle.data(channel, chunk.into_bytes()).await.is_err() {
                        return;
                    }
                    sent.fetch_add(len, Ordering::SeqCst);
                }
            });
            return Ok(());
        }
        if data == SHELL_EXIT {
            session.exit_status_request(channel, SHELL_EXIT_CODE)?;
            session.eof(channel)?;
            return session.close(channel);
        }
        session.data(channel, data.to_vec())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shared.closed_channels.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, format!("resized {col_width}x{row_height}\n"))
    }
}

pub fn ed25519(seed: u8) -> PrivateKey {
    let pair = Ed25519Keypair::from_seed(&[seed; 32]);
    PrivateKey::new(KeypairData::Ed25519(pair), "").unwrap()
}

pub async fn start_server(seed: u8) -> TestServer {
    let key = ed25519(seed);
    let config = Arc::new(server::Config {
        keys: vec![key.clone()],
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::from_millis(1)),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared = Shared::default();
    let accepted = shared.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone();
            let handler = AcceptAll {
                shared: accepted.clone(),
                channels: HashMap::new(),
                sftp: HashSet::new(),
            };
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, socket, handler).await {
                    let _ = session.await;
                }
            });
        }
    });
    TestServer { key, port, shared }
}

/// An `SshManager` that trusts `server`, with a key-authenticated host `host_id` pointing at it.
pub struct Connected {
    pub _dir: tempfile::TempDir,
    pub manager: SshManager,
    pub host: Host,
}

impl Connected {
    pub async fn connect(&self) -> Result<(), SshError> {
        let emit: Emit = Arc::new(|_| {});
        let scope = SecretScope::new(
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
            "00000000-0000-4000-8000-000000000003",
        )
        .unwrap();
        self.manager
            .connect(&scope, &self.host, None, &|| true, emit)
            .await
            .map(|_| ())
    }
}

/// Rotating the e2e sshd host key affects every e2e test, so rotation takes this for writing.
pub static E2E_SERVER: std::sync::LazyLock<tokio::sync::RwLock<()>> =
    std::sync::LazyLock::new(|| tokio::sync::RwLock::new(()));

/// A manager whose known_hosts files (app and user) live in `dir` and start empty.
pub fn isolated_manager(dir: &Path) -> SshManager {
    let (secrets, _) = MemoryBackend::store();
    SshManager::with_parts(
        KnownHosts::new(dir.join("known_hosts"), Some(dir.join("user_known_hosts"))),
        Timeouts {
            connect: Duration::from_secs(10),
            prompt: Duration::from_secs(20),
        },
        secrets,
    )
}

pub fn manager_for(server: &TestServer, host_id: &str) -> Connected {
    let dir = tempfile::tempdir().unwrap();
    KnownHosts::new(dir.path().join("known_hosts"), None)
        .trust("127.0.0.1", server.port, server.key.public_key())
        .unwrap();
    let manager = isolated_manager(dir.path());
    let host = Host {
        id: host_id.into(),
        name: host_id.into(),
        hostname: "127.0.0.1".into(),
        port: server.port,
        username: "me".into(),
        auth: key_file(dir.path()),
    };
    Connected {
        _dir: dir,
        manager,
        host,
    }
}

fn key_file(dir: &Path) -> AuthMethod {
    let path = dir.join("id_ed25519");
    let pem = ed25519(9).to_openssh(LineEnding::LF).unwrap();
    std::fs::write(&path, pem.as_bytes()).unwrap();
    AuthMethod::Key {
        key_path: path.to_string_lossy().into_owned(),
    }
}
