use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio::time::timeout;

use super::manager::{MAX_RUNNING, PROGRESS_INTERVAL, progress_due, running_count};
use super::types::TransferState;
use super::*;
use crate::files::FsError;
use crate::localfs;
use crate::sftp::SftpManager;
use crate::ssh::test_server::{Connected, TestServer, manager_for, start_server};
use crate::ssh::test_sftp::{HOME, Node};

const CONN: &str = "h1";

struct TestConns {
    ssh: Connected,
    sftp: SftpManager,
}

impl Connections for TestConns {
    fn remote<'a>(&'a self, connection_id: &'a str) -> RemoteFuture<'a> {
        Box::pin(async move { self.sftp.channel(&self.ssh.manager, connection_id).await })
    }
}

pub fn bytes(seed: u64, len: usize) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

#[derive(Default)]
struct Seen {
    views: HashMap<String, TransferView>,
    /// Job id, destination path, conflict id.
    conflicts: Vec<(String, String, u64)>,
    removed: Vec<String>,
    /// `updated` events per job while running.
    running_updates: HashMap<String, usize>,
    max_running: usize,
}

impl Seen {
    fn apply(&mut self, event: TransferEvent) {
        match event {
            TransferEvent::Updated { transfer } => {
                if transfer.state == TransferState::Running {
                    *self.running_updates.entry(transfer.id.clone()).or_default() += 1;
                }
                self.views.insert(transfer.id.clone(), transfer);
                let running = self
                    .views
                    .values()
                    .filter(|v| v.state == TransferState::Running)
                    .count();
                self.max_running = self.max_running.max(running);
            }
            TransferEvent::Conflict {
                job_id,
                path,
                conflict_id,
                ..
            } => self.conflicts.push((job_id, path, conflict_id)),
            TransferEvent::Removed { job_ids } => self.removed.extend(job_ids),
        }
    }

    fn state(&self, id: &str) -> Option<TransferState> {
        self.views.get(id).map(|v| v.state)
    }
}

struct World {
    server: TestServer,
    conns: Arc<TestConns>,
    m: TransferManager,
    rx: mpsc::UnboundedReceiver<TransferEvent>,
    seen: Seen,
    local: tempfile::TempDir,
}

fn s(p: &Path) -> String {
    localfs::display(&fs::canonicalize(p).unwrap()).unwrap()
}

fn home(rest: &str) -> String {
    format!("{HOME}/{rest}")
}

async fn world(seed: u8) -> World {
    let server = start_server(seed).await;
    let ssh = manager_for(&server, CONN);
    ssh.connect().await.unwrap();
    let conns = Arc::new(TestConns {
        ssh,
        sftp: SftpManager::default(),
    });
    let m = TransferManager::new(conns.clone());
    let (tx, rx) = mpsc::unbounded_channel();
    m.subscribe(Arc::new(move |e| tx.send(e).is_ok()));
    World {
        server,
        conns,
        m,
        rx,
        seen: Seen::default(),
        local: tempfile::tempdir().unwrap(),
    }
}

impl World {
    fn root(&self) -> PathBuf {
        PathBuf::from(s(self.local.path()))
    }

    fn lp(&self, rel: &str) -> String {
        self.root().join(rel).to_string_lossy().into_owned()
    }

    async fn enqueue(
        &self,
        direction: Direction,
        sources: &[String],
        target: &str,
        conflict: ConflictPolicy,
    ) -> Result<Vec<String>, FsError> {
        self.m
            .enqueue(EnqueueRequest {
                connection_id: CONN.into(),
                direction,
                sources: sources.to_vec(),
                target_dir: target.into(),
                conflict,
            })
            .await
    }

    async fn until(&mut self, what: &str, done: impl Fn(&Seen) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !done(&self.seen) {
            let left = deadline.saturating_duration_since(Instant::now());
            match timeout(left, self.rx.recv()).await {
                Ok(Some(e)) => self.seen.apply(e),
                _ => panic!("timed out waiting for {what}"),
            }
        }
    }

    async fn finish(&mut self, ids: &[String]) -> Vec<TransferView> {
        self.until("jobs to finish", |s| {
            ids.iter()
                .all(|id| s.state(id).is_some_and(TransferState::finished))
        })
        .await;
        ids.iter().map(|id| self.seen.views[id].clone()).collect()
    }

    async fn run(
        &mut self,
        direction: Direction,
        sources: &[String],
        target: &str,
        conflict: ConflictPolicy,
    ) -> Vec<TransferView> {
        let ids = self
            .enqueue(direction, sources, target, conflict)
            .await
            .unwrap();
        self.finish(&ids).await
    }
}

