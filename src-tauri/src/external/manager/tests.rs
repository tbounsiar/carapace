use std::fs;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use super::*;
use crate::external::launch::Launcher;
use crate::ssh::test_server::{Connected, TestServer, manager_for, start_server};
use crate::ssh::test_sftp::HOME;
use crate::transfer::RemoteFuture;

const HOST: &str = "6a1f0c2e-5b3d-4e8f-9a7c-1d2e3f4a5b6c";

struct Conns {
    ssh: Connected,
    sftp: crate::sftp::SftpManager,
}

impl Connections for Conns {
    fn remote<'a>(&'a self, connection_id: &'a str) -> RemoteFuture<'a> {
        Box::pin(async move { self.sftp.channel(&self.ssh.manager, connection_id).await })
    }
}

#[derive(Default)]
struct FakeLauncher {
    opened: Mutex<Vec<(PathBuf, Opener)>>,
    revealed: Mutex<Vec<PathBuf>>,
    fail: Mutex<Option<EditError>>,
}

impl Launcher for FakeLauncher {
    fn open(&self, file: &Path, opener: &Opener) -> Result<(), EditError> {
        if let Some(e) = self.fail.lock().unwrap().take() {
            return Err(e);
        }
        self.opened
            .lock()
            .unwrap()
            .push((file.to_owned(), opener.clone()));
        Ok(())
    }

    fn reveal(&self, file: &Path) -> Result<(), EditError> {
        self.revealed.lock().unwrap().push(file.to_owned());
        Ok(())
    }
}

struct World {
    server: TestServer,
    conns: Arc<Conns>,
    edits: ExternalEdits,
    home: tempfile::TempDir,
    launcher: Arc<FakeLauncher>,
    opener: Arc<Mutex<Opener>>,
    attention: Arc<AtomicUsize>,
    events: Arc<Mutex<Vec<EditEvent>>>,
}

fn remote(name: &str) -> String {
    format!("{HOME}/{name}")
}

async fn world(seed: u8) -> World {
    let server = start_server(seed).await;
    let ssh = manager_for(&server, HOST);
    ssh.connect().await.unwrap();
    let conns = Arc::new(Conns {
        ssh,
        sftp: Default::default(),
    });
    let home = tempfile::tempdir().unwrap();
    let mut w = World {
        server,
        conns,
        edits: ExternalEdits::with_quiet(
            Path::new("/unused"),
            Arc::new(NoConns),
            Arc::new(FakeLauncher::default()),
            Arc::new(|| Opener::System),
            Duration::from_millis(50),
        ),
        home,
        launcher: Default::default(),
        opener: Arc::new(Mutex::new(Opener::System)),
        attention: Default::default(),
        events: Default::default(),
    };
    w.restart();
    w
}

struct NoConns;

impl Connections for NoConns {
    fn remote<'a>(&'a self, _: &'a str) -> RemoteFuture<'a> {
        Box::pin(async { Err(FsError::NotConnected) })
    }
}

