use std::path::PathBuf;

use super::*;
use crate::secrets::MemoryBackend;
use crate::ssh::test_server::*;
use russh::keys::ssh_key::LineEnding;
use tokio::sync::mpsc;

struct Env {
    _dir: tempfile::TempDir,
    manager: Arc<SshManager>,
    target: Target,
    app_known_hosts: PathBuf,
    secrets: SecretStore,
    mem: Arc<MemoryBackend>,
}

fn env(port: u16, prompt: Duration, auth: impl FnOnce(&Path) -> TargetAuth) -> Env {
    env_with(port, Duration::from_secs(5), prompt, auth)
}

fn env_with(
    port: u16,
    connect: Duration,
    prompt: Duration,
    auth: impl FnOnce(&Path) -> TargetAuth,
) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let app_known_hosts = dir.path().join("known_hosts");
    let user_file = dir.path().join("user_known_hosts");
    let (secrets, mem) = MemoryBackend::store();
    let manager = Arc::new(SshManager::with_parts(
        KnownHosts::new(app_known_hosts.clone(), Some(user_file)),
        Timeouts { connect, prompt },
        secrets.clone(),
    ));
    let target = target("h1", port, "me", auth(dir.path()));
    Env {
        _dir: dir,
        manager,
        target,
        app_known_hosts,
        secrets,
        mem,
    }
}

fn key_auth(dir: &Path) -> TargetAuth {
    let path = dir.join("id_ed25519");
    let pem = ed25519(9).to_openssh(LineEnding::LF).unwrap();
    std::fs::write(&path, pem.as_bytes()).unwrap();
    TargetAuth::Key {
        key_path: path.to_string_lossy().into_owned(),
        passphrase: None,
        registered: Vec::new(),
    }
}

type Events = mpsc::UnboundedReceiver<ConnectEvent>;
type ConnectTask = tokio::task::JoinHandle<Result<ConnectionInfo, SshError>>;

fn start_connect(env: &Env) -> (ConnectTask, Events) {
    start_connect_with(env, None)
}

fn start_connect_with(env: &Env, credential: Option<Credential>) -> (ConnectTask, Events) {
    spawn_connect(env, credential, true)
}