fn assert_done(v: &TransferView) {
    assert_eq!(v.state, TransferState::Done, "{v:?}");
    assert_eq!(v.error, None);
}

fn no_temp_files(paths: &[String]) {
    assert!(
        !paths.iter().any(|p| p.ends_with(".carapace-part")),
        "{paths:?}"
    );
}

fn local_tree(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            out.push(p.to_string_lossy().into_owned());
            if fs::symlink_metadata(&p).unwrap().is_dir() {
                stack.push(p);
            }
        }
    }
    out.sort();
    out
}

#[tokio::test]
async fn uploads_and_downloads_files_and_trees() {
    let mut w = world(120).await;
    let a = bytes(1, 300 * 1024 + 7);
    let b = bytes(2, 3 * 64 * 1024);
    fs::write(w.lp("a.bin"), &a).unwrap();
    fs::create_dir_all(w.lp("tree/sub")).unwrap();
    fs::create_dir(w.lp("tree/empty")).unwrap();
    fs::write(w.lp("tree/sub/b.bin"), &b).unwrap();
    fs::write(w.lp("tree/c.txt"), b"").unwrap();

    let views = w
        .run(
            Direction::Upload,
            &[w.lp("a.bin"), w.lp("tree")],
            HOME,
            ConflictPolicy::Ask,
        )
        .await;
    for v in &views {
        assert_done(v);
        assert_eq!(v.done_bytes, v.total_bytes.unwrap());
        assert_eq!(Some(v.done_files), v.total_files);
        assert_eq!(v.target_dir, HOME);
    }
    assert_eq!(
        (views[0].name.as_str(), views[0].total_bytes),
        ("a.bin", Some(a.len() as u64))
    );
    assert_eq!(views[1].total_files, Some(2));
    let fs_ = w.server.fs();
    assert_eq!(fs_.contents(&home("a.bin")).unwrap(), a);
    assert_eq!(fs_.contents(&home("tree/sub/b.bin")).unwrap(), b);
    assert_eq!(fs_.contents(&home("tree/c.txt")).unwrap(), b"");
    assert_eq!(
        fs_.get(&home("tree/empty")),
        Some(Node::Dir { denied: false })
    );
    no_temp_files(&fs_.paths_under(HOME));

    fs::create_dir(w.lp("back")).unwrap();
    let views = w
        .run(
            Direction::Download,
            &[home("a.bin"), home("tree")],
            &w.lp("back"),
            ConflictPolicy::Ask,
        )
        .await;
    views.iter().for_each(assert_done);
    assert_eq!(fs::read(w.lp("back/a.bin")).unwrap(), a);
    assert_eq!(fs::read(w.lp("back/tree/sub/b.bin")).unwrap(), b);
    assert_eq!(fs::read(w.lp("back/tree/c.txt")).unwrap(), b"");
    assert!(fs::metadata(w.lp("back/tree/empty")).unwrap().is_dir());
    no_temp_files(&local_tree(&w.root()));
}