impl World {
    /// A new manager on the same home, as after an app restart.
    fn restart(&mut self) {
        let opener = self.opener.clone();
        self.edits = ExternalEdits::with_quiet(
            self.home.path(),
            self.conns.clone(),
            self.launcher.clone(),
            Arc::new(move || opener.lock().unwrap().clone()),
            Duration::from_millis(50),
        );
        let count = self.attention.clone();
        self.edits.set_attention(Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        }));
        let events = self.events.clone();
        self.edits.subscribe(Arc::new(move |e| {
            events.lock().unwrap().push(e);
            true
        }));
    }

    fn req<'a>(&self, path: &'a str) -> OpenRequest<'a> {
        OpenRequest {
            connection_id: HOST,
            path,
            size: None,
            confirm_large: false,
            confirm_sensitive: false,
        }
    }

    async fn open(&self, name: &str, content: &[u8]) -> EditedFile {
        let path = remote(name);
        self.server.fs().data(&path, content.to_vec());
        self.edits.open(self.req(&path)).await.unwrap()
    }

    fn copy(&self, id: &str) -> PathBuf {
        self.edits.0.slot(id).unwrap().file()
    }

    /// Saves like most editors: a new file renamed over the copy.
    fn save(&self, id: &str, content: &[u8]) {
        let copy = self.copy(id);
        let temp = copy.with_extension("swp");
        fs::write(&temp, content).unwrap();
        fs::rename(&temp, &copy).unwrap();
    }

    fn file(&self, id: &str) -> Option<EditedFile> {
        self.edits.list().into_iter().find(|f| f.id == id)
    }

    async fn until(&self, id: &str, what: &str, done: impl Fn(&EditedFile) -> bool) -> EditedFile {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(f) = self.file(id).filter(|f| done(f)) {
                return f;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {:?}",
                self.file(id)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn state(&self, id: &str, state: State) -> EditedFile {
        self.until(id, &format!("{state:?}"), |f| f.state == state)
            .await
    }

    fn server_has(&self, name: &str) -> Option<Vec<u8>> {
        self.server.fs().contents(&remote(name))
    }

    fn edit_dirs(&self) -> usize {
        fs::read_dir(disk::root(self.home.path()))
            .map(|d| d.count())
            .unwrap_or(0)
    }
}

#[tokio::test]
async fn open_downloads_launches_and_each_save_uploads() {
    let w = world(60).await;
    let f = w.open("a.conf", b"one").await;
    assert_eq!(
        (f.state, f.size, f.name.as_str()),
        (State::Synced, 3, "a.conf")
    );
    assert_eq!(f.last_uploaded_at, None);
    let copy = w.copy(&f.id);
    assert!(copy.starts_with(disk::root(w.home.path())));
    assert_eq!(fs::read(&copy).unwrap(), b"one");
    assert!(crate::fsutil::is_owner_only(
        &fs::File::open(&copy).unwrap()
    ));
    assert_eq!(
        w.launcher.opened.lock().unwrap()[0],
        (copy.clone(), Opener::System)
    );
    let json = serde_json::to_string(&w.edits.list()).unwrap();
    let local = w.home.path().to_string_lossy().replace('\\', "\\\\");
    assert!(!json.contains(&local), "{json}");
    assert!(!json.contains("edit"), "{json}");

    w.save(&f.id, b"two");
    let up = w
        .until(&f.id, "upload", |f| f.last_uploaded_at.is_some())
        .await;
    assert_eq!(up.state, State::Synced);
    assert_eq!(w.server_has("a.conf").unwrap(), b"two");
    assert!(!w.edits.has_unsynced());

    w.save(&f.id, b"two");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(w.file(&f.id).unwrap().last_uploaded_at, up.last_uploaded_at);

    w.save(&f.id, b"three");
    w.until(&f.id, "second upload", |f| {
        f.last_uploaded_at != up.last_uploaded_at
    })
    .await;
    assert_eq!(w.server_has("a.conf").unwrap(), b"three");
    let events = w.events.lock().unwrap();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, EditEvent::Updated { file } if file.state == State::Uploading))
    );
}

#[tokio::test]
async fn opening_again_relaunches_the_same_copy() {
    let w = world(61).await;
    let f = w.open("a.conf", b"one").await;
    w.server.fs().data(&remote("a.conf"), b"changed".to_vec());
    let again = w.edits.open(w.req(&remote("a.conf"))).await.unwrap();
    assert_eq!(again.id, f.id);
    assert_eq!(w.launcher.opened.lock().unwrap().len(), 2);
    assert_eq!(fs::read(w.copy(&f.id)).unwrap(), b"one", "no new download");
    assert_eq!(w.edits.list().len(), 1);
    w.edits.reveal(&f.id).await.unwrap();
    assert_eq!(w.launcher.revealed.lock().unwrap()[0], w.copy(&f.id));
}

