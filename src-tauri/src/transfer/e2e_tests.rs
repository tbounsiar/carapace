//! Transfers against the disposable sshd in `e2e/sshd`. Run only with `CARAPACE_E2E=1` after
//! `node e2e/sshd/setup.mjs up`.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::types::TransferState;
use super::*;
use crate::files::FileEntry;
use crate::localfs;
use crate::sftp::SftpManager;
use crate::ssh::test_server::{E2E_SERVER, isolated_manager, target};
use crate::ssh::{ConnectEvent, SshManager, TargetAuth};

const HOST_ID: &str = "e2e-transfer";

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
    localfs::display(&fs::canonicalize(path).unwrap()).unwrap()
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

struct World {
    _known: tempfile::TempDir,
    local: tempfile::TempDir,
    conns: Arc<Conns>,
    m: TransferManager,
    rx: mpsc::UnboundedReceiver<TransferEvent>,
    /// A fresh directory under the remote home, removed at the end of the test.
    base: String,
}

async fn connected() -> World {
    let known = tempfile::tempdir().unwrap();
    let ssh = Arc::new(isolated_manager(known.path()));
    let target = target(
        HOST_ID,
        2222,
        "carapace",
        TargetAuth::Key {
            key_path: key_path(),
            passphrase: None,
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
    let conns = Arc::new(Conns {
        ssh,
        sftp: SftpManager::default(),
    });
    let name = format!("e2e-transfer-{}", uuid::Uuid::new_v4().simple());
    let base = conns
        .sftp
        .mkdir(&conns.ssh, HOST_ID, "", &name)
        .await
        .unwrap()
        .path;
    let m = TransferManager::new(conns.clone());
    let (tx, rx) = mpsc::unbounded_channel();
    m.subscribe(Arc::new(move |e| tx.send(e).is_ok()));
    World {
        _known: known,
        local: tempfile::tempdir().unwrap(),
        conns,
        m,
        rx,
        base,
    }
}

fn pseudo_random(seed: u64, len: usize) -> Vec<u8> {
    super::tests::bytes(seed, len)
}

fn sha(path: &str) -> Vec<u8> {
    Sha256::digest(fs::read(path).unwrap()).to_vec()
}

impl World {
    fn lp(&self, rel: &str) -> String {
        let root = localfs::display(&fs::canonicalize(self.local.path()).unwrap()).unwrap();
        rel.split('/')
            .fold(Path::new(&root).to_path_buf(), |p, c| p.join(c))
            .to_string_lossy()
            .into_owned()
    }

    fn remote(&self, rel: &str) -> String {
        format!("{}/{rel}", self.base)
    }

    async fn enqueue(
        &self,
        direction: Direction,
        sources: Vec<String>,
        target: &str,
        conflict: ConflictPolicy,
    ) -> Vec<String> {
        self.m
            .enqueue(EnqueueRequest {
                connection_id: HOST_ID.into(),
                direction,
                sources,
                target_dir: target.into(),
                conflict,
            })
            .await
            .unwrap()
    }

    /// Next event, or a panic after 60 s.
    async fn next(&mut self) -> TransferEvent {
        timeout(Duration::from_secs(60), self.rx.recv())
            .await
            .expect("no transfer event")
            .unwrap()
    }

    async fn finish(&mut self, ids: &[String]) -> Vec<TransferView> {
        let mut done = std::collections::HashMap::new();
        while done.len() < ids.len() {
            if let TransferEvent::Updated { transfer } = self.next().await
                && transfer.state.finished()
                && ids.contains(&transfer.id)
            {
                done.insert(transfer.id.clone(), transfer);
            }
        }
        ids.iter().map(|id| done[id].clone()).collect()
    }

    async fn list(&self, rel: &str) -> Vec<FileEntry> {
        self.conns
            .sftp
            .list(&self.conns.ssh, HOST_ID, &self.remote(rel))
            .await
            .unwrap()
            .entries
    }

    async fn cleanup(self) {
        self.conns
            .sftp
            .delete(&self.conns.ssh, HOST_ID, &self.base, true)
            .await
            .unwrap();
    }
}

fn assert_done(views: &[TransferView]) {
    for v in views {
        assert_eq!(v.state, TransferState::Done, "{v:?}");
    }
}

#[tokio::test]
async fn round_trip_keeps_contents() {
    if !enabled() {
        return;
    }
    let _server = E2E_SERVER.read().await;
    let mut w = connected().await;
    fs::write(w.lp("big.bin"), pseudo_random(7, 5 * 1024 * 1024)).unwrap();
    fs::create_dir_all(w.lp("tree/sub/deeper")).unwrap();
    fs::write(w.lp("tree/top.txt"), b"top").unwrap();
    fs::write(w.lp("tree/sub/x.bin"), pseudo_random(8, 100_000)).unwrap();
    fs::write(w.lp("tree/sub/deeper/y.txt"), b"").unwrap();

    let ids = w
        .enqueue(
            Direction::Upload,
            vec![w.lp("big.bin"), w.lp("tree")],
            &w.base.clone(),
            ConflictPolicy::Ask,
        )
        .await;
    let views = w.finish(&ids).await;
    assert_done(&views);
    assert_eq!(views[0].done_bytes, 5 * 1024 * 1024);
    assert_eq!(views[1].done_files, 3);
    let top = w.list("").await;
    let big = top.iter().find(|e| e.name == "big.bin").unwrap();
    assert_eq!(big.permissions.as_deref(), Some("rw-r--r--"));
    let tree = top.iter().find(|e| e.name == "tree").unwrap();
    assert_eq!(tree.permissions.as_deref(), Some("rwxr-xr-x"));
    assert!(!top.iter().any(|e| e.name.ends_with(".carapace-part")));

    fs::create_dir(w.lp("back")).unwrap();
    let ids = w
        .enqueue(
            Direction::Download,
            vec![w.remote("big.bin"), w.remote("tree")],
            &w.lp("back"),
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&w.finish(&ids).await);
    for rel in [
        "big.bin",
        "tree/top.txt",
        "tree/sub/x.bin",
        "tree/sub/deeper/y.txt",
    ] {
        assert_eq!(sha(&w.lp(rel)), sha(&w.lp(&format!("back/{rel}"))), "{rel}");
    }
    w.cleanup().await;
}

#[tokio::test]
async fn ask_then_keep_both_renames() {
    if !enabled() {
        return;
    }
    let _server = E2E_SERVER.read().await;
    let mut w = connected().await;
    fs::write(w.lp("notes.txt"), b"one").unwrap();
    let base = w.base.clone();
    let ids = w
        .enqueue(
            Direction::Upload,
            vec![w.lp("notes.txt")],
            &base,
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&w.finish(&ids).await);
    fs::write(w.lp("notes.txt"), b"two").unwrap();
    let ids = w
        .enqueue(
            Direction::Upload,
            vec![w.lp("notes.txt")],
            &base,
            ConflictPolicy::Ask,
        )
        .await;
    let conflict_id = loop {
        if let TransferEvent::Conflict {
            job_id,
            conflict_id,
            path,
            existing_size,
            ..
        } = w.next().await
        {
            assert_eq!(job_id, ids[0]);
            assert_eq!(path, w.remote("notes.txt"));
            assert_eq!(existing_size, Some(3));
            break conflict_id;
        }
    };
    w.m.answer(&ids[0], conflict_id, Decision::Rename, false)
        .unwrap();
    assert_done(&w.finish(&ids).await);
    let mut names: Vec<String> = w.list("").await.into_iter().map(|e| e.name).collect();
    names.sort();
    assert_eq!(names, ["notes (1).txt", "notes.txt"]);

    fs::create_dir(w.lp("dl")).unwrap();
    let ids = w
        .enqueue(
            Direction::Download,
            vec![w.remote("notes (1).txt")],
            &w.lp("dl"),
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&w.finish(&ids).await);
    assert_eq!(fs::read(w.lp("dl/notes (1).txt")).unwrap(), b"two");
    w.cleanup().await;
}

#[tokio::test]
async fn cancel_mid_transfer_leaves_no_part_file() {
    if !enabled() {
        return;
    }
    let _server = E2E_SERVER.read().await;
    let mut w = connected().await;
    fs::write(w.lp("huge.bin"), pseudo_random(9, 64 * 1024 * 1024)).unwrap();
    let base = w.base.clone();
    let ids = w
        .enqueue(
            Direction::Upload,
            vec![w.lp("huge.bin")],
            &base,
            ConflictPolicy::Ask,
        )
        .await;
    loop {
        if let TransferEvent::Updated { transfer } = w.next().await
            && transfer.done_bytes > 0
        {
            assert!(
                !transfer.state.finished(),
                "finished before it could be cancelled"
            );
            break;
        }
    }
    let started = Instant::now();
    w.m.cancel(&ids[0]).unwrap();
    let v = w.finish(&ids).await;
    assert_eq!(v[0].state, TransferState::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(
        w.list("").await.is_empty(),
        "no file and no .carapace-part left"
    );
    w.cleanup().await;
}
