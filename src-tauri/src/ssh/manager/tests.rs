use super::*;
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::server;
use tokio::sync::mpsc;

struct TestServer {
    key: PrivateKey,
    port: u16,
}

struct AcceptAll;

impl server::Handler for AcceptAll {
    type Error = russh::Error;

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: server::VerifiedPublicKey<'_>,
    ) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
}

fn ed25519(seed: u8) -> PrivateKey {
    let pair = Ed25519Keypair::from_seed(&[seed; 32]);
    PrivateKey::new(KeypairData::Ed25519(pair), "").unwrap()
}

async fn start_server(seed: u8) -> TestServer {
    let key = ed25519(seed);
    let config = Arc::new(server::Config {
        keys: vec![key.clone()],
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::from_millis(1)),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, socket, AcceptAll).await {
                    let _ = session.await;
                }
            });
        }
    });
    TestServer { key, port }
}

struct Env {
    _dir: tempfile::TempDir,
    manager: Arc<SshManager>,
    host: Host,
    app_known_hosts: PathBuf,
}

fn env(port: u16, prompt: Duration, auth: impl FnOnce(&Path) -> AuthMethod) -> Env {
    env_with(port, Duration::from_secs(5), prompt, auth)
}

fn env_with(
    port: u16,
    connect: Duration,
    prompt: Duration,
    auth: impl FnOnce(&Path) -> AuthMethod,
) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let app_known_hosts = dir.path().join("known_hosts");
    let user_file = dir.path().join("user_known_hosts");
    let manager = Arc::new(SshManager::with_parts(
        KnownHosts::new(app_known_hosts.clone(), Some(user_file)),
        Timeouts { connect, prompt },
    ));
    let host = Host {
        id: "h1".into(),
        name: "h".into(),
        hostname: "127.0.0.1".into(),
        port,
        username: "me".into(),
        auth: auth(dir.path()),
    };
    Env {
        _dir: dir,
        manager,
        host,
        app_known_hosts,
    }
}

fn key_auth(dir: &Path) -> AuthMethod {
    let path = dir.join("id_ed25519");
    let pem = ed25519(9).to_openssh(LineEnding::LF).unwrap();
    std::fs::write(&path, pem.as_bytes()).unwrap();
    AuthMethod::Key {
        key_path: path.to_string_lossy().into_owned(),
    }
}

type Events = mpsc::UnboundedReceiver<ConnectEvent>;
type ConnectTask = tokio::task::JoinHandle<Result<ConnectionInfo, SshError>>;

fn start_connect(env: &Env) -> (ConnectTask, Events) {
    let (tx, rx) = mpsc::unbounded_channel();
    let emit: Emit = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let manager = env.manager.clone();
    let host = env.host.clone();
    (
        tokio::spawn(async move { manager.connect(&host, emit).await }),
        rx,
    )
}

async fn next_prompt(rx: &mut Events) -> (String, PromptStatus) {
    loop {
        match rx.recv().await.expect("connect ended without a prompt") {
            ConnectEvent::HostKeyPrompt {
                request_id, status, ..
            } => return (request_id, status),
            ConnectEvent::Status { .. } => {}
            other => panic!("unexpected {other:?}"),
        }
    }
}

fn assert_no_prompt(rx: &mut Events) {
    while let Ok(e) = rx.try_recv() {
        assert!(matches!(e, ConnectEvent::Status { .. }));
    }
}

fn drain(rx: &mut Events) -> Vec<ConnectEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

#[tokio::test]
async fn unknown_key_accepted_then_remembered() {
    let server = start_server(1).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);

    let (task, mut rx) = start_connect(&env);
    let (id, status) = next_prompt(&mut rx).await;
    assert_eq!(status, PromptStatus::Unknown);
    env.manager.answer_host_key(&id, true).unwrap();
    let info = task.await.unwrap().unwrap();
    assert_eq!(info.host_id, "h1");
    assert_eq!(env.manager.list().await, vec![info]);
    let stored = std::fs::read_to_string(&env.app_known_hosts).unwrap();
    assert!(stored.starts_with(&format!("[127.0.0.1]:{} ssh-ed25519 ", server.port)));
    assert!(env.manager.pending.lock().unwrap().is_empty());

    let (task, mut rx) = start_connect(&env);
    assert!(task.await.unwrap().is_ok());
    assert_no_prompt(&mut rx);

    env.manager.disconnect("h1").await.unwrap();
    assert!(env.manager.list().await.is_empty());

    let (task, mut rx) = start_connect(&env);
    assert!(task.await.unwrap().is_ok());
    assert_no_prompt(&mut rx);
}

#[tokio::test]
async fn rejected_key_fails_and_is_not_stored() {
    let server = start_server(2).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let (task, mut rx) = start_connect(&env);
    let (id, _) = next_prompt(&mut rx).await;
    env.manager.answer_host_key(&id, false).unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyRejected);
    assert!(!env.app_known_hosts.exists());
    assert!(env.manager.list().await.is_empty());
}

#[tokio::test]
async fn unanswered_prompt_times_out_as_rejected_and_cleans_up() {
    let server = start_server(3).await;
    let env = env(server.port, Duration::from_millis(200), key_auth);
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::Timeout);
    assert!(!env.app_known_hosts.exists());
    assert!(env.manager.pending.lock().unwrap().is_empty());
    assert_eq!(
        env.manager.answer_host_key("gone", true).unwrap_err(),
        SshError::NotFound("host key request")
    );
}