#[tokio::test]
async fn a_server_change_holds_saves_until_the_user_decides() {
    let w = world(62).await;
    let f = w.open("a.conf", b"one").await;
    w.server.fs().data(&remote("a.conf"), b"server".to_vec());
    w.save(&f.id, b"mine");
    let c = w.state(&f.id, State::Conflict).await;
    assert_eq!(c.conflict, Some(ConflictKind::Changed));
    assert!(c.not_uploaded && c.needs_attention);
    assert_eq!(w.attention.load(Ordering::SeqCst), 1);
    w.save(&f.id, b"mine again");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(w.file(&f.id).unwrap().state, State::Conflict);
    assert_eq!(w.server_has("a.conf").unwrap(), b"server");
    assert_eq!(w.attention.load(Ordering::SeqCst), 1);
    assert!(w.edits.has_unsynced());
    let err = w.edits.stop(&f.id, false).await.unwrap_err();
    assert_eq!(err.code(), "not_uploaded");

    let still = w.edits.upload_now(&f.id).await.unwrap();
    assert_eq!(still.state, State::Conflict);

    let used = w
        .edits
        .resolve(&f.id, Choice::UseServer, false)
        .await
        .unwrap();
    assert_eq!(used.state, State::Synced);
    assert_eq!(fs::read(w.copy(&f.id)).unwrap(), b"server");
    w.save(&f.id, b"after");
    w.until(&f.id, "upload", |f| f.last_uploaded_at.is_some())
        .await;
    assert_eq!(w.server_has("a.conf").unwrap(), b"after");
}

#[tokio::test]
async fn overwrite_and_upload_anyway_skip_the_check() {
    let w = world(63).await;
    let f = w.open("a.conf", b"one").await;
    w.server.fs().data(&remote("a.conf"), b"server".to_vec());
    w.save(&f.id, b"mine");
    w.state(&f.id, State::Conflict).await;
    let done = w
        .edits
        .resolve(&f.id, Choice::Overwrite, false)
        .await
        .unwrap();
    assert_eq!(done.state, State::Synced);
    assert_eq!(w.server_has("a.conf").unwrap(), b"mine");

    w.server.fs().remove(&remote("a.conf"));
    w.save(&f.id, b"again");
    let gone = w.state(&f.id, State::Conflict).await;
    assert_eq!(gone.conflict, Some(ConflictKind::Deleted));
    let err = w
        .edits
        .resolve(&f.id, Choice::UseServer, false)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "not_found");
    w.edits
        .resolve(&f.id, Choice::Overwrite, false)
        .await
        .unwrap();
    assert_eq!(w.server_has("a.conf").unwrap(), b"again");
}

#[tokio::test]
async fn a_failed_upload_is_retried_on_request() {
    let w = world(64).await;
    let f = w.open("a.conf", b"one").await;
    w.server.fs().set_fail_writes(true);
    w.save(&f.id, b"two");
    let failed = w.state(&f.id, State::Failed).await;
    let err = failed.error.unwrap();
    assert!(!err.text.message.contains(&*w.home.path().to_string_lossy()));
    assert_eq!(w.attention.load(Ordering::SeqCst), 1);
    w.server.fs().set_fail_writes(false);
    let retried = w.edits.upload_now(&f.id).await.unwrap();
    assert_eq!(retried.state, State::Synced);
    assert_eq!(w.server_has("a.conf").unwrap(), b"two");
}

#[tokio::test]
async fn saves_wait_for_the_connection_and_a_reconnect_drains_them() {
    let w = world(65).await;
    let f = w.open("a.conf", b"one").await;
    let other = w.open("b.conf", b"b").await;
    w.conns.ssh.manager.disconnect(HOST).await.unwrap();
    w.state(&other.id, State::Disconnected).await;
    w.save(&f.id, b"offline");
    w.state(&f.id, State::Waiting).await;
    assert!(w.edits.has_unsynced());
    assert_eq!(
        w.edits.stop(&f.id, false).await.unwrap_err().code(),
        "not_uploaded"
    );
    assert_eq!(
        w.edits.upload_now(&f.id).await.unwrap_err().code(),
        "not_connected"
    );
    assert_eq!(w.server_has("a.conf").unwrap(), b"one");

    w.conns.ssh.connect().await.unwrap();
    w.edits.host_connected(HOST).await;
    w.until(&f.id, "drain", |f| {
        f.state == State::Synced && f.last_uploaded_at.is_some()
    })
    .await;
    assert_eq!(w.server_has("a.conf").unwrap(), b"offline");
    w.state(&other.id, State::Synced).await;
    assert!(!w.edits.has_unsynced());
}

