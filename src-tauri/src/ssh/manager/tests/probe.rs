use super::*;

type ProbeTask = tokio::task::JoinHandle<Result<HostTestResult, SshError>>;

fn spawn_probe(env: &Env, test_id: &str, credential: Option<Credential>) -> (ProbeTask, Events) {
    spawn_probe_for(env, env.target.clone(), test_id, credential)
}

fn spawn_probe_for(
    env: &Env,
    target: Target,
    test_id: &str,
    credential: Option<Credential>,
) -> (ProbeTask, Events) {
    let (tx, rx) = mpsc::unbounded_channel();
    let emit: Emit = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let manager = env.manager.clone();
    let id = test_id.to_owned();
    (
        tokio::spawn(async move {
            let ticket = manager.start_test(&id)?;
            manager.probe(ticket, &target, credential, emit).await
        }),
        rx,
    )
}

async fn probe(env: &Env, credential: Option<Credential>) -> Result<HostTestResult, SshError> {
    let (task, _rx) = spawn_probe(env, "t1", credential);
    task.await.unwrap()
}

fn password_env(port: u16) -> Env {
    env(port, Duration::from_secs(10), |_| TargetAuth::Password {
        variable: None,
    })
}

fn source(r: &HostTestResult) -> Option<SecretSource> {
    r.secret_source
}