#[tokio::test]
async fn conflict_policies_skip_overwrite_and_rename() {
    let mut w = world(121).await;
    w.server.fs().data(&home("a.txt"), b"old".to_vec());
    fs::write(w.lp("a.txt"), b"new").unwrap();
    let src = [w.lp("a.txt")];

    let v = w
        .run(Direction::Upload, &src, HOME, ConflictPolicy::Skip)
        .await;
    assert_done(&v[0]);
    assert_eq!(
        (v[0].skipped, v[0].done_files, v[0].total_files),
        (1, 0, Some(0))
    );
    assert_eq!(w.server.fs().contents(&home("a.txt")).unwrap(), b"old");

    let v = w
        .run(Direction::Upload, &src, HOME, ConflictPolicy::Rename)
        .await;
    assert_done(&v[0]);
    let v = w
        .run(Direction::Upload, &src, HOME, ConflictPolicy::Rename)
        .await;
    assert_done(&v[0]);
    assert_eq!(w.server.fs().contents(&home("a (1).txt")).unwrap(), b"new");
    assert_eq!(w.server.fs().contents(&home("a (2).txt")).unwrap(), b"new");
    assert_eq!(w.server.fs().contents(&home("a.txt")).unwrap(), b"old");

    let v = w
        .run(Direction::Upload, &src, HOME, ConflictPolicy::Overwrite)
        .await;
    assert_done(&v[0]);
    assert_eq!(w.server.fs().contents(&home("a.txt")).unwrap(), b"new");

    // Overwriting a symlink replaces the link itself, never its target.
    w.server.fs().data("/keep", b"precious".to_vec());
    w.server.fs().link(&home("a.txt"), "/keep");
    let v = w
        .run(Direction::Upload, &src, HOME, ConflictPolicy::Overwrite)
        .await;
    assert_done(&v[0]);
    assert_eq!(w.server.fs().contents(&home("a.txt")).unwrap(), b"new");
    assert_eq!(w.server.fs().contents("/keep").unwrap(), b"precious");

    // A directory in the way of a file is never replaced.
    w.server.fs().dir(&home("d.txt"));
    fs::write(w.lp("d.txt"), b"x").unwrap();
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("d.txt")],
            HOME,
            ConflictPolicy::Overwrite,
        )
        .await;
    assert_eq!(v[0].state, TransferState::Failed);
    assert_eq!(v[0].error.as_ref().unwrap().code, "already_exists");

    // Local side: overwrite, rename, skip.
    fs::create_dir(w.lp("dl")).unwrap();
    fs::write(w.lp("dl/a.txt"), b"local").unwrap();
    let remote = [home("a.txt")];
    let dl = w.lp("dl");
    let v = w
        .run(Direction::Download, &remote, &dl, ConflictPolicy::Rename)
        .await;
    assert_done(&v[0]);
    assert_eq!(fs::read(w.lp("dl/a (1).txt")).unwrap(), b"new");
    let v = w
        .run(Direction::Download, &remote, &dl, ConflictPolicy::Skip)
        .await;
    assert_eq!(v[0].skipped, 1);
    assert_eq!(fs::read(w.lp("dl/a.txt")).unwrap(), b"local");
    let v = w
        .run(Direction::Download, &remote, &dl, ConflictPolicy::Overwrite)
        .await;
    assert_done(&v[0]);
    assert_eq!(fs::read(w.lp("dl/a.txt")).unwrap(), b"new");
    no_temp_files(&local_tree(&w.root()));
}