#[tokio::test]
async fn refusals_leave_nothing_behind() {
    let w = world(66).await;
    let code = |r: Result<EditedFile, EditError>| r.unwrap_err().code();

    let env = remote(".env");
    w.server.fs().data(&env, b"TOKEN=x".to_vec());
    assert_eq!(code(w.edits.open(w.req(&env)).await), "sensitive");
    assert_eq!(w.edit_dirs(), 0);

    let big = remote("big.bin");
    let mut req = w.req(&big);
    req.size = Some(rules::CONFIRM_BYTES + 1);
    assert_eq!(code(w.edits.open(req).await), "large_file");
    let mut req = w.req(&big);
    req.size = Some(rules::MAX_BYTES + 1);
    req.confirm_large = true;
    assert_eq!(code(w.edits.open(req).await), "too_large");
    w.server.fs().file(&big, rules::CONFIRM_BYTES + 1);
    assert_eq!(code(w.edits.open(w.req(&big)).await), "large_file");

    w.server.fs().dir(&remote("dir"));
    assert_eq!(
        code(w.edits.open(w.req(&remote("dir"))).await),
        "not_regular_file"
    );
    assert_eq!(
        code(w.edits.open(w.req(&remote("missing"))).await),
        "not_found"
    );
    assert_eq!(code(w.edits.open(w.req("/")).await), "invalid_input");

    #[cfg(windows)]
    let program = "tool.exe";
    #[cfg(target_os = "macos")]
    let program = "run.command";
    #[cfg(not(any(windows, target_os = "macos")))]
    let program = "app.desktop";
    w.server.fs().data(&remote(program), b"x".to_vec());
    assert_eq!(
        code(w.edits.open(w.req(&remote(program))).await),
        "blocked_type"
    );

    let missing_app = w.home.path().join("gone.exe");
    *w.opener.lock().unwrap() = Opener::App(missing_app);
    assert_eq!(
        code(w.edits.open(w.req(&remote(program))).await),
        "app_not_found"
    );

    *w.opener.lock().unwrap() = Opener::System;
    *w.launcher.fail.lock().unwrap() = Some(EditError::AppFailed);
    w.server.fs().data(&remote("a.conf"), b"x".to_vec());
    assert_eq!(
        code(w.edits.open(w.req(&remote("a.conf"))).await),
        "app_failed"
    );
    assert!(w.edits.list().is_empty());
    assert_eq!(w.edit_dirs(), 0);
    let removed = w
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, EditEvent::Removed { .. }));
    assert!(removed);
}

#[tokio::test]
async fn confirmed_files_open_and_a_custom_app_runs_programs() {
    let w = world(67).await;
    let env = remote(".env");
    w.server.fs().data(&env, b"TOKEN=x".to_vec());
    let mut req = w.req(&env);
    req.confirm_sensitive = true;
    w.edits.open(req).await.unwrap();

    let big = remote("big.bin");
    w.server.fs().file(&big, rules::CONFIRM_BYTES + 1);
    let mut req = w.req(&big);
    req.confirm_large = true;
    let f = w.edits.open(req).await.unwrap();
    assert_eq!(f.size, rules::CONFIRM_BYTES + 1);

    let app = w.home.path().join("editor.exe");
    fs::write(&app, b"").unwrap();
    *w.opener.lock().unwrap() = Opener::App(app.clone());
    let f = w.open("tool.exe", b"MZ").await;
    let opened = w.launcher.opened.lock().unwrap().last().cloned().unwrap();
    assert_eq!(opened, (w.copy(&f.id), Opener::App(app)));
}

