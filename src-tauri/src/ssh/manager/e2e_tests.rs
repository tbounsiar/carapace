//! Tests against the disposable sshd in `e2e/sshd`. Run only with `CARAPACE_E2E=1`
//! after `node e2e/sshd/setup.mjs up`.

use super::*;
use crate::secrets::MemoryBackend;
use crate::ssh::test_server::{E2E_SERVER as SERVER, target};
use std::process::Command;
use tokio::sync::mpsc;

const PORT: u16 = 2222;

fn enabled() -> bool {
    let on = std::env::var("CARAPACE_E2E").is_ok_and(|v| v == "1");
    if !on {
        eprintln!("skipped: set CARAPACE_E2E=1 to run the sshd e2e tests");
    }
    on
}

fn e2e_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e")
}

fn key_path(name: &str) -> String {
    let path = e2e_dir().join(".work").join(name);
    assert!(path.exists(), "missing {path:?}, run setup.mjs up");
    let canonical = std::fs::canonicalize(path).unwrap();
    let s = canonical.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned()
}

fn work_file(name: &str) -> String {
    let path = e2e_dir().join(".work").join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("missing {path:?}, run setup.mjs up"))
        .trim()
        .to_owned()
}

fn rotate_host_key() {
    let status = Command::new("node")
        .arg(e2e_dir().join("sshd/setup.mjs"))
        .arg("rotate-host-key")
        .status()
        .expect("node is required to rotate the host key");
    assert!(status.success());
}

struct Env {
    _dir: tempfile::TempDir,
    manager: Arc<SshManager>,
    target: Target,
    app_known_hosts: PathBuf,
    secrets: SecretStore,
}

fn env_for(hostname: &str, port: u16, connect: Duration, auth: TargetAuth) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let app_known_hosts = dir.path().join("known_hosts");
    let user_file = dir.path().join("user_known_hosts");
    let (secrets, _) = MemoryBackend::store();
    let manager = Arc::new(SshManager::with_parts(
        KnownHosts::new(app_known_hosts.clone(), Some(user_file)),
        Timeouts {
            connect,
            prompt: Duration::from_secs(20),
        },
        secrets.clone(),
    ));
    let mut target = target("e2e", port, "carapace", auth);
    target.hostname = hostname.into();
    Env {
        _dir: dir,
        manager,
        target,
        app_known_hosts,
        secrets,
    }
}

fn key_auth(name: &str) -> TargetAuth {
    TargetAuth::Key {
        key_path: key_path(name),
        passphrase: None,
    }
}

fn env(key: &str) -> Env {
    env_for("127.0.0.1", PORT, Duration::from_secs(10), key_auth(key))
}

type Events = mpsc::UnboundedReceiver<ConnectEvent>;
type ConnectTask = tokio::task::JoinHandle<Result<ConnectionInfo, SshError>>;

fn start_connect(env: &Env) -> (ConnectTask, Events) {
    start_connect_with(env, None)
}

fn start_connect_with(env: &Env, credential: Option<Credential>) -> (ConnectTask, Events) {
    let (tx, rx) = mpsc::unbounded_channel();
    let emit: Emit = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let manager = env.manager.clone();
    let target = env.target.clone();
    (
        tokio::spawn(async move {
            let current = || true;
            manager.connect(&target, credential, &current, emit).await
        }),
        rx,
    )
}

async fn next_prompt(rx: &mut Events) -> (String, String) {
    loop {
        match rx.recv().await.expect("connect ended without a prompt") {
            ConnectEvent::HostKeyPrompt {
                request_id,
                fingerprint,
                ..
            } => return (request_id, fingerprint),
            ConnectEvent::Status { .. } => {}
            other => panic!("unexpected {other:?}"),
        }
    }
}

fn drain(rx: &mut Events) -> Vec<ConnectEvent> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

fn assert_no_prompt(rx: &mut Events) {
    assert!(
        drain(rx)
            .iter()
            .all(|e| matches!(e, ConnectEvent::Status { .. }))
    );
}