fn assert_untouched(env: &Env) {
    assert!(env.manager.pending.lock().unwrap().is_empty());
    assert!(env.manager.tests.lock().unwrap().is_empty());
    assert!(env.manager.changed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn password_from_each_source_succeeds_and_nothing_is_kept() {
    let server = start_server(40).await;
    let mut env = password_env(server.port);
    trust_server(&env, &server);

    let r = probe(&env, credential(SERVER_PASSWORD, true))
        .await
        .unwrap();
    assert_eq!(r.address, format!("me@127.0.0.1:{}", server.port));
    assert_eq!(r.auth_kind, AuthKind::Password);
    assert_eq!(source(&r), Some(SecretSource::Typed));
    assert!(r.duration_ms < 10_000);
    assert!(env.mem.accounts().is_empty(), "remember is ignored");

    store_secret(&env, SecretKind::Password, SERVER_PASSWORD);
    let r = probe(&env, None).await.unwrap();
    assert_eq!(source(&r), Some(SecretSource::Saved));

    with_variable(&mut env);
    env.secrets
        .set_var(&var_key(), &SecretString::from(SERVER_PASSWORD))
        .unwrap();
    let r = probe(&env, None).await.unwrap();
    assert_eq!(source(&r), Some(SecretSource::Variable));

    assert!(env.manager.list().await.is_empty());
    assert_untouched(&env);
}

#[tokio::test]
async fn refused_password_names_its_source_and_a_saved_one_is_kept() {
    let server = start_server(41).await;
    let mut env = password_env(server.port);
    trust_server(&env, &server);

    let typed = probe(&env, credential("wrong", true)).await.unwrap_err();
    assert_eq!(
        typed,
        SshError::AuthFailed("authentication was refused by the server".into())
    );
    assert!(env.mem.accounts().is_empty());

    store_secret(&env, SecretKind::Password, "stale");
    let saved = probe(&env, None).await.unwrap_err();
    assert_eq!(
        saved,
        SshError::AuthFailed("the saved password was refused by the server".into())
    );
    assert_eq!(
        stored(&env, SecretKind::Password).as_deref(),
        Some("stale"),
        "a test never forgets a saved secret"
    );

    with_variable(&mut env);
    env.secrets
        .set_var(&var_key(), &SecretString::from("stale"))
        .unwrap();
    let var = probe(&env, None).await.unwrap_err();
    assert_eq!(var.code(), "auth_failed");
    assert_eq!(
        var.to_string(),
        "the password from variable pw was refused by the server"
    );
    for e in [typed, saved, var] {
        assert!(!e.to_string().contains("stale") && !e.to_string().contains("wrong"));
    }
    assert!(env.manager.list().await.is_empty());
}

#[tokio::test]
async fn plain_and_encrypted_keys_with_each_passphrase_source() {
    let server = start_server(42).await;
    let plain = env(server.port, Duration::from_secs(10), key_auth);
    trust_server(&plain, &server);
    let r = probe(&plain, credential("ignored", true)).await.unwrap();
    assert_eq!((r.auth_kind, r.secret_source), (AuthKind::Key, None));
    assert!(plain.mem.accounts().is_empty());

    let mut enc = env(server.port, Duration::from_secs(10), encrypted_key_auth);
    trust_server(&enc, &server);
    assert_eq!(
        probe(&enc, None).await.unwrap_err(),
        SshError::SecretRequired
    );
    let r = probe(&enc, credential(PASSPHRASE, true)).await.unwrap();
    assert_eq!(source(&r), Some(SecretSource::Typed));
    assert!(enc.mem.accounts().is_empty(), "remember is ignored");
    assert_eq!(
        probe(&enc, credential("nope", false)).await.unwrap_err(),
        SshError::InvalidPassphrase
    );

    let key_id = KeyPassKey::new("00000000-0000-4000-8000-0000000000d1").unwrap();
    let fingerprint = ed25519(9)
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    if let TargetAuth::Key { registered, .. } = &mut enc.target.auth {
        *registered = vec![RegisteredKey {
            fingerprint,
            passphrase: key_id.clone(),
        }];
    }
    enc.secrets
        .set_key_passphrase(&key_id, &SecretString::from(PASSPHRASE))
        .unwrap();
    let r = probe(&enc, None).await.unwrap();
    assert_eq!(source(&r), Some(SecretSource::KeyPassphrase));
    enc.secrets
        .set_key_passphrase(&key_id, &SecretString::from("stale"))
        .unwrap();
    assert_eq!(
        probe(&enc, None).await.unwrap_err(),
        SshError::PassphraseRefused(
            "the remembered key passphrase does not unlock the private key".into()
        )
    );

    store_secret(&enc, SecretKind::Passphrase, PASSPHRASE);
    let r = probe(&enc, None).await.unwrap();
    assert_eq!(source(&r), Some(SecretSource::Saved));
    store_secret(&enc, SecretKind::Passphrase, "stale");
    let err = probe(&enc, None).await.unwrap_err();
    assert_eq!(err.code(), "invalid_passphrase");
    assert_eq!(
        err.to_string(),
        "the saved passphrase does not unlock the private key"
    );
    assert_eq!(
        stored(&enc, SecretKind::Passphrase).as_deref(),
        Some("stale"),
        "a test never forgets a saved secret"
    );

    let var = VarKey::global("pp").unwrap();
    if let TargetAuth::Key { passphrase, .. } = &mut enc.target.auth {
        *passphrase = Some(var.clone());
    }
    enc.secrets
        .set_var(&var, &SecretString::from(PASSPHRASE))
        .unwrap();
    let r = probe(&enc, None).await.unwrap();
    assert_eq!(source(&r), Some(SecretSource::Variable));
    enc.secrets
        .set_var(&var, &SecretString::from("stale"))
        .unwrap();
    assert_eq!(
        probe(&enc, None).await.unwrap_err().to_string(),
        "the passphrase from variable pp does not unlock the private key"
    );
    assert!(enc.manager.list().await.is_empty());
}

#[tokio::test]
async fn a_draft_without_host_never_uses_saved_secrets() {
    let server = start_server(43).await;
    let mut env = password_env(server.port);
    trust_server(&env, &server);
    store_secret(&env, SecretKind::Password, SERVER_PASSWORD);
    env.target.saved = None;
    assert_eq!(
        probe(&env, None).await.unwrap_err(),
        SshError::SecretRequired
    );
}

#[tokio::test]
async fn unknown_key_accepted_is_written_rejected_is_not() {
    let server = start_server(44).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);

    let (task, mut rx) = spawn_probe(&env, "t1", None);
    let (id, _) = next_prompt(&mut rx).await;
    env.manager.answer_host_key(&id, false).unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyRejected);
    assert!(!env.app_known_hosts.exists());

    let (task, mut rx) = spawn_probe(&env, "t1", None);
    let (id, _) = next_prompt(&mut rx).await;
    // Counted, the wait alone would make the duration at least this long; the probe itself
    // stays far below it even on a loaded machine.
    let wait = Duration::from_secs(2);
    tokio::time::sleep(wait).await;
    env.manager.answer_host_key(&id, true).unwrap();
    let r = task.await.unwrap().unwrap();
    assert!(
        u128::from(r.duration_ms) < wait.as_millis(),
        "prompt time is not counted: {} ms",
        r.duration_ms
    );
    let stored = std::fs::read_to_string(&env.app_known_hosts).unwrap();
    assert!(stored.starts_with(&format!("[127.0.0.1]:{} ssh-ed25519 ", server.port)));

    let (task, mut rx) = spawn_probe(&env, "t1", None);
    assert!(task.await.unwrap().is_ok());
    assert_no_prompt(&mut rx);
    assert!(env.manager.list().await.is_empty());
    assert_untouched(&env);
}