#[tokio::test]
async fn unsynced_copies_survive_a_restart_as_recovered() {
    let mut w = world(68).await;
    let synced = w.open("a.conf", b"a").await;
    let changed = w.open("b.conf", b"b").await;
    w.conns.ssh.manager.disconnect(HOST).await.unwrap();
    w.save(&changed.id, b"b edited");
    w.state(&changed.id, State::Waiting).await;
    let synced_dir = w.copy(&synced.id).parent().unwrap().to_owned();
    w.edits.shutdown();
    assert!(!synced_dir.exists(), "a synced copy is deleted at exit");
    assert_eq!(w.edit_dirs(), 1);

    w.attention.store(0, Ordering::SeqCst);
    w.restart();
    let list = w.edits.list();
    assert_eq!(list.len(), 1);
    let r = &list[0];
    assert_eq!(r.id, changed.id);
    assert_eq!((r.state, r.watched), (State::Recovered, false));
    assert!(r.recovered_at.is_some() && r.not_uploaded);
    assert_eq!(w.attention.load(Ordering::SeqCst), 1);
    assert!(w.edits.has_unsynced());

    w.conns.ssh.connect().await.unwrap();
    let up = w.edits.upload_now(&r.id).await.unwrap();
    assert_eq!(up.state, State::Synced);
    assert_eq!(w.server_has("b.conf").unwrap(), b"b edited");
    assert_eq!(
        w.edits.discard(&r.id).await.unwrap_err().code(),
        "invalid_input"
    );
}

#[tokio::test]
async fn a_recovered_copy_reopened_is_watched_and_discard_deletes_it_unless_moved_on() {
    let mut w = world(69).await;
    let f = w.open("a.conf", b"a").await;
    w.server.fs().data(&remote("a.conf"), b"server".to_vec());
    w.save(&f.id, b"mine");
    w.state(&f.id, State::Conflict).await;
    w.edits.shutdown();
    w.restart();
    assert_eq!(w.file(&f.id).unwrap().state, State::Recovered);
    let reopened = w.edits.open(w.req(&remote("a.conf"))).await.unwrap();
    assert_eq!(
        (reopened.id.as_str(), reopened.watched),
        (f.id.as_str(), true)
    );
    let dir = w.copy(&f.id).parent().unwrap().to_owned();
    w.edits.discard(&f.id).await.unwrap();
    assert!(!dir.exists());
    assert!(w.edits.list().is_empty());

    let f = w.open("c.conf", b"c").await;
    w.server.fs().data(&remote("c.conf"), b"server".to_vec());
    w.save(&f.id, b"crashed");
    w.state(&f.id, State::Conflict).await;
    // No shutdown: the app was killed.
    w.restart();
    assert_eq!(w.file(&f.id).unwrap().state, State::Recovered);
    w.edits.open(w.req(&remote("c.conf"))).await.unwrap();
    w.save(&f.id, b"mine");
    w.state(&f.id, State::Conflict).await;
    assert_eq!(
        w.edits.discard(&f.id).await.unwrap_err().code(),
        "invalid_input"
    );
    w.edits.stop(&f.id, true).await.unwrap();
    assert_eq!(w.edit_dirs(), 0);
}

#[tokio::test]
async fn stopping_and_deleting_hosts_remove_copies() {
    let w = world(70).await;
    let a = w.open("a.conf", b"a").await;
    let b = w.open("b.conf", b"b").await;
    assert_eq!(w.edits.affected(&[HOST.into()]).len(), 2);
    assert!(w.edits.affected(&["other".into()]).is_empty());
    let dir = w.copy(&a.id).parent().unwrap().to_owned();
    w.edits.stop(&a.id, false).await.unwrap();
    assert!(!dir.exists());
    assert_eq!(
        w.edits.stop(&a.id, false).await.unwrap_err().code(),
        "not_found"
    );

    w.server.fs().data(&remote("b.conf"), b"server".to_vec());
    w.save(&b.id, b"mine");
    w.state(&b.id, State::Conflict).await;
    assert_eq!(
        w.edits.stop_all(false).await.unwrap_err().code(),
        "not_uploaded"
    );
    w.edits.forget_hosts(&[HOST.into()]);
    assert!(w.edits.list().is_empty());
    assert_eq!(w.edit_dirs(), 0);
    assert!(!w.edits.has_unsynced());
}

