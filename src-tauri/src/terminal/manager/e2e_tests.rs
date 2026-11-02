//! Terminals against the disposable sshd in `e2e/sshd`. Run only with `CARAPACE_E2E=1`
//! after `node e2e/sshd/setup.mjs up`.

use std::path::Path;

use super::tests::{Events, closed, collector, next, read_until};
use super::*;
use crate::config::Host;
use crate::config::model::AuthMethod;
use crate::secrets::SecretScope;
use crate::ssh::test_server::{E2E_SERVER, isolated_manager};
use crate::ssh::{ConnectEvent, SshManager};

const HOST_ID: &str = "e2e-terminal";

fn enabled() -> bool {
    let on = std::env::var("CARAPACE_E2E").is_ok_and(|v| v == "1");
    if !on {
        eprintln!("skipped: set CARAPACE_E2E=1 to run the sshd e2e tests");
    }
    on
}

fn key_path() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/.work/id_ed25519");
    assert!(path.exists(), "missing {path:?}, run setup.mjs up");
    let canonical = std::fs::canonicalize(path).unwrap();
    let s = canonical.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned()
}

struct World {
    _dir: tempfile::TempDir,
    ssh: Arc<SshManager>,
    terminals: TerminalManager,
}

/// Connects through the real host key prompt, answered like a user accepting it.
async fn connected() -> World {
    let dir = tempfile::tempdir().unwrap();
    let ssh = Arc::new(isolated_manager(dir.path()));
    let host = Host {
        id: HOST_ID.into(),
        name: HOST_ID.into(),
        hostname: "127.0.0.1".into(),
        port: 2222,
        username: "carapace".into(),
        auth: AuthMethod::Key {
            key_path: key_path(),
        },
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let emit: Arc<dyn Fn(ConnectEvent) + Send + Sync> = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let manager = ssh.clone();
    let task = tokio::spawn(async move {
        let scope = SecretScope::new(
            "00000000-0000-4000-8000-0000000000f1",
            "00000000-0000-4000-8000-0000000000f2",
            "00000000-0000-4000-8000-0000000000f3",
        )
        .unwrap();
        manager.connect(&scope, &host, None, &|| true, emit).await
    });
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
    task.await.unwrap().unwrap();
    World {
        _dir: dir,
        ssh,
        terminals: TerminalManager::default(),
    }
}

impl World {
    async fn open(&self) -> (String, Events) {
        let (emit, rx) = collector();
        let id = self
            .terminals
            .open(&self.ssh, HOST_ID, 80, 24, emit)
            .await
            .unwrap();
        (id, rx)
    }
}

#[tokio::test]
async fn shell_echoes_resizes_and_closes() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    let (id, mut rx) = w.open().await;
    w.terminals
        .write(&id, "echo carapace-$((20+22))\n")
        .unwrap();
    read_until(&mut rx, "carapace-42").await;

    w.terminals.resize(&id, 132, 43).unwrap();
    w.terminals.write(&id, "echo size-$(stty size)\n").unwrap();
    read_until(&mut rx, "size-43 132").await;

    w.terminals.close(&id).unwrap();
    assert_eq!(closed(&mut rx).await, CloseReason::Closed);
    assert_eq!(w.terminals.count(HOST_ID), 0);
    assert!(w.ssh.session(HOST_ID).await.is_some());
}

#[tokio::test]
async fn exit_reports_the_status() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    let (id, mut rx) = w.open().await;
    w.terminals.write(&id, "exit 7\n").unwrap();
    loop {
        match next(&mut rx).await {
            Some(TerminalEvent::Exit { code }) => {
                assert_eq!(code, Some(7));
                break;
            }
            Some(TerminalEvent::Data { .. }) => {}
            other => panic!("expected exit, got {other:?}"),
        }
    }
    assert_eq!(closed(&mut rx).await, CloseReason::Exited);
}

#[tokio::test]
async fn disconnect_closes_every_terminal_of_the_host() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    let (_a, mut rx_a) = w.open().await;
    let (_b, mut rx_b) = w.open().await;
    w.ssh.disconnect(HOST_ID).await.unwrap();
    assert_eq!(closed(&mut rx_a).await, CloseReason::Closed);
    assert_eq!(closed(&mut rx_b).await, CloseReason::Closed);
    assert_eq!(w.terminals.count(HOST_ID), 0);
}