#[tokio::test]
async fn changed_key_fails_and_is_never_offered_for_replace() {
    let server = start_server(45).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let old = ed25519(79).public_key().clone();
    env.manager
        .known_hosts
        .trust("127.0.0.1", server.port, &old)
        .unwrap();
    let before = std::fs::read_to_string(&env.app_known_hosts).unwrap();

    let (task, mut rx) = spawn_probe(&env, "t1", None);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyChanged);
    let new_fp = fingerprint(server.key.public_key());
    let events = drain(&mut rx);
    assert!(events.iter().any(|e| matches!(
        e,
        ConnectEvent::HostKeyChanged { fingerprint, .. } if *fingerprint == new_fp
    )));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ConnectEvent::HostKeyPrompt { .. }))
    );
    assert_eq!(
        env.manager.replace_host_key("h1", &new_fp).unwrap_err(),
        SshError::NotFound("host key")
    );
    assert_eq!(
        std::fs::read_to_string(&env.app_known_hosts).unwrap(),
        before
    );
    assert_untouched(&env);
}

#[tokio::test]
async fn a_changed_key_remembered_by_a_connect_survives_a_test() {
    let server = start_server(46).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    env.manager
        .known_hosts
        .trust("127.0.0.1", server.port, ed25519(80).public_key())
        .unwrap();
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyChanged);
    assert_eq!(
        probe(&env, None).await.unwrap_err(),
        SshError::HostKeyChanged
    );
    env.manager
        .replace_host_key("h1", &fingerprint(server.key.public_key()))
        .unwrap();
}

#[tokio::test]
async fn revoked_key_fails() {
    let server = start_server(47).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let blob = server.key.public_key().to_openssh().unwrap();
    std::fs::write(
        &env.app_known_hosts,
        format!("@revoked [127.0.0.1]:{} {blob}\n", server.port),
    )
    .unwrap();
    let (task, mut rx) = spawn_probe(&env, "t1", None);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyRevoked);
    assert_no_prompt(&mut rx);
}

#[tokio::test]
async fn cancel_during_the_prompt_rejects_it_and_writes_nothing() {
    let server = start_server(48).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let (task, mut rx) = spawn_probe(&env, "t1", None);
    let (id, _) = next_prompt(&mut rx).await;
    env.manager.cancel_test("t1").unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::Cancelled);
    assert_eq!(
        env.manager.answer_host_key(&id, true).unwrap_err(),
        SshError::NotFound("host key request")
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!env.app_known_hosts.exists());
    assert_untouched(&env);

    let (task, mut rx) = spawn_probe(&env, "t1", None);
    let (id, _) = next_prompt(&mut rx).await;
    env.manager.answer_host_key(&id, true).unwrap();
    assert!(task.await.unwrap().is_ok(), "the id is free again");
}