#[tokio::test]
async fn ask_pauses_the_job_and_applies_to_all() {
    let mut w = world(122).await;
    let fs_ = w.server.fs().clone();
    fs_.dir(&home("tree"));
    fs_.data(&home("tree/x"), b"old-x".to_vec());
    fs_.data(&home("tree/y"), b"old-y".to_vec());
    fs::create_dir(w.lp("tree")).unwrap();
    for n in ["x", "y", "z"] {
        fs::write(w.lp(&format!("tree/{n}")), n).unwrap();
    }
    let ids = w
        .enqueue(
            Direction::Upload,
            &[w.lp("tree")],
            HOME,
            ConflictPolicy::Ask,
        )
        .await
        .unwrap();
    let id = ids[0].clone();
    w.until("a conflict", |s| !s.conflicts.is_empty()).await;
    let (job, path, conflict_id) = w.seen.conflicts[0].clone();
    assert_eq!((job, path), (id.clone(), home("tree/x")));
    w.until("waiting state", |s| {
        s.state(&id) == Some(TransferState::WaitingConflict)
    })
    .await;
    assert_eq!(running_count(&w.m), 0, "a waiting job gives its slot back");

    // A reloaded page subscribes again and gets the pending conflict.
    let (tx, mut rx2) = mpsc::unbounded_channel();
    let views = w.m.subscribe(Arc::new(move |e| tx.send(e).is_ok()));
    assert_eq!(views[0].state, TransferState::WaitingConflict);
    match rx2.recv().await.unwrap() {
        TransferEvent::Conflict {
            job_id,
            conflict_id: resent,
            path,
            existing_size,
            incoming_size,
            ..
        } => {
            assert_eq!((job_id, path), (id.clone(), home("tree/x")));
            assert_eq!(resent, conflict_id, "the re-sent conflict keeps its id");
            assert_eq!((existing_size, incoming_size), (Some(5), Some(1)));
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(
        w.m.answer("nope", conflict_id, Decision::Skip, false)
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(
        w.m.answer(&id, conflict_id + 1, Decision::Skip, false)
            .unwrap_err()
            .code(),
        "invalid_input",
        "an answer naming another conflict is refused"
    );
    w.m.answer(&id, conflict_id, Decision::Rename, true)
        .unwrap();
    assert_eq!(
        w.m.answer(&id, conflict_id, Decision::Skip, false)
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    let mut last = None;
    while let Ok(Some(e)) = timeout(Duration::from_secs(10), rx2.recv()).await {
        assert!(!matches!(e, TransferEvent::Conflict { .. }), "asked twice");
        if let TransferEvent::Updated { transfer } = &e
            && transfer.state.finished()
        {
            last = Some(transfer.clone());
            break;
        }
    }
    assert_done(&last.unwrap());
    assert_eq!(fs_.contents(&home("tree/x")).unwrap(), b"old-x");
    assert_eq!(fs_.contents(&home("tree/x (1)")).unwrap(), b"x");
    assert_eq!(fs_.contents(&home("tree/y (1)")).unwrap(), b"y");
    assert_eq!(fs_.contents(&home("tree/z")).unwrap(), b"z");
}

#[tokio::test]
async fn cancel_removes_the_temp_file_and_keeps_finished_files() {
    let mut w = world(123).await;
    fs::create_dir(w.lp("tree")).unwrap();
    fs::write(w.lp("tree/a-small"), b"done").unwrap();
    fs::write(w.lp("tree/b-big"), bytes(3, 4 * 1024 * 1024)).unwrap();
    w.server.fs().set_delay(5);
    let ids = w
        .enqueue(
            Direction::Upload,
            &[w.lp("tree")],
            HOME,
            ConflictPolicy::Ask,
        )
        .await
        .unwrap();
    let id = ids[0].clone();
    w.until("progress on the big file", |s| {
        s.views
            .get(&id)
            .is_some_and(|v| v.done_files == 1 && v.done_bytes > 4)
    })
    .await;
    assert_eq!(
        w.server.fs().mode(&home("tree/.b-big.carapace-part")),
        Some(0o600),
        "the part file is owner-only while it is written"
    );
    w.m.cancel(&id).unwrap();
    let v = w.finish(&ids).await;
    assert_eq!(v[0].state, TransferState::Cancelled);
    assert_eq!(v[0].error, None);
    let paths = w.server.fs().paths_under(HOME);
    assert!(paths.contains(&home("tree/a-small")));
    assert!(!paths.contains(&home("tree/b-big")));
    no_temp_files(&paths);
    w.m.cancel(&id).unwrap();
    assert_eq!(w.m.cancel("nope").unwrap_err().code(), "not_found");

    w.server.fs().data(&home("big"), bytes(4, 4 * 1024 * 1024));
    let ids = w
        .enqueue(
            Direction::Download,
            &[home("big")],
            &w.lp(""),
            ConflictPolicy::Ask,
        )
        .await
        .unwrap();
    let id = ids[0].clone();
    w.until("download progress", |s| {
        s.views.get(&id).is_some_and(|v| v.done_bytes > 0)
    })
    .await;
    w.m.cancel(&id).unwrap();
    assert_eq!(w.finish(&ids).await[0].state, TransferState::Cancelled);
    let local = local_tree(&w.root());
    no_temp_files(&local);
    assert!(!Path::new(&w.lp("big")).exists());
}

#[tokio::test]
async fn symlinks_are_skipped_on_both_sides() {
    let mut w = world(124).await;
    let fs_ = w.server.fs().clone();
    fs_.dir(&home("tree"));
    fs_.data(&home("tree/f"), b"f".to_vec());
    fs_.link(&home("tree/to-root"), "/");
    fs_.link(&home("tree/to-file"), &home("tree/f"));
    fs_.link(&home("lonely"), "/");
    let v = w
        .run(
            Direction::Download,
            &[home("tree"), home("lonely")],
            &w.lp(""),
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!((v[0].skipped, v[0].done_files), (2, 1));
    assert_done(&v[1]);
    assert_eq!(v[1].skipped, 1);
    let mut names: Vec<String> = fs::read_dir(w.lp("tree"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["f"]);
    assert!(!Path::new(&w.lp("lonely")).exists());

    fs::create_dir_all(w.lp("up/real")).unwrap();
    fs::write(w.lp("up/real/x"), b"x").unwrap();
    let linked = local_dir_link(
        &w.root().join("up").join("real"),
        &w.root().join("up").join("link"),
    );
    if !linked {
        eprintln!("skipped: the OS refused to create a directory link");
    }
    let v = w
        .run(Direction::Upload, &[w.lp("up")], HOME, ConflictPolicy::Ask)
        .await;
    assert_done(&v[0]);
    assert_eq!(v[0].skipped, u64::from(linked));
    assert_eq!(fs_.contents(&home("up/real/x")).unwrap(), b"x");
    assert_eq!(fs_.get(&home("up/link")), None);
}

/// A directory link the OS lets us create without privileges (a junction on Windows).
fn local_dir_link(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success())
    }
}

#[tokio::test]
async fn local_destination_links_are_never_written_through() {
    let mut w = world(125).await;
    w.server.fs().dir(&home("tree"));
    w.server.fs().data(&home("tree/x"), b"x".to_vec());
    fs::create_dir_all(w.lp("dl")).unwrap();
    fs::create_dir_all(w.lp("elsewhere")).unwrap();
    if !local_dir_link(
        &w.root().join("elsewhere"),
        &w.root().join("dl").join("tree"),
    ) {
        eprintln!("skipped: the OS refused to create a directory link");
        return;
    }
    let v = w
        .run(
            Direction::Download,
            &[home("tree")],
            &w.lp("dl"),
            ConflictPolicy::Skip,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!(fs::read_dir(w.lp("elsewhere")).unwrap().count(), 0);
    let v = w
        .run(
            Direction::Download,
            &[home("tree")],
            &w.lp("dl"),
            ConflictPolicy::Rename,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!(fs::read(w.lp("dl/tree (1)/x")).unwrap(), b"x");
    assert_eq!(fs::read_dir(w.lp("elsewhere")).unwrap().count(), 0);
    let v = w
        .run(
            Direction::Download,
            &[home("tree")],
            &w.lp("dl"),
            ConflictPolicy::Overwrite,
        )
        .await;
    assert_done(&v[0]);
    assert!(
        !fs::symlink_metadata(w.lp("dl/tree"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(w.lp("dl/tree/x")).unwrap(), b"x");
    assert!(Path::new(&w.lp("elsewhere")).is_dir());
    assert_eq!(fs::read_dir(w.lp("elsewhere")).unwrap().count(), 0);
}

#[tokio::test]
async fn runs_at_most_three_jobs_at_once() {
    let mut w = world(126).await;
    w.server.fs().set_delay(3);
    let mut sources = Vec::new();
    for i in 0..7 {
        let p = w.lp(&format!("f{i}"));
        fs::write(&p, bytes(i, 256 * 1024)).unwrap();
        sources.push(p);
    }
    let ids = w
        .enqueue(Direction::Upload, &sources, HOME, ConflictPolicy::Ask)
        .await
        .unwrap();
    let views = w.finish(&ids).await;
    views.iter().for_each(assert_done);
    assert_eq!(w.seen.max_running, MAX_RUNNING);
    assert_eq!(running_count(&w.m), 0);
    assert_eq!(w.server.sftp_opens(), 1, "all jobs share one SFTP channel");
}

#[tokio::test]
async fn connection_drop_fails_running_and_queued_jobs() {
    let mut w = world(127).await;
    w.server.fs().set_delay(20);
    let mut sources = Vec::new();
    for i in 0..5 {
        let p = w.lp(&format!("f{i}"));
        fs::write(&p, bytes(i, 1024 * 1024)).unwrap();
        sources.push(p);
    }
    fs::create_dir(w.lp("dl")).unwrap();
    w.server.fs().data(&home("r"), bytes(9, 1024 * 1024));
    let mut ids = w
        .enqueue(Direction::Upload, &sources, HOME, ConflictPolicy::Ask)
        .await
        .unwrap();
    ids.extend(
        w.enqueue(
            Direction::Download,
            &[home("r")],
            &w.lp("dl"),
            ConflictPolicy::Ask,
        )
        .await
        .unwrap(),
    );
    let first = ids[0].clone();
    w.until("progress", |s| {
        s.views.get(&first).is_some_and(|v| v.done_bytes > 0)
    })
    .await;
    w.server.drop_clients().await;
    for v in w.finish(&ids).await {
        assert_eq!(v.state, TransferState::Failed, "{v:?}");
        assert_eq!(v.error.unwrap().code, "not_connected");
    }
    no_temp_files(&local_tree(&w.root()));
    assert_eq!(
        w.enqueue(Direction::Upload, &sources[..1], HOME, ConflictPolicy::Ask)
            .await
            .unwrap_err(),
        FsError::NotConnected
    );
}

#[test]
fn progress_is_due_every_interval() {
    let t = Instant::now();
    assert!(progress_due(None, t));
    assert!(!progress_due(Some(t), t + PROGRESS_INTERVAL / 2));
    assert!(progress_due(Some(t), t + PROGRESS_INTERVAL));
}

#[tokio::test]
async fn progress_events_are_throttled() {
    let mut w = world(128).await;
    w.server.fs().set_delay(2);
    fs::write(w.lp("f"), bytes(5, 4 * 1024 * 1024)).unwrap();
    let started = Instant::now();
    let v = w
        .run(Direction::Upload, &[w.lp("f")], HOME, ConflictPolicy::Ask)
        .await;
    let elapsed = started.elapsed();
    assert_done(&v[0]);
    let updates = w.seen.running_updates[&v[0].id];
    let allowed = (elapsed.as_millis() / PROGRESS_INTERVAL.as_millis()) as usize + 3;
    assert!(updates <= allowed, "{updates} updates in {elapsed:?}");
    assert!(updates >= 2, "progress was reported");
}

#[tokio::test]
async fn validates_requests_up_front() {
    let w = world(129).await;
    fs::write(w.lp("f"), b"x").unwrap();
    let code = |r: Result<Vec<String>, FsError>| r.unwrap_err().code();
    let f = [w.lp("f")];
    assert_eq!(
        code(
            w.enqueue(Direction::Upload, &[], HOME, ConflictPolicy::Ask)
                .await
        ),
        "invalid_input"
    );
    let many = vec![w.lp("f"); manager::MAX_SOURCES + 1];
    assert_eq!(
        code(
            w.enqueue(Direction::Upload, &many, HOME, ConflictPolicy::Ask)
                .await
        ),
        "invalid_input"
    );
    assert_eq!(
        code(
            w.enqueue(
                Direction::Upload,
                &["rel/f".into()],
                HOME,
                ConflictPolicy::Ask
            )
            .await
        ),
        "invalid_input"
    );
    assert_eq!(
        code(
            w.enqueue(Direction::Upload, &f, "relative", ConflictPolicy::Ask)
                .await
        ),
        "invalid_input"
    );
    assert_eq!(
        code(
            w.enqueue(
                Direction::Download,
                &["/".into()],
                &w.lp(""),
                ConflictPolicy::Ask
            )
            .await
        ),
        "invalid_input"
    );
    assert_eq!(
        code(
            w.enqueue(
                Direction::Download,
                &[home("x")],
                "relative",
                ConflictPolicy::Ask
            )
            .await
        ),
        "invalid_input"
    );
    let other =
        w.m.enqueue(EnqueueRequest {
            connection_id: "other".into(),
            direction: Direction::Upload,
            sources: f.to_vec(),
            target_dir: HOME.into(),
            conflict: ConflictPolicy::Ask,
        })
        .await;
    assert_eq!(code(other), "not_connected");
    assert!(w.m.list().is_empty());

    let ids = w
        .enqueue(Direction::Upload, &f, "", ConflictPolicy::Ask)
        .await
        .unwrap();
    assert_eq!(
        w.m.list()[0].target_dir,
        HOME,
        "an empty target is the home"
    );
    let _ = ids;
}

#[tokio::test]
async fn missing_sources_and_targets_fail_the_job() {
    let mut w = world(130).await;
    fs::write(w.lp("f"), b"x").unwrap();
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("missing")],
            HOME,
            ConflictPolicy::Ask,
        )
        .await;
    assert_eq!(v[0].error.as_ref().unwrap().code, "not_found");
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("f")],
            &home("nope"),
            ConflictPolicy::Ask,
        )
        .await;
    assert_eq!(v[0].error.as_ref().unwrap().code, "not_found");
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("f")],
            &home(".profile"),
            ConflictPolicy::Ask,
        )
        .await;
    assert_eq!(v[0].error.as_ref().unwrap().code, "invalid_input");
}

#[tokio::test]
async fn queue_is_bounded() {
    let mut w = world(131).await;
    w.server.fs().set_delay(1000);
    fs::write(w.lp("big"), bytes(1, 1024 * 1024)).unwrap();
    let mut ids = Vec::new();
    for _ in 0..2 {
        let batch = vec![w.lp("big"); manager::MAX_SOURCES];
        ids.extend(
            w.enqueue(Direction::Upload, &batch, HOME, ConflictPolicy::Rename)
                .await
                .unwrap(),
        );
    }
    assert_eq!(ids.len(), manager::MAX_PENDING);
    let err = w
        .enqueue(
            Direction::Upload,
            &[w.lp("big")],
            HOME,
            ConflictPolicy::Rename,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "too_large");
    w.server.fs().set_delay(0);
    for id in &ids {
        w.m.cancel(id).unwrap();
    }
    let views = w.finish(&ids).await;
    assert!(views.iter().all(|v| v.state == TransferState::Cancelled));
    w.m.clear_finished();
    w.until("removal", |s| s.removed.len() == manager::MAX_PENDING)
        .await;
    assert!(w.m.list().is_empty());
}

#[tokio::test]
async fn a_failing_emitter_does_not_wedge_the_queue() {
    let w = world(132).await;
    w.m.subscribe(Arc::new(|_| false));
    fs::write(w.lp("f"), b"x").unwrap();
    w.enqueue(Direction::Upload, &[w.lp("f")], HOME, ConflictPolicy::Ask)
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while w.m.list()[0].state != TransferState::Done {
        assert!(Instant::now() < deadline, "{:?}", w.m.list());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(w.server.fs().contents(&home("f")).unwrap(), b"x");
    let _ = &w.conns;
}

#[cfg(windows)]
#[tokio::test]
async fn remote_names_invalid_locally_are_skipped() {
    let mut w = world(133).await;
    w.server.fs().dir(&home("tree"));
    w.server.fs().data(&home("tree/a:b"), b"x".to_vec());
    w.server.fs().data(&home("tree/CON"), b"x".to_vec());
    w.server.fs().data(&home("tree/ok"), b"x".to_vec());
    let v = w
        .run(
            Direction::Download,
            &[home("tree")],
            &w.lp(""),
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!((v[0].skipped, v[0].done_files), (2, 1));
}

#[tokio::test]
async fn modes_follow_the_replaced_file_or_the_source() {
    let mut w = world(134).await;
    let fs_ = w.server.fs().clone();
    fs::write(w.lp("key"), b"new").unwrap();
    fs_.data(&home("key"), b"old".to_vec());
    fs_.set_mode(&home("key"), 0o4600);
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("key")],
            HOME,
            ConflictPolicy::Overwrite,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!(fs_.contents(&home("key")).unwrap(), b"new");
    assert_eq!(fs_.mode(&home("key")), Some(0o600), "setuid is dropped");

    fs::create_dir(w.lp("tree")).unwrap();
    fs::write(w.lp("tree/f"), b"f").unwrap();
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("tree")],
            HOME,
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&v[0]);
    #[cfg(windows)]
    {
        assert_eq!(fs_.mode(&home("tree")), Some(0o755));
        assert_eq!(fs_.mode(&home("tree/f")), Some(0o644));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let local = |p: &str| fs::metadata(w.lp(p)).unwrap().permissions().mode() & 0o777;
        assert_eq!(fs_.mode(&home("tree/f")), Some(local("tree/f")));
        assert_eq!(fs_.mode(&home("tree")), Some(local("tree") | 0o700));
    }

    fs_.data(&home("secret"), b"s".to_vec());
    fs_.set_mode(&home("secret"), 0o600);
    fs::create_dir(w.lp("dl")).unwrap();
    let v = w
        .run(
            Direction::Download,
            &[home("secret")],
            &w.lp("dl"),
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&v[0]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(w.lp("dl/secret"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn mode_choice() {
    use super::side::{Meta, dir_mode, file_mode};
    let meta = |kind, mode| Meta {
        kind,
        size: None,
        modified: None,
        mode,
    };
    let file = meta(crate::files::EntryKind::File, Some(0o100640));
    let link = meta(crate::files::EntryKind::Symlink, Some(0o120777));
    assert_eq!(file_mode(Some(&file), Some(0o755)), 0o640);
    assert_eq!(file_mode(Some(&link), Some(0o4755)), 0o755);
    assert_eq!(file_mode(None, Some(0o2711)), 0o711);
    assert_eq!(file_mode(None, None), 0o644);
    assert_eq!(
        file_mode(Some(&meta(crate::files::EntryKind::File, None)), None),
        0o644
    );
    assert_eq!(dir_mode(None), 0o755);
    assert_eq!(dir_mode(Some(0o41750)), 0o750);
    assert_eq!(dir_mode(Some(0o500)), 0o700);
}

#[tokio::test]
async fn overwrite_without_posix_rename_keeps_no_backup() {
    let mut w = world(135).await;
    let fs_ = w.server.fs().clone();
    fs_.set_posix_rename(false);
    fs_.data(&home("a.txt"), b"old".to_vec());
    fs::write(w.lp("a.txt"), b"new").unwrap();
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("a.txt")],
            HOME,
            ConflictPolicy::Overwrite,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!(fs_.contents(&home("a.txt")).unwrap(), b"new");
    let paths = fs_.paths_under(HOME);
    assert!(!paths.iter().any(|p| p.contains(".carapace-")), "{paths:?}");

    // A backup name already taken is never replaced.
    fs_.data(&home(".a.txt.carapace-old"), b"theirs".to_vec());
    fs::write(w.lp("a.txt"), b"newer").unwrap();
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("a.txt")],
            HOME,
            ConflictPolicy::Overwrite,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!(fs_.contents(&home("a.txt")).unwrap(), b"newer");
    assert_eq!(
        fs_.contents(&home(".a.txt.carapace-old")).unwrap(),
        b"theirs"
    );
    assert_eq!(fs_.get(&home(".a.txt.1.carapace-old")), None);
}

#[tokio::test]
async fn a_temp_name_in_use_is_left_alone() {
    let mut w = world(136).await;
    let fs_ = w.server.fs().clone();
    fs_.data(&home(".a.txt.carapace-part"), b"other writer".to_vec());
    fs::write(w.lp("a.txt"), b"mine").unwrap();
    let v = w
        .run(
            Direction::Upload,
            &[w.lp("a.txt")],
            HOME,
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!(fs_.contents(&home("a.txt")).unwrap(), b"mine");
    assert_eq!(
        fs_.contents(&home(".a.txt.carapace-part")).unwrap(),
        b"other writer"
    );
    assert_eq!(fs_.get(&home(".a.txt.1.carapace-part")), None);

    // Locally too, and a failed job never removes a temp it did not create.
    fs::create_dir(w.lp("dl")).unwrap();
    fs::write(w.lp("dl/.a.txt.carapace-part"), b"stale").unwrap();
    let v = w
        .run(
            Direction::Download,
            &[home("a.txt")],
            &w.lp("dl"),
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!(fs::read(w.lp("dl/a.txt")).unwrap(), b"mine");
    assert_eq!(fs::read(w.lp("dl/.a.txt.carapace-part")).unwrap(), b"stale");
}

#[tokio::test]
async fn hostile_names_are_dropped_and_counted() {
    let mut w = world(137).await;
    let fs_ = w.server.fs().clone();
    fs_.dir(&home("tree"));
    fs_.data(&home("tree/ok"), b"x".to_vec());
    fs_.add_listed_name("n".repeat(300));
    fs_.add_listed_name("a/b".into());
    let v = w
        .run(
            Direction::Download,
            &[home("tree")],
            &w.lp(""),
            ConflictPolicy::Ask,
        )
        .await;
    assert_done(&v[0]);
    assert_eq!((v[0].skipped, v[0].done_files), (2, 1));
}

#[test]
fn local_files_are_never_created_below_a_swapped_directory() {
    use super::side::create_local_temp;
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir_all(root.join("real").join("sub")).unwrap();
    fs::create_dir(root.join("elsewhere")).unwrap();
    assert!(create_local_temp(&root, &root.join("real").join("sub").join("f")).is_ok());
    if !local_dir_link(&root.join("elsewhere"), &root.join("swapped")) {
        eprintln!("skipped: the OS refused to create a directory link");
        return;
    }
    let err = create_local_temp(&root, &root.join("swapped").join("f")).unwrap_err();
    assert_eq!(err.code(), "io");
    assert_eq!(fs::read_dir(root.join("elsewhere")).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn same_file_compares_handles() {
    use super::side::same_file;
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    fs::write(&a, b"a").unwrap();
    fs::write(&b, b"b").unwrap();
    let open = |p: &Path| fs::File::open(p).unwrap();
    assert!(same_file(&open(&a), &open(&a)));
    assert!(!same_file(&open(&a), &open(&b)));
}

#[tokio::test]
async fn the_observer_sees_each_finished_job_once() {
    let server = start_server(47).await;
    let ssh = manager_for(&server, CONN);
    ssh.connect().await.unwrap();
    let conns = Arc::new(TestConns {
        ssh,
        sftp: SftpManager::default(),
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let m = TransferManager::with_observer(
        conns,
        Arc::new(move |v: &TransferView| {
            let _ = tx.send(v.clone());
        }),
    );
    let local = tempfile::tempdir().unwrap();
    fs::write(local.path().join("a.txt"), b"hi").unwrap();
    let ids = m
        .enqueue(EnqueueRequest {
            connection_id: CONN.into(),
            direction: Direction::Upload,
            sources: vec![s(&local.path().join("a.txt"))],
            target_dir: HOME.into(),
            conflict: ConflictPolicy::Overwrite,
        })
        .await
        .unwrap();
    let v = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (v.id.as_str(), v.state),
        (ids[0].as_str(), TransferState::Done)
    );
    let event = crate::commands::transfer::finished_event(&v).unwrap();
    assert_eq!(
        serde_json::to_value(event.props()).unwrap(),
        serde_json::json!({"direction": "upload", "outcome": "done", "files": "1"})
    );
    assert!(
        timeout(Duration::from_millis(200), rx.recv())
            .await
            .is_err()
    );
}