#[tokio::test]
async fn a_change_seen_and_not_hashed_yet_is_judged_by_the_hash() {
    let w = world(81).await;
    let f = w.open("a.conf", b"a").await;
    w.edits.0.lock().files.get_mut(&f.id).unwrap().seen = true;
    assert!(w.edits.has_unsynced());
    w.edits.stop(&f.id, false).await.unwrap();
    assert_eq!(w.edit_dirs(), 0);
}

#[tokio::test]
async fn a_copy_that_cannot_be_read_is_never_stopped_as_unchanged() {
    let w = world(82).await;
    let f = w.open("a.conf", b"a").await;
    // Unwatched, so no upload attempt fails the file first.
    w.edits.0.lock().files.get_mut(&f.id).unwrap().watch = None;
    fs::remove_file(w.copy(&f.id)).unwrap();
    fs::create_dir(w.copy(&f.id)).unwrap();
    assert_eq!(w.edits.stop(&f.id, false).await.unwrap_err().code(), "io");
    assert!(w.file(&f.id).is_some());
    assert_eq!(w.edit_dirs(), 1);
    w.edits.stop(&f.id, true).await.unwrap();
    assert_eq!(w.edit_dirs(), 0);
}

#[tokio::test]
async fn a_missing_copy_is_stopped_only_if_nothing_changed_since_the_last_sync() {
    let w = world(84).await;
    let f = w.open("a.conf", b"a").await;
    // Unwatched (the debounce task is aborted with the watch) and with a counter no late
    // event of the old watcher can reach: only this test moves it.
    let changes = {
        let mut inner = w.edits.0.lock();
        let e = inner.files.get_mut(&f.id).unwrap();
        e.watch = None;
        e.seen = false;
        e.changes = Arc::new(AtomicU64::new(0));
        e.synced_changes = 0;
        e.changes.clone()
    };
    fs::remove_file(w.copy(&f.id)).unwrap();
    changes.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        w.edits.stop(&f.id, false).await.unwrap_err().code(),
        "not_uploaded"
    );
    assert_eq!(w.edit_dirs(), 1);
    w.edits
        .0
        .lock()
        .files
        .get_mut(&f.id)
        .unwrap()
        .synced_changes = changes.load(Ordering::SeqCst);
    w.edits.stop(&f.id, false).await.unwrap();
    assert_eq!(w.edit_dirs(), 0);
}

#[cfg(windows)]
#[tokio::test]
async fn a_copy_an_editor_keeps_locked_is_kept_and_still_watched() {
    use std::os::windows::fs::OpenOptionsExt;
    let w = world(83).await;
    let f = w.open("a.conf", b"a").await;
    let held = fs::File::options()
        .read(true)
        .share_mode(1)
        .open(w.copy(&f.id))
        .unwrap();
    assert_eq!(w.edits.stop(&f.id, false).await.unwrap_err().code(), "io");
    assert!(w.file(&f.id).unwrap().watched);
    drop(held);
    assert_eq!(fs::read(w.copy(&f.id)).unwrap(), b"a");
    w.edits.stop(&f.id, false).await.unwrap();
    assert_eq!(w.edit_dirs(), 0);
}

#[tokio::test]
async fn choices_apply_to_conflicts_only() {
    let w = world(71).await;
    let f = w.open("a.conf", b"one").await;
    for choice in [Choice::Overwrite, Choice::UseServer] {
        let err = w.edits.resolve(&f.id, choice, false).await.unwrap_err();
        assert_eq!(err.code(), "invalid_input");
    }
    assert_eq!(w.server_has("a.conf").unwrap(), b"one");
}