#[tokio::test]
async fn cancel_during_the_handshake_closes_the_socket() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let env = env(port, Duration::from_secs(10), key_auth);
    let (task, _rx) = spawn_probe(&env, "t1", None);
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut buf = [0u8; 4096];
    let n = socket.read(&mut buf).await.unwrap();
    assert!(buf[..n].starts_with(b"SSH-2.0-"));
    // After the server id, russh runs the key exchange in its own spawned task, which the
    // dropped test future does not own; the server then stalls.
    socket.write_all(b"SSH-2.0-stall\r\n").await.unwrap();
    let n = socket.read(&mut buf).await.unwrap();
    assert!(n > 0, "the client starts the key exchange");

    env.manager.cancel_test("t1").unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::Cancelled);
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match socket.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "the cancelled handshake still holds the socket"
    );
    assert_untouched(&env);
}

#[tokio::test]
async fn handshake_timeout_is_the_connect_timeout() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let env = env_with(
        port,
        Duration::from_millis(300),
        Duration::from_secs(10),
        key_auth,
    );
    let (task, _rx) = spawn_probe(&env, "t1", None);
    let _held = listener.accept().await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::Timeout);
}

#[tokio::test]
async fn an_open_session_of_the_host_is_not_touched() {
    let server = start_server(49).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    trust_server(&env, &server);
    let info = connect_once(&env, None).await.unwrap();
    let before = env.manager.session("h1").await.unwrap();

    probe(&env, None).await.unwrap();
    assert_eq!(env.manager.list().await, vec![info]);
    let after = env.manager.session("h1").await.unwrap();
    assert!(Arc::ptr_eq(&before.handle, &after.handle));
    assert!(after.ended.borrow().is_none());
}

#[tokio::test]
async fn concurrent_tests_and_duplicate_ids() {
    let server = start_server(50).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);

    let (held, mut rx) = spawn_probe(&env, "busy", None);
    let (id, _) = next_prompt(&mut rx).await;
    let dup = probe_with_id(&env, "busy").await.unwrap_err();
    assert_eq!(dup.code(), "invalid_input");

    let (a, mut ra) = spawn_probe(&env, "a", None);
    let (b, mut rb) = spawn_probe(&env, "b", None);
    let (ida, _) = next_prompt(&mut ra).await;
    let (idb, _) = next_prompt(&mut rb).await;
    env.manager.answer_host_key(&ida, true).unwrap();
    env.manager.answer_host_key(&idb, true).unwrap();
    let (a, b) = (a.await.unwrap(), b.await.unwrap());
    assert!(a.is_ok() && b.is_ok());

    env.manager.answer_host_key(&id, false).unwrap();
    assert_eq!(held.await.unwrap().unwrap_err(), SshError::HostKeyRejected);
    env.manager.cancel_test("never-started").unwrap();
    assert!(env.manager.list().await.is_empty());
    assert_untouched(&env);
}

async fn probe_with_id(env: &Env, test_id: &str) -> Result<HostTestResult, SshError> {
    let (task, _rx) = spawn_probe(env, test_id, None);
    task.await.unwrap()
}

#[tokio::test]
async fn the_session_is_closed_after_auth() {
    let server = start_server(51).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    trust_server(&env, &server);
    let (task, mut rx) = spawn_probe(&env, "t1", None);
    task.await.unwrap().unwrap();
    let states: Vec<_> = drain(&mut rx)
        .into_iter()
        .filter_map(|e| match e {
            ConnectEvent::Status { state } => Some(state),
            _ => None,
        })
        .collect();
    assert_eq!(
        states,
        vec![
            ConnectState::Connecting,
            ConnectState::Authenticating,
            ConnectState::Connected
        ]
    );
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        while server.open_sessions() > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(closed.is_ok(), "the server still sees the test's session");
}

#[test]
fn result_serializes_as_contract() {
    let r = HostTestResult {
        address: "me@h:22".into(),
        auth_kind: AuthKind::Key,
        secret_source: Some(SecretSource::KeyPassphrase),
        duration_ms: 12,
    };
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        serde_json::json!({
            "address": "me@h:22",
            "authKind": "key",
            "secretSource": "keyPassphrase",
            "durationMs": 12
        })
    );
    let none = HostTestResult {
        secret_source: None,
        auth_kind: AuthKind::Agent,
        ..r
    };
    let json = serde_json::to_value(&none).unwrap();
    assert_eq!(json["secretSource"], serde_json::Value::Null);
    assert_eq!(json["authKind"], "agent");
    for (s, text) in [
        (SecretSource::Typed, "typed"),
        (SecretSource::Variable, "variable"),
        (SecretSource::Saved, "saved"),
    ] {
        assert_eq!(serde_json::to_value(s).unwrap(), text);
    }
    assert_eq!(
        serde_json::to_value(AuthKind::Password).unwrap(),
        "password"
    );
}

