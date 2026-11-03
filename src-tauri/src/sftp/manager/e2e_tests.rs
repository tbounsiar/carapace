//! SFTP against the disposable sshd in `e2e/sshd` (OpenSSH `internal-sftp`). Run only with
//! `CARAPACE_E2E=1` after `node e2e/sshd/setup.mjs up`.

use std::path::Path;

use tokio::sync::mpsc;

use super::*;
use crate::ssh::ConnectEvent;
use crate::ssh::TargetAuth;
use crate::ssh::test_server::{E2E_SERVER, isolated_manager, target};

const HOST_ID: &str = "e2e-sftp";
const HOME: &str = "/home/carapace";

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
    sftp: SftpManager,
    /// A fresh directory under the remote home, removed at the end of the test.
    base: String,
}

/// Connects through the real host key prompt, answered like a user accepting it.
async fn connected() -> World {
    let dir = tempfile::tempdir().unwrap();
    let ssh = Arc::new(isolated_manager(dir.path()));
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
    let sftp = SftpManager::default();
    let name = format!("e2e-sftp-{}", uuid::Uuid::new_v4().simple());
    let base = sftp.mkdir(&ssh, HOST_ID, "", &name).await.unwrap().path;
    World {
        _dir: dir,
        ssh,
        sftp,
        base,
    }
}

impl World {
    fn at(&self, rest: &str) -> String {
        format!("{}/{rest}", self.base)
    }
    async fn mkdir(&self, parent: &str, name: &str) -> Result<FileEntry, FsError> {
        self.sftp.mkdir(&self.ssh, HOST_ID, parent, name).await
    }
    async fn list(&self, path: &str) -> Result<Listing, FsError> {
        self.sftp.list(&self.ssh, HOST_ID, path).await
    }
    async fn delete(&self, path: &str, recursive: bool) -> Result<(), FsError> {
        self.sftp.delete(&self.ssh, HOST_ID, path, recursive).await
    }
    async fn names(&self, path: &str) -> Vec<String> {
        let mut n: Vec<String> = self
            .list(path)
            .await
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.name)
            .collect();
        n.sort();
        n
    }

    /// Runs a fixed test command over an exec channel (SFTP cannot write file contents yet).
    async fn exec(&self, command: &str) {
        let session = self.ssh.session(HOST_ID).await.unwrap();
        let mut channel = session.handle.channel_open_session().await.unwrap();
        channel.exec(true, command).await.unwrap();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    assert_eq!(exit_status, 0, "{command}");
                    return;
                }
                Some(_) => {}
                None => panic!("{command}: no exit status"),
            }
        }
    }

    async fn cleanup(self) {
        self.delete(&self.base, true).await.unwrap();
    }
}

#[tokio::test]
async fn lists_home_with_hidden_entries() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    let home = w.list("").await.unwrap();
    assert_eq!(home.path, HOME);
    assert_eq!(home.parent.as_deref(), Some("/home"));
    let ssh_dir = home.entries.iter().find(|e| e.name == ".ssh").unwrap();
    assert_eq!(ssh_dir.kind, EntryKind::Dir);
    assert!(ssh_dir.hidden);
    assert_eq!(ssh_dir.permissions.as_deref(), Some("rwx------"));
    assert!(home.entries.iter().all(|e| e.name != "." && e.name != ".."));
    assert_eq!(w.list("/").await.unwrap().parent, None);
    w.cleanup().await;
}