#[tokio::test]
async fn a_host_id_that_reaches_another_server_gets_nothing() {
    let w = world(72).await;
    let f = w.open("a.conf", b"one").await;
    w.edits.0.lock().files.get_mut(&f.id).unwrap().host_key = "SHA256:other".into();
    w.save(&f.id, b"two");
    let failed = w.state(&f.id, State::Failed).await;
    assert_eq!(failed.error.unwrap().code, "host_changed");
    let json = serde_json::to_string(&w.edits.list()).unwrap();
    assert!(
        !json.contains("SHA256") && !json.contains("127.0.0.1"),
        "{json}"
    );
    assert_eq!(
        w.edits.upload_now(&f.id).await.unwrap_err().code(),
        "host_changed"
    );
    w.server.fs().data(&remote("a.conf"), b"server".to_vec());
    {
        let mut inner = w.edits.0.lock();
        inner.files.get_mut(&f.id).unwrap().state = State::Conflict;
    }
    for choice in [Choice::Overwrite, Choice::UseServer] {
        let err = w.edits.resolve(&f.id, choice, true).await.unwrap_err();
        assert_eq!(err.code(), "host_changed");
        let mut inner = w.edits.0.lock();
        inner.files.get_mut(&f.id).unwrap().state = State::Conflict;
    }
    assert_eq!(w.server_has("a.conf").unwrap(), b"server");
    assert_eq!(fs::read(w.copy(&f.id)).unwrap(), b"two");
}

#[tokio::test]
async fn recovered_copies_of_deleted_hosts_can_only_be_shown_or_discarded() {
    let mut w = world(73).await;
    let f = w.open("a.conf", b"a").await;
    w.conns.ssh.manager.disconnect(HOST).await.unwrap();
    w.save(&f.id, b"edited");
    w.state(&f.id, State::Waiting).await;
    w.restart();
    w.edits.retain_known_hosts(|id| id != HOST);
    let r = w.file(&f.id).unwrap();
    assert_eq!((r.state, r.can_upload), (State::Recovered, false));
    w.conns.ssh.connect().await.unwrap();
    assert_eq!(
        w.edits.upload_now(&f.id).await.unwrap_err().code(),
        "not_found"
    );
    assert_eq!(
        w.edits
            .open(w.req(&remote("a.conf")))
            .await
            .unwrap_err()
            .code(),
        "not_found"
    );
    assert_eq!(w.server_has("a.conf").unwrap(), b"a");
    w.edits.reveal(&f.id).await.unwrap();
    w.edits.discard(&f.id).await.unwrap();
    assert_eq!(w.edit_dirs(), 0);
}

#[tokio::test]
async fn a_link_to_a_key_needs_the_sensitive_confirm() {
    let w = world(74).await;
    w.server.fs().dir(&remote(".ssh"));
    w.server
        .fs()
        .data(&remote(".ssh/id_ed25519"), b"not a real key".to_vec());
    w.server
        .fs()
        .link(&remote("notes.txt"), &remote(".ssh/id_ed25519"));
    let err = w.edits.open(w.req(&remote("notes.txt"))).await.unwrap_err();
    assert_eq!(err.code(), "sensitive");
    assert_eq!(w.edit_dirs(), 0);
    let notes = remote("notes.txt");
    let mut req = w.req(&notes);
    req.confirm_sensitive = true;
    w.edits.open(req).await.unwrap();
}

#[tokio::test]
async fn using_a_large_server_version_needs_the_confirm() {
    let w = world(75).await;
    let f = w.open("a.conf", b"one").await;
    w.server
        .fs()
        .file(&remote("a.conf"), rules::CONFIRM_BYTES + 1);
    w.save(&f.id, b"mine");
    w.state(&f.id, State::Conflict).await;
    let err = w
        .edits
        .resolve(&f.id, Choice::UseServer, false)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "large_file");
    assert_eq!(fs::read(w.copy(&f.id)).unwrap(), b"mine");
    let done = w
        .edits
        .resolve(&f.id, Choice::UseServer, true)
        .await
        .unwrap();
    assert_eq!(
        (done.state, done.size),
        (State::Synced, rules::CONFIRM_BYTES + 1)
    );
}

