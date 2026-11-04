//! External edit against the disposable sshd in `e2e/sshd`. Run only with `CARAPACE_E2E=1`
//! after `node e2e/sshd/setup.mjs up`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use super::launch::Launcher;
use super::state::State;
use super::*;
use crate::sftp::{Eol, SftpManager, WriteText};
use crate::ssh::test_server::{E2E_SERVER, isolated_manager, target};
use crate::ssh::{ConnectEvent, SshManager, TargetAuth};
use crate::transfer::{Connections, RemoteFuture};

const HOST_ID: &str = "e2e-external";

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

struct Conns {
    ssh: Arc<SshManager>,
    sftp: SftpManager,
}

impl Connections for Conns {
    fn remote<'a>(&'a self, connection_id: &'a str) -> RemoteFuture<'a> {
        Box::pin(async move { self.sftp.channel(&self.ssh, connection_id).await })
    }
}

#[derive(Default)]
struct Recorder(Mutex<Vec<PathBuf>>);

impl Launcher for Recorder {
    fn open(&self, file: &Path, _: &Opener) -> Result<(), EditError> {
        self.0.lock().unwrap().push(file.to_owned());
        Ok(())
    }
    fn reveal(&self, _: &Path) -> Result<(), EditError> {
        Ok(())
    }
}

/// Connects through the real host key prompt, answered like a user accepting it.
async fn connect(dir: &Path) -> Arc<SshManager> {
    let ssh = Arc::new(isolated_manager(dir));
    let target = target(
        HOST_ID,
        2222,
        "carapace",
        TargetAuth::Key {
            key_path: key_path(),
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
    ssh
}

/// Runs a fixed test command over an exec channel.
async fn exec(ssh: &SshManager, command: &str) {
    let session = ssh.session(HOST_ID).await.unwrap();
    let mut channel = session.handle.channel_open_session().await.unwrap();
    channel.exec(true, command).await.unwrap();
    loop {
        match channel.wait().await {
            Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                assert_eq!(exit_status, 0, "{command}");
                return;
            }
            Some(_) => {}
            None => panic!("{command}: no exit status"),
        }
    }
}

async fn until(edits: &ExternalEdits, id: &str, done: impl Fn(&EditedFile) -> bool) -> EditedFile {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(f) = edits.list().into_iter().find(|f| f.id == id && done(f)) {
            return f;
        }
        assert!(Instant::now() < deadline, "timed out: {:?}", edits.list());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn saves_upload_and_a_server_change_is_a_conflict() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let dir = tempfile::tempdir().unwrap();
    let conns = Arc::new(Conns {
        ssh: connect(dir.path()).await,
        sftp: SftpManager::default(),
    });
    let ssh = conns.ssh.clone();
    let name = format!("e2e-external-{}", uuid::Uuid::new_v4().simple());
    let base = conns
        .sftp
        .mkdir(&ssh, HOST_ID, "", &name)
        .await
        .unwrap()
        .path;
    let path = format!("{base}/app.conf");
    let write = |text: &'static str| WriteText {
        path: &path,
        text,
        expected: None,
        expected_target: None,
        eol: Eol::Lf,
        bom: false,
    };
    conns
        .sftp
        .write_text(&ssh, HOST_ID, write("one\n"))
        .await
        .unwrap();

    let home = tempfile::tempdir().unwrap();
    let launcher = Arc::new(Recorder::default());
    let edits = ExternalEdits::with_quiet(
        home.path(),
        conns.clone(),
        launcher.clone(),
        Arc::new(|| Opener::System),
        Duration::from_millis(100),
    );
    let f = edits
        .open(OpenRequest {
            connection_id: HOST_ID,
            path: &path,
            size: None,
            confirm_large: false,
            confirm_sensitive: false,
        })
        .await
        .unwrap();
    let copy = launcher.0.lock().unwrap()[0].clone();
    assert_eq!(std::fs::read(&copy).unwrap(), b"one\n");

    std::fs::write(&copy, b"two\n").unwrap();
    until(&edits, &f.id, |f| f.last_uploaded_at.is_some()).await;
    let server = conns.sftp.read_text(&ssh, HOST_ID, &path).await.unwrap();
    assert_eq!(server.text, "two\n");

    conns
        .sftp
        .write_text(&ssh, HOST_ID, write("server\n"))
        .await
        .unwrap();
    std::fs::write(&copy, b"mine\n").unwrap();
    until(&edits, &f.id, |f| f.state == State::Conflict).await;
    let server = conns.sftp.read_text(&ssh, HOST_ID, &path).await.unwrap();
    assert_eq!(server.text, "server\n");
    edits
        .resolve(&f.id, Choice::UseServer, false)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&copy).unwrap(), b"server\n");

    edits.stop(&f.id, false).await.unwrap();
    assert!(!copy.exists());

    // A linked parent directory leads to a credentials file: the confirm is asked.
    exec(
        &ssh,
        &format!(
            "mkdir -p {base}/.aws && printf x > {base}/.aws/credentials && ln -s .aws {base}/k"
        ),
    )
    .await;
    let linked = format!("{base}/k/credentials");
    let err = edits
        .open(OpenRequest {
            connection_id: HOST_ID,
            path: &linked,
            size: None,
            confirm_large: false,
            confirm_sensitive: false,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code(), "sensitive");
    conns.sftp.delete(&ssh, HOST_ID, &base, true).await.unwrap();
}
