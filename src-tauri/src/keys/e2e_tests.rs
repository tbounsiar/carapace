//! Key deployment against the disposable sshd in `e2e/sshd`. Run only with `CARAPACE_E2E=1`
//! after `node e2e/sshd/setup.mjs up`. The container's authorized_keys is restored at the end
//! (and `setup.mjs up` provisions it again anyway).

use std::path::Path;
use std::sync::Arc;

use tokio::sync::mpsc;

use super::deploy::{read_capped, replace_file};
use super::location::KeyDir;
use super::*;
use crate::sftp::SftpManager;
use crate::ssh::test_server::{E2E_SERVER, isolated_manager, target};
use crate::ssh::{ConnectEvent, SshError, SshManager, TargetAuth};

const SSH_DIR: &str = "/home/carapace/.ssh";

fn enabled() -> bool {
    let on = std::env::var("CARAPACE_E2E").is_ok_and(|v| v == "1");
    if !on {
        eprintln!("skipped: set CARAPACE_E2E=1 to run the sshd e2e tests");
    }
    on
}

fn e2e_key() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/.work/id_ed25519");
    assert!(path.exists(), "missing {path:?}, run setup.mjs up");
    crate::fsutil::canonical(&path)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

/// Connects through the real host key prompt, answered like a user accepting it.
async fn connect(ssh: &Arc<SshManager>, id: &str, key_path: String) -> Result<(), SshError> {
    let target = target(
        id,
        2222,
        "carapace",
        TargetAuth::Key {
            key_path,
            passphrase: None,
            registered: Vec::new(),
        },
    );
    let (tx, mut rx) = mpsc::unbounded_channel();
    let emit: Arc<dyn Fn(ConnectEvent) + Send + Sync> = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let manager = ssh.clone();
    let task = tokio::spawn(async move { manager.connect(&target, None, &|| true, emit).await });
    // Each manager has its own empty known_hosts, so every connect asks once.
    loop {
        match rx.recv().await.expect("connect ended without a prompt") {
            ConnectEvent::HostKeyPrompt { request_id, .. } => {
                ssh.answer_host_key(&request_id, true).unwrap();
                break;
            }
            ConnectEvent::Status { .. } => {}
            other => panic!("unexpected {other:?}"),
        }
    }
    task.await.unwrap().map(|_| ())
}

#[tokio::test]
async fn deployed_key_authenticates() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let dir = tempfile::tempdir().unwrap();
    let ssh = Arc::new(isolated_manager(dir.path()));
    connect(&ssh, "e2e-keys", e2e_key()).await.unwrap();
    let sftp = SftpManager::default();
    let remote = sftp.channel(&ssh, "e2e-keys").await.unwrap();
    let authorized = format!("{SSH_DIR}/authorized_keys");
    let original = read_capped(&remote, &authorized).await.unwrap();

    let generated = generate(
        &KeyDir::managed(&keys_dir(dir.path())),
        "deployed",
        KeyType::Ed25519,
        "carapace-e2e-deployed",
        None,
    )
    .unwrap();
    let key_path = generated.path.to_string_lossy().into_owned();
    let public_key = deployable_line(
        &key_path,
        &generated.info.public_key,
        &generated.info.comment,
    )
    .unwrap();
    let body = {
        let remote = remote.clone();
        let dir = dir.path().to_path_buf();
        tokio::spawn(async move {
            assert_eq!(deploy(&remote, &public_key).await.unwrap(), Deployed::Added);
            std::fs::create_dir_all(dir.join("second")).unwrap();
            let second = Arc::new(isolated_manager(&dir.join("second")));
            connect(&second, "e2e-keys-new", key_path).await.unwrap();
            second.disconnect("e2e-keys-new").await.unwrap();
            assert_eq!(
                deploy(&remote, &public_key).await.unwrap(),
                Deployed::AlreadyPresent
            );
        })
        .await
    };
    replace_file(&remote, SSH_DIR, "authorized_keys", &original, true)
        .await
        .unwrap();
    assert_eq!(read_capped(&remote, &authorized).await.unwrap(), original);
    ssh.disconnect("e2e-keys").await.unwrap();
    if let Err(e) = body {
        std::panic::resume_unwind(e.into_panic());
    }
}