#[tokio::test]
async fn mkdir_rename_and_delete() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    let made = w.mkdir(&w.base, "dir").await.unwrap();
    assert_eq!(
        (made.path.clone(), made.kind),
        (w.at("dir"), EntryKind::Dir)
    );
    assert_eq!(
        w.mkdir(&w.base, "dir").await.unwrap_err().code(),
        "already_exists"
    );
    w.mkdir(&w.base, "other").await.unwrap();

    let renamed = w
        .sftp
        .rename(&w.ssh, HOST_ID, &w.at("dir"), "renamed")
        .await
        .unwrap();
    assert_eq!(renamed.path, w.at("renamed"));
    let clash = w
        .sftp
        .rename(&w.ssh, HOST_ID, &w.at("renamed"), "other")
        .await;
    assert_eq!(clash.unwrap_err().code(), "already_exists");
    assert_eq!(w.names(&w.base).await, ["other", "renamed"]);

    w.mkdir(&w.at("renamed"), "child").await.unwrap();
    assert_eq!(
        w.delete(&w.at("renamed"), false).await.unwrap_err().code(),
        "not_empty"
    );
    w.delete(&w.at("renamed"), true).await.unwrap();
    w.delete(&w.at("other"), false).await.unwrap();
    assert!(w.names(&w.base).await.is_empty());
    assert_eq!(
        w.delete(&w.at("other"), false).await.unwrap_err().code(),
        "not_found"
    );
    w.cleanup().await;
}

#[tokio::test]
async fn recursive_delete_does_not_follow_symlinks() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    w.mkdir(&w.base, "keep").await.unwrap();
    w.mkdir(&w.base, "tree").await.unwrap();
    w.exec(&format!(
        "touch {b}/keep/precious && ln -s {b}/keep {b}/tree/link && ln -s {b}/keep {b}/top-link && touch {b}/tree/file",
        b = w.base
    ))
    .await;
    let tree = w.list(&w.at("tree")).await.unwrap();
    let link = tree.entries.iter().find(|e| e.name == "link").unwrap();
    assert_eq!(link.kind, EntryKind::Symlink);

    w.delete(&w.at("tree"), true).await.unwrap();
    w.delete(&w.at("top-link"), true).await.unwrap();
    assert_eq!(w.names(&w.base).await, ["keep"]);
    assert_eq!(w.names(&w.at("keep")).await, ["precious"]);
    w.cleanup().await;
}

#[tokio::test]
async fn invalid_input_and_protected_paths() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    for bad in ["", ".", "..", "a/b", "a\nb", &"x".repeat(256)] {
        assert_eq!(
            w.mkdir(&w.base, bad).await.unwrap_err().code(),
            "invalid_input",
            "{bad:?}"
        );
    }
    assert_eq!(
        w.list("relative").await.unwrap_err().code(),
        "invalid_input"
    );
    for path in ["", "/", HOME] {
        assert_eq!(
            w.delete(path, true).await.unwrap_err().code(),
            "invalid_input",
            "{path}"
        );
    }
    assert_eq!(
        w.list("/root").await.unwrap_err().code(),
        "permission_denied"
    );
    w.cleanup().await;
}

#[tokio::test]
async fn disconnect_drops_the_channel() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    w.list("").await.unwrap();
    assert!(w.sftp.is_open(HOST_ID).await);
    w.delete(&w.base, true).await.unwrap();
    w.ssh.disconnect(HOST_ID).await.unwrap();
    assert_eq!(w.list("").await.unwrap_err(), FsError::NotConnected);
}