fn spawn_connect(
    env: &Env,
    credential: Option<Credential>,
    current: bool,
) -> (ConnectTask, Events) {
    let (tx, rx) = mpsc::unbounded_channel();
    let emit: Emit = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let manager = env.manager.clone();
    let target = env.target.clone();
    (
        tokio::spawn(async move {
            let current = move || current;
            manager.connect(&target, credential, &current, emit).await
        }),
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
    assert_eq!(info.connection_id, "h1");
    assert_eq!(info.host_id, TEST_HOST_ID);
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
async fn unreadable_user_known_hosts_fails_without_prompt() {
    let server = start_server(21).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    std::fs::create_dir(env._dir.path().join("user_known_hosts")).unwrap();
    let (task, mut rx) = start_connect(&env);
    let err = task.await.unwrap().unwrap_err();
    assert!(matches!(err, SshError::UserKnownHostsUnreadable(_)));
    assert_eq!(err.code(), "io");
    assert_no_prompt(&mut rx);
    assert!(!env.app_known_hosts.exists());
    assert!(env.manager.list().await.is_empty());
}

#[tokio::test]
async fn user_known_hosts_with_a_bad_line_still_reports_a_changed_key() {
    let server = start_server(22).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let old = ed25519(78).public_key().to_openssh().unwrap();
    let mut content = b"\xff\xfe not utf-8\n".to_vec();
    content.extend_from_slice(format!("[127.0.0.1]:{} {old}\n", server.port).as_bytes());
    std::fs::write(env._dir.path().join("user_known_hosts"), content).unwrap();
    let (task, mut rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyChanged);
    assert!(
        !drain(&mut rx)
            .iter()
            .any(|e| matches!(e, ConnectEvent::HostKeyPrompt { .. }))
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

fn credential(secret: &str, remember: bool) -> Option<Credential> {
    Some(Credential {
        secret: SecretString::from(secret),
        remember,
    })
}

fn stored(env: &Env, kind: SecretKind) -> Option<String> {
    env.secrets
        .get_saved(&env.target.saved, kind, &env.target.bound_to(kind))
        .unwrap()
        .map(|s| s.expose_secret().to_owned())
}

fn store_secret(env: &Env, kind: SecretKind, value: &str) {
    env.secrets
        .set_saved(
            &env.target.saved,
            kind,
            &env.target.bound_to(kind),
            &SecretString::from(value),
        )
        .unwrap();
}

fn trust_server(env: &Env, server: &TestServer) {
    env.manager
        .known_hosts
        .trust("127.0.0.1", server.port, server.key.public_key())
        .unwrap();
}

const PASSPHRASE: &str = "correct horse";

fn encrypted_key_auth(dir: &Path) -> TargetAuth {
    let path = dir.join("id_ed25519_enc");
    let key = ed25519(9).encrypt(&mut rand::rng(), PASSPHRASE).unwrap();
    let pem = key.to_openssh(LineEnding::LF).unwrap();
    std::fs::write(&path, pem.as_bytes()).unwrap();
    TargetAuth::Key {
        key_path: path.to_string_lossy().into_owned(),
        passphrase: None,
        registered: Vec::new(),
    }
}

async fn connect_once(
    env: &Env,
    credential: Option<Credential>,
) -> Result<ConnectionInfo, SshError> {
    let (task, _rx) = start_connect_with(env, credential);
    task.await.unwrap()
}

fn load(env: &Env, credential: Option<Credential>) -> Result<Loaded, SshError> {
    load_credentials(&env.secrets, &env.target, credential)
}

#[tokio::test]
async fn typed_password_connects_and_is_stored_only_when_asked() {
    let server = start_server(10).await;
    let env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    trust_server(&env, &server);

    connect_once(&env, credential(SERVER_PASSWORD, false))
        .await
        .unwrap();
    assert!(env.mem.accounts().is_empty());
    env.manager.disconnect("h1").await.unwrap();

    connect_once(&env, credential(SERVER_PASSWORD, true))
        .await
        .unwrap();
    assert_eq!(
        stored(&env, SecretKind::Password).as_deref(),
        Some(SERVER_PASSWORD)
    );
    assert_eq!(
        env.mem.accounts(),
        vec![env.target.saved.account(SecretKind::Password)]
    );
}

#[tokio::test]
async fn stored_password_is_used_and_a_refused_one_is_auth_failed() {
    let server = start_server(11).await;
    let env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    trust_server(&env, &server);

    store_secret(&env, SecretKind::Password, SERVER_PASSWORD);
    connect_once(&env, None).await.unwrap();
    env.manager.disconnect("h1").await.unwrap();

    store_secret(&env, SecretKind::Password, "stale");
    let err = connect_once(&env, None).await.unwrap_err();
    assert_eq!(err.code(), "auth_failed");
    assert_eq!(stored(&env, SecretKind::Password), None);
    assert!(env.manager.list().await.is_empty());
}

#[tokio::test]
async fn refused_password_is_not_remembered() {
    let server = start_server(12).await;
    let env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    trust_server(&env, &server);
    let err = connect_once(&env, credential("wrong", true))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "auth_failed");
    assert!(env.mem.accounts().is_empty());
}

#[tokio::test]
async fn missing_password_is_secret_required_before_any_network() {
    let env = env(1, Duration::from_secs(1), |_| TargetAuth::Password {
        variable: None,
    });
    let (task, mut rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::SecretRequired);
    assert!(drain(&mut rx).is_empty());
}

#[tokio::test]
async fn unavailable_keychain_is_reported_unless_the_secret_is_typed() {
    let server = start_server(13).await;
    let env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    trust_server(&env, &server);
    env.mem.set_failing(true);
    assert_eq!(
        connect_once(&env, None).await.unwrap_err(),
        SshError::KeychainUnavailable
    );
    connect_once(&env, credential(SERVER_PASSWORD, true))
        .await
        .unwrap();
}

#[test]
fn encrypted_key_needs_the_right_passphrase() {
    let env = env(1, Duration::from_secs(1), encrypted_key_auth);
    assert_eq!(load(&env, None).err(), Some(SshError::SecretRequired));
    assert_eq!(
        load(&env, credential("nope", true)).err(),
        Some(SshError::InvalidPassphrase)
    );
    let loaded = load(&env, credential(PASSPHRASE, false)).unwrap();
    assert!(matches!(loaded.credentials, Credentials::Key(_)));
    assert!(loaded.remember.is_none());

    store_secret(&env, SecretKind::Passphrase, "stale");
    assert_eq!(load(&env, None).err(), Some(SshError::InvalidPassphrase));
    assert_eq!(stored(&env, SecretKind::Passphrase), None);
    assert_eq!(load(&env, None).err(), Some(SshError::SecretRequired));
    store_secret(&env, SecretKind::Passphrase, PASSPHRASE);
    assert!(load(&env, None).is_ok());
    assert!(env.mem.accounts().iter().all(|a| !a.ends_with("password")));
}

#[test]
fn registered_key_passphrase_comes_after_the_saved_one() {
    const KEY_ID: &str = "00000000-0000-4000-8000-0000000000c1";
    let mut env = env(1, Duration::from_secs(1), encrypted_key_auth);
    let registered = KeyPassKey::new(KEY_ID).unwrap();
    let other = KeyPassKey::new("00000000-0000-4000-8000-0000000000c2").unwrap();
    let fingerprint = ed25519(9)
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    if let TargetAuth::Key { registered: r, .. } = &mut env.target.auth {
        *r = vec![
            RegisteredKey {
                fingerprint: "SHA256:another-key".into(),
                passphrase: other.clone(),
            },
            RegisteredKey {
                fingerprint,
                passphrase: registered.clone(),
            },
        ];
    }
    env.secrets
        .set_key_passphrase(&other, &SecretString::from(PASSPHRASE))
        .unwrap();
    assert_eq!(
        load(&env, None).err(),
        Some(SshError::SecretRequired),
        "only the key whose fingerprint the file holds counts"
    );
    env.secrets
        .set_key_passphrase(&registered, &SecretString::from(PASSPHRASE))
        .unwrap();
    let loaded = load(&env, None).unwrap();
    assert!(loaded.remember.is_none());

    store_secret(&env, SecretKind::Passphrase, "stale");
    assert_eq!(
        load(&env, None).err(),
        Some(SshError::InvalidPassphrase),
        "the saved connection secret is tried first"
    );
    assert_eq!(stored(&env, SecretKind::Passphrase), None);
    assert!(load(&env, None).is_ok());
    assert_eq!(
        load(&env, credential("nope", false)).err(),
        Some(SshError::InvalidPassphrase),
        "a typed passphrase wins"
    );

    env.secrets
        .delete_saved(&env.target.saved, SecretKind::Passphrase)
        .unwrap();
    env.secrets
        .set_key_passphrase(&registered, &SecretString::from("stale"))
        .unwrap();
    assert_eq!(load(&env, None).err(), Some(SshError::InvalidPassphrase));
    assert!(
        env.secrets.has_key_passphrase(&registered).unwrap(),
        "a remembered key passphrase is managed from the keys page, never dropped here"
    );
}

#[tokio::test]
async fn wrong_passphrase_fails_before_any_network() {
    let env = env(1, Duration::from_secs(1), encrypted_key_auth);
    let (task, mut rx) = start_connect_with(&env, credential("nope", true));
    assert_eq!(
        task.await.unwrap().unwrap_err(),
        SshError::InvalidPassphrase
    );
    assert!(drain(&mut rx).is_empty());
    assert!(env.mem.accounts().is_empty());
}

#[tokio::test]
async fn passphrase_is_remembered_after_success_and_reused() {
    let server = start_server(14).await;
    let env = env(server.port, Duration::from_secs(10), encrypted_key_auth);
    trust_server(&env, &server);
    connect_once(&env, credential(PASSPHRASE, true))
        .await
        .unwrap();
    assert_eq!(
        stored(&env, SecretKind::Passphrase).as_deref(),
        Some(PASSPHRASE)
    );
    env.manager.disconnect("h1").await.unwrap();
    connect_once(&env, None).await.unwrap();
}

#[test]
fn credential_is_ignored_for_agent_and_plain_keys() {
    let agent = env(1, Duration::from_secs(1), |_| TargetAuth::Agent);
    let loaded = load(&agent, credential("x", true)).unwrap();
    assert!(matches!(loaded.credentials, Credentials::Agent));
    assert!(loaded.remember.is_none());

    let plain = env(1, Duration::from_secs(1), key_auth);
    let loaded = load(&plain, credential("x", true)).unwrap();
    assert!(matches!(loaded.credentials, Credentials::Key(_)));
    assert!(loaded.remember.is_none());
}

#[test]
fn unreadable_and_garbage_key_files() {
    let mut env = env(1, Duration::from_secs(1), |_| TargetAuth::Agent);
    env.target.auth = TargetAuth::Key {
        key_path: "does-not-exist".into(),
        passphrase: None,
        registered: Vec::new(),
    };
    assert_eq!(load(&env, None).err(), Some(SshError::Io));

    let garbage = env._dir.path().join("garbage");
    std::fs::write(&garbage, "not a key").unwrap();
    env.target.auth = TargetAuth::Key {
        key_path: garbage.to_string_lossy().into_owned(),
        passphrase: None,
        registered: Vec::new(),
    };
    assert_eq!(
        load(&env, None).err().map(|e| e.code()),
        Some("invalid_input")
    );
}

#[tokio::test]
async fn refused_connection_maps_to_network() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let env = env(port, Duration::from_secs(1), key_auth);
    let emit: Emit = Arc::new(|_| {});
    let err = env
        .manager
        .connect(&env.target, None, &|| true, emit)
        .await
        .unwrap_err();
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
        connection_id: "a@none".into(),
        host_id: "a".into(),
        environment_id: None,
        state: ConnectState::Connected,
    })
    .unwrap();
    assert_eq!(v["connectionId"], "a@none");
    assert_eq!(v["hostId"], "a");
    assert!(v["environmentId"].is_null());
    assert_eq!(v["state"], "connected");
}