async fn trust_first_use(env: &Env) -> String {
    trust_first_use_with(env, None).await
}

async fn trust_first_use_with(env: &Env, credential: Option<Credential>) -> String {
    let (task, mut rx) = start_connect_with(env, credential);
    let (id, fp) = next_prompt(&mut rx).await;
    env.manager.answer_host_key(&id, true).unwrap();
    task.await.unwrap().unwrap();
    env.manager.disconnect("e2e").await.unwrap();
    fp
}

#[tokio::test]
async fn unknown_key_rejected() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_ed25519");
    let (task, mut rx) = start_connect(&env);
    let (id, _) = next_prompt(&mut rx).await;
    env.manager.answer_host_key(&id, false).unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyRejected);
    assert!(!env.app_known_hosts.exists());
    assert!(env.manager.list().await.is_empty());
}

#[tokio::test]
async fn unknown_key_accepted_then_reconnect_without_prompt() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_ed25519");
    let (task, mut rx) = start_connect(&env);
    let (id, _) = next_prompt(&mut rx).await;
    env.manager.answer_host_key(&id, true).unwrap();
    let info = task.await.unwrap().unwrap();
    assert_eq!(info.state, ConnectState::Connected);
    assert!(env.app_known_hosts.exists());
    env.manager.disconnect("e2e").await.unwrap();

    let (task, mut rx) = start_connect(&env);
    assert!(task.await.unwrap().is_ok());
    assert_no_prompt(&mut rx);
}

#[tokio::test]
async fn rotated_host_key_is_reported_and_replaceable_by_fingerprint() {
    if !enabled() {
        return;
    }
    let _g = SERVER.write().await;
    let env = env("id_ed25519");
    let old_fp = trust_first_use(&env).await;

    rotate_host_key();

    let (task, mut rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyChanged);
    let events = drain(&mut rx);
    let new_fp = events
        .iter()
        .find_map(|e| match e {
            ConnectEvent::HostKeyChanged {
                fingerprint,
                known_fingerprints,
                ..
            } => {
                assert_eq!(known_fingerprints, &vec![old_fp.clone()]);
                Some(fingerprint.clone())
            }
            _ => None,
        })
        .expect("no hostKeyChanged event");
    assert_ne!(new_fp, old_fp);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ConnectEvent::HostKeyPrompt { .. }))
    );

    let before = std::fs::read_to_string(&env.app_known_hosts).unwrap();
    assert_eq!(
        env.manager
            .replace_host_key("e2e", &old_fp)
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        std::fs::read_to_string(&env.app_known_hosts).unwrap(),
        before
    );

    env.manager.replace_host_key("e2e", &new_fp).unwrap();
    let (task, mut rx) = start_connect(&env);
    assert!(task.await.unwrap().is_ok());
    assert_no_prompt(&mut rx);
}

#[tokio::test]
async fn revoked_host_key_fails_without_prompt() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_ed25519");
    trust_first_use(&env).await;
    let stored = std::fs::read_to_string(&env.app_known_hosts).unwrap();
    std::fs::write(&env.app_known_hosts, format!("@revoked {stored}")).unwrap();

    let (task, mut rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::HostKeyRevoked);
    assert_no_prompt(&mut rx);
}

#[tokio::test]
async fn ed25519_key_auth() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_ed25519");
    trust_first_use(&env).await;
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap().state, ConnectState::Connected);
}

#[tokio::test]
async fn rsa_4096_key_auth() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_rsa");
    trust_first_use(&env).await;
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap().state, ConnectState::Connected);
}

#[tokio::test]
async fn wrong_key_is_auth_failed() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_wrong");
    let (task, mut rx) = start_connect(&env);
    let (id, _) = next_prompt(&mut rx).await;
    env.manager.answer_host_key(&id, true).unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().code(), "auth_failed");
    assert!(env.manager.list().await.is_empty());
}