#[tokio::test]
async fn a_test_never_deletes_a_saved_secret_bound_elsewhere_or_unreadable() {
    let server = start_server(52).await;
    let mut env = password_env(server.port);
    trust_server(&env, &server);
    store_secret(&env, SecretKind::Password, SERVER_PASSWORD);
    let account = env
        .target
        .saved
        .as_ref()
        .unwrap()
        .account(SecretKind::Password);
    let saved = env.mem.raw(&account).unwrap();

    let edited = {
        let mut t = env.target.clone();
        t.username = "someone-else".into();
        t
    };
    let (task, _rx) = spawn_probe_for(&env, edited, "t1", None);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::SecretRequired);
    assert_eq!(env.mem.raw(&account).as_deref(), Some(saved.as_str()));

    env.mem.put_raw(&account, "not json");
    assert_eq!(
        probe(&env, None).await.unwrap_err(),
        SshError::SecretRequired
    );
    assert_eq!(env.mem.raw(&account).as_deref(), Some("not json"));

    env.target.port = 1;
    assert_eq!(
        connect_once(&env, None).await.unwrap_err(),
        SshError::SecretRequired
    );
    assert_eq!(env.mem.raw(&account), None, "a connect still drops it");
}

#[tokio::test]
async fn a_test_never_deletes_a_saved_passphrase_of_another_key_file() {
    let mut env = env(1, Duration::from_secs(1), encrypted_key_auth);
    store_secret(&env, SecretKind::Passphrase, PASSPHRASE);
    let account = env
        .target
        .saved
        .as_ref()
        .unwrap()
        .account(SecretKind::Passphrase);
    let other = env._dir.path().join("other_enc");
    if let TargetAuth::Key { key_path, .. } = &mut env.target.auth {
        std::fs::copy(&*key_path, &other).unwrap();
        *key_path = other.to_string_lossy().into_owned();
    }
    assert_eq!(
        probe(&env, None).await.unwrap_err(),
        SshError::SecretRequired
    );
    assert!(env.mem.raw(&account).is_some());
}

enum ProbeOrConnect {
    Probe(ProbeTask),
    Connect(ConnectTask),
}

fn probing(env: &Env, id: &str) -> (ProbeOrConnect, Events) {
    let (t, rx) = spawn_probe(env, id, None);
    (ProbeOrConnect::Probe(t), rx)
}

fn connecting(env: &Env) -> (ProbeOrConnect, Events) {
    let (t, rx) = start_connect(env);
    (ProbeOrConnect::Connect(t), rx)
}

/// Runs `meanwhile` while the unknown-key prompt is open, then accepts it.
async fn accept_after(
    env: &Env,
    started: (ProbeOrConnect, Events),
    meanwhile: impl FnOnce(),
) -> (Result<(), SshError>, Vec<ConnectEvent>) {
    let (task, mut rx) = started;
    let (id, _) = next_prompt(&mut rx).await;
    meanwhile();
    env.manager.answer_host_key(&id, true).unwrap();
    let result = match task {
        ProbeOrConnect::Probe(t) => t.await.unwrap().map(|_| ()),
        ProbeOrConnect::Connect(t) => t.await.unwrap().map(|_| ()),
    };
    (result, drain(&mut rx))
}

fn changed_event(events: &[ConnectEvent], presented: &str, known: &str) -> bool {
    events.iter().any(|e| {
        matches!(e, ConnectEvent::HostKeyChanged { fingerprint, known_fingerprints, .. }
            if fingerprint == presented && known_fingerprints == &vec![known.to_string()])
    })
}