#[tokio::test]
async fn remember_is_skipped_when_the_host_changed_during_the_connect() {
    let server = start_server(15).await;
    let env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    trust_server(&env, &server);
    let (task, _rx) = spawn_connect(&env, credential(SERVER_PASSWORD, true), false);
    task.await.unwrap().unwrap();
    assert!(env.mem.accounts().is_empty());
}

#[tokio::test]
async fn over_limit_typed_secret_connects_but_is_not_stored() {
    let server = start_server(16).await;
    let env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    trust_server(&env, &server);
    connect_once(&env, credential(&long_password(), true))
        .await
        .unwrap();
    assert!(env.mem.accounts().is_empty());
}

#[tokio::test]
async fn refused_stored_password_replaced_meanwhile_is_kept() {
    let env = env(1, Duration::from_secs(1), |_| TargetAuth::Password {
        variable: None,
    });
    store_secret(&env, SecretKind::Password, "new");
    forget_if_unchanged(
        &env.secrets,
        &env.target,
        SecretKind::Password,
        &SecretString::from("old"),
    );
    assert_eq!(stored(&env, SecretKind::Password).as_deref(), Some("new"));
    forget_if_unchanged(
        &env.secrets,
        &env.target,
        SecretKind::Password,
        &SecretString::from("new"),
    );
    assert_eq!(stored(&env, SecretKind::Password), None);
}