#[tokio::test]
async fn closed_port_is_network_error() {
    if !enabled() {
        return;
    }
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let env = env_for(
        "127.0.0.1",
        port,
        Duration::from_secs(5),
        key_auth("id_ed25519"),
    );
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::Network);
}

#[tokio::test]
async fn blackhole_address_times_out() {
    if !enabled() {
        return;
    }
    let env = env_for(
        "10.255.255.1",
        PORT,
        Duration::from_secs(2),
        key_auth("id_ed25519"),
    );
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::Timeout);
}

#[tokio::test]
async fn agent_auth_when_the_agent_holds_the_e2e_key() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let public = std::fs::read_to_string(format!("{}.pub", key_path("id_ed25519"))).unwrap();
    let blob = public.split_whitespace().nth(1).unwrap().to_owned();
    let listed = Command::new("ssh-add")
        .arg("-L")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&blob))
        .unwrap_or(false);
    if !listed {
        eprintln!("skipped: no ssh agent holds e2e/.work/id_ed25519 (ssh-add it first)");
        return;
    }
    let env = env_for(
        "127.0.0.1",
        PORT,
        Duration::from_secs(10),
        TargetAuth::Agent,
    );
    trust_first_use(&env).await;
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap().state, ConnectState::Connected);
}

fn typed(secret: &str) -> Option<Credential> {
    Some(Credential {
        secret: SecretString::from(secret),
        remember: false,
    })
}

fn password_env() -> Env {
    env_for(
        "127.0.0.1",
        PORT,
        Duration::from_secs(10),
        TargetAuth::Password { variable: None },
    )
}

#[tokio::test]
async fn password_auth_with_the_right_password() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = password_env();
    let password = work_file("password");
    trust_first_use_with(&env, typed(&password)).await;
    env.secrets
        .set_saved(
            &env.target.saved,
            SecretKind::Password,
            &env.target.bound_to(SecretKind::Password),
            &SecretString::from(password),
        )
        .unwrap();
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap().state, ConnectState::Connected);
}

#[tokio::test]
async fn password_auth_with_a_wrong_password_is_auth_failed() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = password_env();
    let (task, mut rx) = start_connect_with(&env, typed("not-the-password"));
    let (id, _) = next_prompt(&mut rx).await;
    env.manager.answer_host_key(&id, true).unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().code(), "auth_failed");
    assert!(env.manager.list().await.is_empty());
}

#[tokio::test]
async fn encrypted_key_with_its_passphrase() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_ed25519_enc");
    trust_first_use_with(&env, typed(&work_file("passphrase"))).await;
    let (task, _rx) = start_connect_with(&env, typed(&work_file("passphrase")));
    assert_eq!(task.await.unwrap().unwrap().state, ConnectState::Connected);
}

#[tokio::test]
async fn encrypted_key_with_a_wrong_passphrase_is_invalid_passphrase() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_ed25519_enc");
    let (task, mut rx) = start_connect_with(&env, typed("not-the-passphrase"));
    assert_eq!(
        task.await.unwrap().unwrap_err(),
        SshError::InvalidPassphrase
    );
    assert!(drain(&mut rx).is_empty());
}

#[tokio::test]
async fn encrypted_key_without_a_passphrase_is_secret_required() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let env = env("id_ed25519_enc");
    let (task, mut rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap_err(), SshError::SecretRequired);
    assert!(drain(&mut rx).is_empty());
}

#[tokio::test]
async fn password_from_a_secret_variable() {
    if !enabled() {
        return;
    }
    let _g = SERVER.read().await;
    let mut env = password_env();
    let key = VarKey::global("carapace_password").unwrap();
    env.target.auth = TargetAuth::Password {
        variable: Some(key.clone()),
    };
    env.secrets
        .set_var(&key, &SecretString::from(work_file("password")))
        .unwrap();
    trust_first_use(&env).await;
    let (task, _rx) = start_connect(&env);
    assert_eq!(task.await.unwrap().unwrap().state, ConnectState::Connected);
}