#[tokio::test]
async fn changed_key_fails_without_prompt_and_replace_needs_the_fingerprint() {
    let server = start_server(4).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let old = ed25519(77).public_key().clone();
    env.manager
        .known_hosts
        .trust("127.0.0.1", server.port, &old)
        .unwrap();
    let before = std::fs::read_to_string(&env.app_known_hosts).unwrap();

    let (task, mut rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyChanged);
    let new_fp = fingerprint(server.key.public_key());
    let events = drain(&mut rx);
    assert!(events.iter().any(|e| matches!(
        e,
        ConnectEvent::HostKeyChanged { fingerprint, known_fingerprints, .. }
            if *fingerprint == new_fp && *known_fingerprints == vec![fingerprint_of(&old)]
    )));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ConnectEvent::HostKeyPrompt { .. }))
    );
    assert!(env.manager.pending.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(&env.app_known_hosts).unwrap(),
        before
    );

    let wrong = fingerprint(&old);
    assert_eq!(
        env.manager
            .replace_host_key("h1", &wrong)
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        std::fs::read_to_string(&env.app_known_hosts).unwrap(),
        before
    );
    assert_eq!(
        env.manager.replace_host_key("other", &new_fp).unwrap_err(),
        SshError::NotFound("host key")
    );

    env.manager.replace_host_key("h1", &new_fp).unwrap();
    assert_eq!(
        env.manager.replace_host_key("h1", &new_fp).unwrap_err(),
        SshError::NotFound("host key")
    );
    let (task, mut rx) = start_connect(&env);
    assert!(task.await.unwrap().is_ok());
    assert_no_prompt(&mut rx);
}

fn fingerprint_of(key: &PublicKey) -> String {
    fingerprint(key)
}

#[tokio::test]
async fn revoked_key_fails_without_prompt_or_replace() {
    let server = start_server(5).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let blob = server.key.public_key().to_openssh().unwrap();
    std::fs::write(
        &env.app_known_hosts,
        format!("@revoked [127.0.0.1]:{} {blob}\n", server.port),
    )
    .unwrap();
    let (task, mut rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyRevoked);
    assert_no_prompt(&mut rx);
    assert_eq!(
        env.manager
            .replace_host_key("h1", &fingerprint(server.key.public_key()))
            .unwrap_err(),
        SshError::NotFound("host key")
    );
}

#[tokio::test]
async fn orphaned_prompt_answered_after_connect_ended_writes_nothing() {
    let server = start_server(6).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let (task, mut rx) = start_connect(&env);
    let (id, _) = next_prompt(&mut rx).await;
    task.abort();
    let _ = task.await;
    assert_eq!(
        env.manager.answer_host_key(&id, true).unwrap_err(),
        SshError::NotFound("host key request")
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!env.app_known_hosts.exists());
    assert!(env.manager.list().await.is_empty());
}

#[tokio::test]
async fn prompt_may_outlast_the_connect_timeout() {
    let server = start_server(7).await;
    let env = env_with(
        server.port,
        Duration::from_millis(300),
        Duration::from_secs(10),
        key_auth,
    );
    let (task, mut rx) = start_connect(&env);
    let (id, _) = next_prompt(&mut rx).await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    env.manager.answer_host_key(&id, true).unwrap();
    assert!(task.await.unwrap().is_ok());
}

#[tokio::test]
async fn password_and_unreadable_keys_fail_before_any_network() {
    let env = env(1, Duration::from_secs(1), |_| AuthMethod::Password);
    let emit: Emit = Arc::new(|_| {});
    let err = env.manager.connect(&env.host, emit).await.unwrap_err();
    assert_eq!(err.code(), "unsupported");

    let missing = AuthMethod::Key {
        key_path: "does-not-exist".into(),
    };
    assert_eq!(load_credentials(&missing).err(), Some(SshError::Io));
}

#[tokio::test]
async fn refused_connection_maps_to_network() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let env = env(port, Duration::from_secs(1), key_auth);
    let emit: Emit = Arc::new(|_| {});
    let err = env.manager.connect(&env.host, emit).await.unwrap_err();
    assert_eq!(err, SshError::Network);
}

#[test]
fn events_serialize_as_contract() {
    let v = serde_json::to_value(ConnectEvent::HostKeyPrompt {
        request_id: "r".into(),
        status: PromptStatus::Unknown,
        hostname: "h".into(),
        port: 22,
        algorithm: "ssh-ed25519".into(),
        fingerprint: "SHA256:x".into(),
    })
    .unwrap();
    assert_eq!(v["kind"], "hostKeyPrompt");
    assert_eq!(v["requestId"], "r");
    assert_eq!(v["status"], "unknown");
    let v = serde_json::to_value(ConnectEvent::HostKeyChanged {
        hostname: "h".into(),
        port: 22,
        algorithm: "ssh-ed25519".into(),
        fingerprint: "SHA256:x".into(),
        known_fingerprints: vec!["SHA256:y".into()],
    })
    .unwrap();
    assert_eq!(v["kind"], "hostKeyChanged");
    assert_eq!(v["knownFingerprints"][0], "SHA256:y");
    let v = serde_json::to_value(ConnectEvent::Status {
        state: ConnectState::Authenticating,
    })
    .unwrap();
    assert_eq!(v["kind"], "status");
    assert_eq!(v["state"], "authenticating");
    let v = serde_json::to_value(ConnectionInfo {
        host_id: "a".into(),
        state: ConnectState::Connected,
    })
    .unwrap();
    assert_eq!(v["hostId"], "a");
    assert_eq!(v["state"], "connected");
}
