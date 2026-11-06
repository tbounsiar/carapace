use super::*;
use crate::ssh::test_server::{Connected, TestServer, manager_for, start_server};
use crate::ssh::test_sftp::{HOME, Node};

struct World {
    server: TestServer,
    ssh: Connected,
    sftp: SftpManager,
}

async fn world(seed: u8) -> World {
    let server = start_server(seed).await;
    let ssh = manager_for(&server, "h1");
    ssh.connect().await.unwrap();
    World {
        server,
        ssh,
        sftp: SftpManager::default(),
    }
}

impl World {
    fn m(&self) -> &SshManager {
        &self.ssh.manager
    }
    async fn list(&self, path: &str) -> Result<Listing, FsError> {
        self.sftp.list(self.m(), "h1", path).await
    }
    async fn delete(&self, path: &str, recursive: bool) -> Result<(), FsError> {
        self.sftp.delete(self.m(), "h1", path, recursive).await
    }
    fn names(listing: &Listing) -> Vec<&str> {
        let mut n: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        n.sort();
        n
    }
}

fn home(rest: &str) -> String {
    format!("{HOME}/{rest}")
}

#[tokio::test]
async fn lists_home_with_hidden_entries_and_attributes() {
    let w = world(60).await;
    w.server.fs().dir(&home("docs"));
    w.server.fs().link(&home("ln"), "/home");
    let l = w.list("").await.unwrap();
    assert_eq!(l.path, HOME);
    assert_eq!(l.parent.as_deref(), Some("/home"));
    assert_eq!(World::names(&l), [".profile", "docs", "ln"]);
    let profile = l.entries.iter().find(|e| e.name == ".profile").unwrap();
    assert_eq!(profile.path, home(".profile"));
    assert_eq!(profile.kind, EntryKind::File);
    assert_eq!(profile.size, Some(12));
    assert_eq!(profile.permissions.as_deref(), Some("rw-r--r--"));
    assert_eq!(profile.modified, Some(1_700_000_000));
    assert!(profile.hidden);
    let docs = l.entries.iter().find(|e| e.name == "docs").unwrap();
    assert_eq!(
        (docs.kind, docs.size, docs.hidden),
        (EntryKind::Dir, None, false)
    );
    let ln = l.entries.iter().find(|e| e.name == "ln").unwrap();
    assert_eq!(ln.kind, EntryKind::Symlink);

    let root = w.list("/home/me/docs/../..").await.unwrap();
    assert_eq!(
        (root.path.as_str(), root.parent.as_deref()),
        ("/home", Some("/"))
    );
    assert_eq!(w.list("/").await.unwrap().parent, None);
}

#[tokio::test]
async fn listing_a_symlinked_dir_returns_the_canonical_path() {
    let w = world(61).await;
    w.server.fs().link(&home("up"), "/home");
    assert_eq!(w.list(&home("up")).await.unwrap().path, "/home");
}

#[tokio::test]
async fn listing_errors_map_to_codes() {
    let w = world(62).await;
    w.server.fs().denied_dir(&home("secret"));
    let code = |r: Result<Listing, FsError>| r.unwrap_err().code();
    assert_eq!(code(w.list(&home("secret")).await), "permission_denied");
    assert_eq!(code(w.list(&home("missing")).await), "not_found");
    assert_eq!(code(w.list(&home(".profile")).await), "invalid_input");
    assert_eq!(code(w.list("relative").await), "invalid_input");
    assert_eq!(code(w.list("/a\0").await), "invalid_input");
}

#[tokio::test]
async fn too_many_entries_is_too_large() {
    let w = world(63).await;
    w.server.fs().dir(&home("big"));
    for i in 0..=MAX_ENTRIES {
        w.server.fs().file(&home(&format!("big/f{i}")), 0);
    }
    assert_eq!(w.list(&home("big")).await.unwrap_err().code(), "too_large");
    w.server.fs().0.lock().unwrap().remove(&home("big/f0"));
    assert_eq!(
        w.list(&home("big")).await.unwrap().entries.len(),
        MAX_ENTRIES
    );
}

#[tokio::test]
async fn requires_a_connection() {
    let server = start_server(64).await;
    let ssh = manager_for(&server, "h1");
    let sftp = SftpManager::default();
    let err = sftp.list(&ssh.manager, "h1", "").await.unwrap_err();
    assert_eq!(err, FsError::NotConnected);
    assert_eq!(server.sftp_opens(), 0);
}