#[tokio::test]
async fn typed_wrong_secrets_never_delete_the_stored_ones() {
    let server = start_server(17).await;
    let env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    trust_server(&env, &server);
    store_secret(&env, SecretKind::Password, SERVER_PASSWORD);
    let err = connect_once(&env, credential("wrong", false))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "auth_failed");
    assert_eq!(
        stored(&env, SecretKind::Password).as_deref(),
        Some(SERVER_PASSWORD)
    );
}

#[test]
fn typed_wrong_passphrase_keeps_the_stored_one() {
    let enc = env(1, Duration::from_secs(1), encrypted_key_auth);
    store_secret(&enc, SecretKind::Passphrase, PASSPHRASE);
    assert_eq!(
        load(&enc, credential("nope", false)).err(),
        Some(SshError::InvalidPassphrase)
    );
    assert_eq!(
        stored(&enc, SecretKind::Passphrase).as_deref(),
        Some(PASSPHRASE)
    );
}

fn var_key() -> VarKey {
    VarKey::global("pw").unwrap()
}

fn with_variable(env: &mut Env) {
    env.target.auth = TargetAuth::Password {
        variable: Some(var_key()),
    };
}

#[tokio::test]
async fn password_from_a_secret_variable() {
    let server = start_server(18).await;
    let mut env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    with_variable(&mut env);
    trust_server(&env, &server);
    env.secrets
        .set_var(&var_key(), &SecretString::from(SERVER_PASSWORD))
        .unwrap();
    connect_once(&env, None).await.unwrap();
    env.manager.disconnect("h1").await.unwrap();

    env.secrets
        .set_var(&var_key(), &SecretString::from("stale"))
        .unwrap();
    assert_eq!(
        connect_once(&env, None).await.unwrap_err().code(),
        "auth_failed"
    );
    assert!(
        env.secrets.has_var(&var_key()).unwrap(),
        "a rejected variable value is the user's to change"
    );
}