#[tokio::test]
async fn a_streamed_copy_that_changes_or_grows_is_never_placed() {
    let w = world(76).await;
    let path = remote("a.conf");
    w.server.fs().data(&path, b"server".to_vec());
    let r = w
        .conns
        .sftp
        .channel(&w.conns.ssh.manager, HOST)
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("copy");
    fs::write(&local, b"local").unwrap();

    let mut f = tokio::fs::File::open(&local).await.unwrap();
    let mut body = Body::file(&mut f, rules::MAX_BYTES, Box::new(|| false));
    let err = r
        .write_body(&path, None, None, &mut body)
        .await
        .unwrap_err();
    assert_eq!(err, FsError::SourceChanged);

    let mut f = tokio::fs::File::open(&local).await.unwrap();
    let mut body = Body::file(&mut f, 3, Box::new(|| true));
    let err = r
        .write_body(&path, None, None, &mut body)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "too_large");

    assert_eq!(w.server_has("a.conf").unwrap(), b"server");
    let leftovers: Vec<String> = w
        .server
        .fs()
        .paths_under("/")
        .into_iter()
        .filter(|p| p.ends_with(".carapace-part"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[cfg(windows)]
#[tokio::test]
async fn copies_carry_the_downloaded_mark() {
    let w = world(77).await;
    let f = w.open("a.conf", b"one").await;
    let mut stream = w.copy(&f.id).into_os_string();
    stream.push(":Zone.Identifier");
    assert!(fs::read_to_string(&stream).unwrap().contains("ZoneId=3"));
    w.server.fs().data(&remote("a.conf"), b"server".to_vec());
    w.save(&f.id, b"mine");
    w.state(&f.id, State::Conflict).await;
    w.edits
        .resolve(&f.id, Choice::UseServer, false)
        .await
        .unwrap();
    let mut stream = w.copy(&f.id).into_os_string();
    stream.push(":Zone.Identifier");
    assert!(fs::read_to_string(&stream).unwrap().contains("ZoneId=3"));
}

#[tokio::test]
async fn the_in_place_route_uploads_a_frozen_snapshot() {
    let w = world(78).await;
    let f = w.open("a.conf", b"one").await;
    // Another owner: the server is rewritten in place instead of through a temp.
    w.server.fs().set_owner(&remote("a.conf"), 0, 0);
    w.save(&f.id, b"a longer second version");
    w.until(&f.id, "upload", |f| f.last_uploaded_at.is_some())
        .await;
    assert_eq!(w.server_has("a.conf").unwrap(), b"a longer second version");
    assert_eq!(
        w.server.fs().owner(&remote("a.conf")),
        (0, 0),
        "rewritten in place"
    );
    let copy_dir = w.copy(&f.id).parent().unwrap().to_owned();
    let names: Vec<_> = fs::read_dir(copy_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    // The manifest may still be being rewritten: only the snapshot must be gone.
    assert!(
        !names.iter().any(|n| n.starts_with(".a.conf.")),
        "{names:?}"
    );
}

#[tokio::test]
async fn an_empty_host_key_never_matches() {
    let w = world(79).await;
    let f = w.open("a.conf", b"one").await;
    w.edits.0.lock().files.get_mut(&f.id).unwrap().host_key = String::new();
    w.save(&f.id, b"two");
    let failed = w.state(&f.id, State::Failed).await;
    assert_eq!(failed.error.unwrap().code, "host_changed");
    assert_eq!(w.server_has("a.conf").unwrap(), b"one");
}

#[cfg(not(any(windows, target_os = "macos")))]
#[tokio::test]
async fn a_server_version_that_is_a_program_is_refused_after_use() {
    let w = world(80).await;
    let f = w.open("notes.txt", b"notes").await;
    w.server
        .fs()
        .data(&remote("notes.txt"), b"#!/bin/sh\necho x\n".to_vec());
    w.save(&f.id, b"mine");
    w.state(&f.id, State::Conflict).await;
    let err = w
        .edits
        .resolve(&f.id, Choice::UseServer, false)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "blocked_type");
    assert_eq!(w.file(&f.id).unwrap().state, State::Failed);
    let again = w.edits.open(w.req(&remote("notes.txt"))).await.unwrap_err();
    assert_eq!(again.code(), "blocked_type");
}