#[tokio::test]
async fn one_channel_is_shared_and_dropped_on_disconnect() {
    let w = world(65).await;
    w.list("").await.unwrap();
    w.list("/").await.unwrap();
    w.sftp.mkdir(w.m(), "h1", "", "a").await.unwrap();
    assert_eq!(w.server.sftp_opens(), 1);
    assert!(w.sftp.is_open("h1").await);

    w.m().disconnect("h1").await.unwrap();
    wait_closed(&w.sftp).await;
    assert_eq!(w.list("").await.unwrap_err(), FsError::NotConnected);

    w.ssh.connect().await.unwrap();
    w.list("").await.unwrap();
    assert_eq!(w.server.sftp_opens(), 2);
}

#[tokio::test]
async fn lost_connection_drops_the_channel() {
    let w = world(66).await;
    w.list("").await.unwrap();
    w.server.drop_clients().await;
    wait_closed(&w.sftp).await;
    assert_eq!(w.list("").await.unwrap_err(), FsError::NotConnected);
}

async fn wait_closed(sftp: &SftpManager) {
    for _ in 0..100 {
        if !sftp.is_open("h1").await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the SFTP channel was not dropped");
}

#[tokio::test]
async fn mkdir_and_rename() {
    let w = world(67).await;
    let made = w.sftp.mkdir(w.m(), "h1", HOME, "new").await.unwrap();
    assert_eq!(
        (made.path.as_str(), made.kind),
        (home("new").as_str(), EntryKind::Dir)
    );
    let again = w.sftp.mkdir(w.m(), "h1", "", "new").await.unwrap_err();
    assert_eq!(again.code(), "already_exists");
    assert_eq!(
        w.sftp
            .mkdir(w.m(), "h1", "/nope", "x")
            .await
            .unwrap_err()
            .code(),
        "not_found"
    );

    let renamed = w
        .sftp
        .rename(w.m(), "h1", &home("new"), "old")
        .await
        .unwrap();
    assert_eq!(renamed.path, home("old"));
    assert_eq!(renamed.name, "old");
    assert!(w.server.fs().get(&home("new")).is_none());

    let same = w
        .sftp
        .rename(w.m(), "h1", &home("old"), "old")
        .await
        .unwrap();
    assert_eq!(same.path, home("old"));
    let clash = w.sftp.rename(w.m(), "h1", &home("old"), ".profile").await;
    assert_eq!(clash.unwrap_err().code(), "already_exists");
    let missing = w.sftp.rename(w.m(), "h1", &home("ghost"), "x").await;
    assert_eq!(missing.unwrap_err().code(), "not_found");
}

#[tokio::test]
async fn invalid_names_and_paths_are_rejected() {
    let w = world(68).await;
    for bad in ["", ".", "..", "a/b", "a\0", "a\nb", &"x".repeat(256)] {
        let err = w.sftp.mkdir(w.m(), "h1", HOME, bad).await.unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{bad:?}");
        let err = w
            .sftp
            .rename(w.m(), "h1", &home(".profile"), bad)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{bad:?}");
    }
    assert_eq!(
        w.sftp
            .rename(w.m(), "h1", "/", "x")
            .await
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        w.sftp
            .rename(w.m(), "h1", "", "x")
            .await
            .unwrap_err()
            .code(),
        "invalid_input"
    );
}

#[tokio::test]
async fn delete_refuses_roots_and_home() {
    let w = world(69).await;
    for path in ["", "/", HOME, "/home/me/x/..", "//"] {
        assert_eq!(
            w.delete(path, true).await.unwrap_err().code(),
            "invalid_input",
            "{path}"
        );
    }
    assert!(w.server.fs().get(HOME).is_some());
}

#[tokio::test]
async fn delete_non_empty_needs_recursive() {
    let w = world(70).await;
    let fs = w.server.fs();
    fs.dir(&home("tree"));
    fs.dir(&home("tree/sub"));
    fs.file(&home("tree/sub/f"), 1);
    fs.file(&home("tree/g"), 1);
    assert_eq!(
        w.delete(&home("tree"), false).await.unwrap_err().code(),
        "not_empty"
    );
    w.delete(&home("tree/sub/f"), false).await.unwrap();
    w.delete(&home("tree/sub"), false).await.unwrap();
    w.delete(&home("tree"), true).await.unwrap();
    assert!(fs.get(&home("tree")).is_none());
    assert!(fs.get(&home("tree/g")).is_none());
    assert_eq!(
        w.delete(&home("tree"), true).await.unwrap_err().code(),
        "not_found"
    );
}

#[tokio::test]
async fn recursive_delete_never_follows_symlinks() {
    let w = world(71).await;
    let fs = w.server.fs();
    fs.dir("/keep");
    fs.file("/keep/precious", 1);
    fs.dir(&home("tree"));
    fs.link(&home("tree/to-keep"), "/keep");
    fs.link(&home("to-keep"), "/keep");
    w.delete(&home("tree"), true).await.unwrap();
    w.delete(&home("to-keep"), true).await.unwrap();
    assert!(fs.get(&home("tree")).is_none());
    assert!(fs.get(&home("to-keep")).is_none());
    assert_eq!(fs.get("/keep/precious"), Some(Node::File(1)));

    fs.link(&home("home-link"), HOME);
    w.delete(&home("home-link"), false).await.unwrap();
    assert!(fs.get(HOME).is_some());
}

#[tokio::test]
async fn recursive_delete_ignores_readdir_kinds() {
    let w = world(73).await;
    let fs = w.server.fs();
    fs.1.store(true, std::sync::atomic::Ordering::SeqCst);
    fs.dir("/keep");
    fs.dir("/keep/sub");
    fs.file("/keep/precious", 1);
    fs.dir(&home("tree"));
    fs.link(&home("tree/disguised"), "/keep");
    w.delete(&home("tree"), true).await.unwrap();
    assert!(fs.get(&home("tree")).is_none());
    assert_eq!(fs.get("/keep/precious"), Some(Node::File(1)));
    assert!(fs.get("/keep/sub").is_some());
}

#[tokio::test]
async fn no_slot_without_a_session() {
    let w = world(74).await;
    assert_eq!(
        w.sftp.list(w.m(), "other", "").await.unwrap_err(),
        FsError::NotConnected
    );
    assert_eq!(w.sftp.slot_count(), 0);
    w.list("").await.unwrap();
    assert_eq!(w.sftp.slot_count(), 1);
}

#[tokio::test]
async fn recursive_delete_is_depth_limited() {
    let w = world(72).await;
    let mut path = home("deep");
    for _ in 0..=MAX_DEPTH {
        w.server.fs().dir(&path);
        path.push_str("/d");
    }
    let err = w.delete(&home("deep"), true).await.unwrap_err();
    assert_eq!(err.code(), "too_large");
}

#[tokio::test]
async fn a_refused_sftp_channel_opens_on_an_extra_connection() {
    let w = world(95).await;
    w.server.set_max_sessions(1);
    let (held, _) = w.m().open_channel("h1").await.unwrap();
    assert_eq!(w.server.open_sessions(), 1);

    w.list("").await.unwrap();
    assert_eq!(w.server.open_sessions(), 2);
    assert_eq!(w.m().extra_count("h1").await, 1);
    assert_eq!(w.m().list().await.len(), 1);

    w.m().disconnect("h1").await.unwrap();
    wait_closed(&w.sftp).await;
    let _ = held.close().await;
    for _ in 0..250 {
        if w.server.open_sessions() == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the extra connection stayed open");
}

#[tokio::test]
async fn a_refused_sftp_subsystem_is_subsystem_refused() {
    let w = world(96).await;
    w.server.refuse_sftp(true);
    let err = w.list("").await.unwrap_err();
    assert_eq!(err, FsError::SubsystemRefused);
    assert_eq!(err.code(), "subsystem_refused");
    assert_eq!(w.server.open_sessions(), 1);
    w.server.refuse_sftp(false);
    w.list("").await.unwrap();
}

#[test]
fn channel_errors_map_to_file_codes() {
    use crate::ssh::{ChannelError, SshError};
    let cases = [
        (ChannelError::NotConnected, "not_connected"),
        (ChannelError::Refused, "channel_refused"),
        (ChannelError::Timeout, "timeout"),
        (ChannelError::Network, "network"),
        (
            ChannelError::Connect(SshError::SecretRequired),
            "secret_required",
        ),
    ];
    for (e, code) in cases {
        assert_eq!(channel_error(e).code(), code);
    }
}