#[tokio::test]
async fn accepting_after_another_key_was_trusted_meanwhile_fails_as_changed() {
    let server = start_server(53).await;
    let presented = fingerprint(server.key.public_key());
    let other = ed25519(82).public_key().clone();

    let test = env(server.port, Duration::from_secs(10), key_auth);
    let (result, events) = accept_after(&test, probing(&test, "t1"), || {
        test.manager
            .known_hosts
            .trust("127.0.0.1", server.port, &other)
            .unwrap();
    })
    .await;
    assert_eq!(result.unwrap_err(), SshError::HostKeyChanged);
    assert!(changed_event(&events, &presented, &fingerprint(&other)));
    let file = std::fs::read_to_string(&test.app_known_hosts).unwrap();
    assert!(file.contains(&other.to_openssh().unwrap()), "{file}");
    assert!(!file.contains(&server.key.public_key().to_openssh().unwrap()));
    assert_eq!(
        test.manager.replace_host_key("h1", &presented).unwrap_err(),
        SshError::NotFound("host key"),
        "a test never enables a replace"
    );

    let conn = env(server.port, Duration::from_secs(10), key_auth);
    let (result, events) = accept_after(&conn, connecting(&conn), || {
        conn.manager
            .known_hosts
            .trust("127.0.0.1", server.port, &other)
            .unwrap();
    })
    .await;
    assert_eq!(result.unwrap_err(), SshError::HostKeyChanged);
    assert!(changed_event(&events, &presented, &fingerprint(&other)));
    assert!(conn.manager.list().await.is_empty());
    conn.manager.replace_host_key("h1", &presented).unwrap();
}

#[tokio::test]
async fn accepting_a_key_trusted_meanwhile_writes_nothing_more() {
    let server = start_server(54).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let mut marked = String::new();
    let (result, _) = accept_after(&env, probing(&env, "t1"), || {
        trust_server(&env, &server);
        let file = std::fs::read_to_string(&env.app_known_hosts).unwrap();
        marked = format!("# kept\n{file}");
        std::fs::write(&env.app_known_hosts, &marked).unwrap();
    })
    .await;
    result.unwrap();
    assert_eq!(
        std::fs::read_to_string(&env.app_known_hosts).unwrap(),
        marked,
        "the file is not rewritten"
    );
}

#[tokio::test]
async fn accepting_a_key_revoked_meanwhile_fails_as_revoked() {
    let server = start_server(55).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    let blob = server.key.public_key().to_openssh().unwrap();
    let (result, _) = accept_after(&env, connecting(&env), || {
        std::fs::write(
            &env.app_known_hosts,
            format!("@revoked [127.0.0.1]:{} {blob}\n", server.port),
        )
        .unwrap();
    })
    .await;
    assert_eq!(result.unwrap_err(), SshError::HostKeyRevoked);
}

#[test]
fn at_most_four_tests_run_at_once() {
    let env = env(1, Duration::from_secs(1), key_auth);
    assert_eq!(MAX_TESTS, 4);
    let held: Vec<_> = (0..MAX_TESTS)
        .map(|i| env.manager.start_test(&format!("t{i}")).unwrap())
        .collect();
    let busy = env.manager.start_test("t4").err().unwrap();
    assert_eq!(busy, SshError::Busy);
    assert_eq!(busy.code(), "busy");
    assert_eq!(busy.to_string(), "too many connection tests are running");
    assert_eq!(
        env.manager.start_test("t0").err().unwrap().code(),
        "invalid_input"
    );
    drop(held);
    assert!(env.manager.start_test("t4").is_ok());
}

#[tokio::test]
async fn a_cancel_sent_before_the_probe_starts_is_not_lost() {
    let server = start_server(56).await;
    let env = env(server.port, Duration::from_secs(10), key_auth);
    trust_server(&env, &server);
    let ticket = env.manager.start_test("t1").unwrap();
    env.manager.cancel_test("t1").unwrap();
    let emit: Emit = Arc::new(|_| {});
    assert_eq!(
        env.manager
            .probe(ticket, &env.target, None, emit)
            .await
            .unwrap_err(),
        SshError::Cancelled
    );
    assert_eq!(server.open_sessions(), 0);
    assert_untouched(&env);
}