#[tokio::test]
async fn variable_without_value_falls_back_to_the_saved_secret_then_asks() {
    let server = start_server(19).await;
    let mut env = env(server.port, Duration::from_secs(10), |_| {
        TargetAuth::Password { variable: None }
    });
    with_variable(&mut env);
    trust_server(&env, &server);
    assert_eq!(
        connect_once(&env, None).await.unwrap_err(),
        SshError::SecretRequired
    );
    connect_once(&env, credential(SERVER_PASSWORD, true))
        .await
        .unwrap();
    assert!(!env.secrets.has_var(&var_key()).unwrap());
    assert_eq!(
        env.mem.accounts(),
        vec![env.target.saved.account(SecretKind::Password)]
    );
    env.manager.disconnect("h1").await.unwrap();
    connect_once(&env, None).await.unwrap();
}

#[test]
fn saved_secret_follows_its_target() {
    let mut pw = env(22, Duration::from_secs(1), |_| TargetAuth::Password {
        variable: None,
    });
    store_secret(&pw, SecretKind::Password, "pw");
    assert!(load(&pw, None).is_ok());
    pw.target.port = 2222;
    assert_eq!(load(&pw, None).err(), Some(SshError::SecretRequired));
    assert!(pw.mem.accounts().is_empty());

    let mut enc = env(1, Duration::from_secs(1), encrypted_key_auth);
    store_secret(&enc, SecretKind::Passphrase, PASSPHRASE);
    enc.target.hostname = "elsewhere".into();
    assert!(
        load(&enc, None).is_ok(),
        "a passphrase is bound to the key file only"
    );
}

#[tokio::test]
async fn one_host_two_connections_at_once() {
    let server = start_server(20).await;
    let dev = env(server.port, Duration::from_secs(10), key_auth);
    trust_server(&dev, &server);
    let mut other = dev.target.clone();
    other.connection_id = "h1@other".into();
    other.environment_id = Some("00000000-0000-4000-8000-0000000000b2".into());
    let emit: Emit = Arc::new(|_| {});
    connect_once(&dev, None).await.unwrap();
    dev.manager
        .connect(&other, None, &|| true, emit)
        .await
        .unwrap();
    let ids: Vec<_> = dev
        .manager
        .list()
        .await
        .into_iter()
        .map(|c| (c.connection_id, c.environment_id.is_some()))
        .collect();
    assert_eq!(
        ids,
        vec![("h1".to_string(), false), ("h1@other".to_string(), true)]
    );
    dev.manager.disconnect("h1").await.unwrap();
    assert!(dev.manager.session("h1@other").await.is_some());
    assert!(dev.manager.session("h1").await.is_none());
}

#[test]
fn connection_ids_and_bound_targets() {
    assert_eq!(Target::connection_id_of("h", None), "h@none");
    assert_eq!(Target::connection_id_of("h", Some("e")), "h@e");
    let t = target("c", 2222, "me", TargetAuth::Password { variable: None });
    assert_eq!(t.bound_to(SecretKind::Password), "me@127.0.0.1:2222");
    let k = target(
        "c",
        22,
        "me",
        TargetAuth::Key {
            key_path: "~/.ssh/id".into(),
            passphrase: None,
            registered: Vec::new(),
        },
    );
    assert_eq!(k.bound_to(SecretKind::Passphrase), "~/.ssh/id");
}