#[tokio::test]
async fn editor_round_trip_with_conflicts_and_links() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    let file = w.at("app.ini");
    w.exec(&format!(
        "printf 'a=1\\r\\nb=2\\r\\n' > {file} && chmod 640 {file} && ln -s app.ini {}",
        w.at("link.ini")
    ))
    .await;
    let read = w.sftp.read_text(&w.ssh, HOST_ID, &file).await.unwrap();
    assert_eq!(read.text, "a=1\nb=2\n");
    assert_eq!(read.line_ending, crate::sftp::text::LineEnding::Crlf);
    assert!(read.writable);

    let save = |path: String, text: &'static str, expected: Option<String>| {
        let w = &w;
        async move {
            let req = WriteText {
                path: &path,
                text,
                expected: expected.as_deref(),
                expected_target: None,
                eol: crate::sftp::Eol::Crlf,
                bom: false,
            };
            w.sftp.write_text(&w.ssh, HOST_ID, req).await
        }
    };
    let saved = save(file.clone(), "a=3\nb=2\n", Some(read.version.clone()))
        .await
        .unwrap();
    let again = w.sftp.read_text(&w.ssh, HOST_ID, &file).await.unwrap();
    assert_eq!(
        (again.text.as_str(), &again.version),
        ("a=3\nb=2\n", &saved.version)
    );
    let entries = w.list(&w.base).await.unwrap().entries;
    let entry = |name: &str| entries.iter().find(|e| e.name == name).unwrap().clone();
    assert_eq!(entry("app.ini").permissions.as_deref(), Some("rw-r-----"));
    assert_eq!(entry("link.ini").kind, EntryKind::Symlink);
    assert_eq!(w.names(&w.base).await, ["app.ini", "link.ini"]);

    // Same size, same second: only the content hash tells.
    w.exec(&format!("printf 'a=4\\r\\nb=2\\r\\n' > {file}"))
        .await;
    let err = save(file.clone(), "mine\n", Some(saved.version.clone()))
        .await
        .unwrap_err();
    assert!(matches!(err, FsError::Changed(_)), "{err:?}");

    let via_link = w
        .sftp
        .read_text(&w.ssh, HOST_ID, &w.at("link.ini"))
        .await
        .unwrap();
    assert_eq!(via_link.target.as_deref(), Some(file.as_str()));
    w.exec(&format!(
        "echo other > {} && ln -sf other.ini {}",
        w.at("other.ini"),
        w.at("link.ini")
    ))
    .await;
    let retargeted = save(w.at("link.ini"), "c=5\n", Some(via_link.version.clone()))
        .await
        .unwrap_err();
    assert!(
        matches!(retargeted, FsError::Retargeted(_)),
        "{retargeted:?}"
    );
    w.exec(&format!(
        "ln -sf app.ini {} && rm {}",
        w.at("link.ini"),
        w.at("other.ini")
    ))
    .await;
    save(w.at("link.ini"), "c=5\n", Some(via_link.version))
        .await
        .unwrap();
    let entries = w.list(&w.base).await.unwrap().entries;
    assert_eq!(
        entries.iter().find(|e| e.name == "link.ini").unwrap().kind,
        EntryKind::Symlink
    );
    assert_eq!(
        w.sftp.read_text(&w.ssh, HOST_ID, &file).await.unwrap().text,
        "c=5\n"
    );

    let current = w.sftp.read_text(&w.ssh, HOST_ID, &file).await.unwrap();
    w.exec(&format!("rm {file}")).await;
    let err = save(file.clone(), "x\n", Some(current.version))
        .await
        .unwrap_err();
    assert!(matches!(err, FsError::Deleted(_)), "{err:?}");
    save(file.clone(), "x\n", None).await.unwrap();
    assert_eq!(
        w.sftp.read_text(&w.ssh, HOST_ID, &file).await.unwrap().text,
        "x\n"
    );
    assert_eq!(w.names(&w.base).await, ["app.ini", "link.ini"]);
    w.cleanup().await;
}

#[tokio::test]
async fn editor_refuses_binary_and_unreadable_files() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = connected().await;
    let (bin, locked) = (w.at("bin"), w.at("locked"));
    w.exec(&format!(
        "printf 'a\\000b' > {bin} && echo x > {locked} && chmod 000 {locked}"
    ))
    .await;
    let code = |r: Result<TextFile, FsError>| r.unwrap_err().code();
    assert_eq!(
        code(w.sftp.read_text(&w.ssh, HOST_ID, &bin).await),
        "not_text"
    );
    assert_eq!(
        code(w.sftp.read_text(&w.ssh, HOST_ID, &locked).await),
        "permission_denied"
    );
    assert_eq!(
        code(w.sftp.read_text(&w.ssh, HOST_ID, &w.base).await),
        "invalid_input"
    );
    w.cleanup().await;
}
