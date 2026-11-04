use super::*;
use crate::ssh::test_server::{Connected, TestServer, manager_for, start_server};
use crate::ssh::test_sftp::{DEFAULT_OWNER, HOME, Node};

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

fn home(rest: &str) -> String {
    format!("{HOME}/{rest}")
}

impl World {
    async fn read(&self, path: &str) -> Result<TextFile, FsError> {
        self.sftp.read_text(&self.ssh.manager, "h1", path).await
    }

    async fn write(
        &self,
        path: &str,
        text: &str,
        expected: Option<&str>,
        eol: Eol,
        bom: bool,
    ) -> Result<Saved, FsError> {
        let req = WriteText {
            path,
            text,
            expected,
            expected_target: None,
            eol,
            bom,
        };
        self.sftp.write_text(&self.ssh.manager, "h1", req).await
    }

    async fn force(&self, path: &str, text: &str, target: Option<&str>) -> Result<Saved, FsError> {
        let req = WriteText {
            path,
            text,
            expected: None,
            expected_target: target,
            eol: Eol::Lf,
            bom: false,
        };
        self.sftp.write_text(&self.ssh.manager, "h1", req).await
    }

    async fn remote(&self) -> Arc<Remote> {
        self.sftp.channel(&self.ssh.manager, "h1").await.unwrap()
    }

    fn leftovers(&self) -> Vec<String> {
        self.server
            .fs()
            .paths_under("/")
            .into_iter()
            .filter(|p| p.ends_with(".carapace-part") || p.ends_with(".carapace-old"))
            .collect()
    }

    async fn save(&self, path: &str, text: &str, expected: Option<&str>) -> Result<Saved, FsError> {
        self.write(path, text, expected, Eol::Lf, false).await
    }

    fn put(&self, path: &str, bytes: &[u8]) {
        self.server.fs().data(path, bytes.to_vec());
    }

    fn bytes(&self, path: &str) -> Vec<u8> {
        self.server.fs().contents(path).unwrap()
    }

    fn temps(&self) -> Vec<String> {
        self.server
            .fs()
            .paths_under("/home")
            .into_iter()
            .filter(|p| p.ends_with(".carapace-part"))
            .collect()
    }
}

#[tokio::test]
async fn reads_text_with_its_line_endings_and_bom() {
    let w = world(110).await;
    w.put(&home("lf"), b"a\nb\n");
    w.put(&home("crlf"), b"a\r\nb\r\n");
    w.put(&home("mixed"), b"a\r\nb\n");
    w.put(&home("bom"), b"\xEF\xBB\xBFx\r\n");
    w.put(&home("empty"), b"");

    let lf = w.read(&home("lf")).await.unwrap();
    assert_eq!(
        (
            lf.text.as_str(),
            lf.line_ending,
            lf.bom,
            lf.size,
            lf.writable
        ),
        ("a\nb\n", LineEnding::Lf, false, 4, true)
    );
    let crlf = w.read(&home("crlf")).await.unwrap();
    assert_eq!(
        (crlf.text.as_str(), crlf.line_ending),
        ("a\nb\n", LineEnding::Crlf)
    );
    assert_eq!(crlf.size, 6);
    let mixed = w.read(&home("mixed")).await.unwrap();
    assert_eq!(
        (mixed.text.as_str(), mixed.line_ending),
        ("a\nb\n", LineEnding::Mixed)
    );
    let bom = w.read(&home("bom")).await.unwrap();
    assert_eq!(
        (bom.text.as_str(), bom.bom, bom.line_ending),
        ("x\n", true, LineEnding::Crlf)
    );
    assert_eq!(w.read(&home("empty")).await.unwrap().text, "");

    let json = serde_json::to_value(&crlf).unwrap();
    assert_eq!(json["lineEnding"], "crlf");
    assert_eq!(json["bom"], false);
    assert!(json["version"].as_str().unwrap().starts_with("v2:6:"));
    assert_eq!(serde_json::to_value(&mixed).unwrap()["lineEnding"], "mixed");
}

#[tokio::test]
async fn read_refuses_what_it_cannot_edit() {
    let w = world(111).await;
    let fs = w.server.fs();
    fs.file(&home("big"), MAX_TEXT_BYTES as u64 + 1);
    fs.file(&home("max"), MAX_TEXT_BYTES as u64);
    w.put(&home("nul"), b"a\0b");
    w.put(&home("latin1"), b"caf\xe9");
    fs.dir(&home("dir"));
    fs.link(&home("to-dir"), &home("dir"));
    fs.link(&home("dangling"), &home("nothing"));
    w.put(&home("secret"), b"x");
    fs.deny_file(&home("secret"));

    let code = |r: Result<TextFile, FsError>| r.unwrap_err().code();
    assert_eq!(code(w.read(&home("big")).await), "too_large");
    // Zero bytes: UTF-8, but NUL.
    assert_eq!(code(w.read(&home("max")).await), "not_text");
    assert_eq!(code(w.read(&home("nul")).await), "not_text");
    assert_eq!(code(w.read(&home("latin1")).await), "not_text");
    assert_eq!(code(w.read(&home("dir")).await), "invalid_input");
    assert_eq!(code(w.read(&home("to-dir")).await), "invalid_input");
    assert_eq!(code(w.read(&home("dangling")).await), "not_found");
    assert_eq!(code(w.read(&home("missing")).await), "not_found");
    assert_eq!(code(w.read(&home("secret")).await), "permission_denied");
    assert_eq!(code(w.read("").await), "invalid_input");
    assert_eq!(code(w.read("relative").await), "invalid_input");

    let not_text = w.read(&home("nul")).await.unwrap_err().to_string();
    assert_eq!(
        not_text,
        format!(
            "{} is not a text file (binary content or not UTF-8)",
            home("nul")
        )
    );
}

#[tokio::test]
async fn reads_through_a_link_to_a_regular_file() {
    let w = world(112).await;
    w.put(&home("real.conf"), b"k=v\n");
    w.server.fs().link(&home("link.conf"), &home("real.conf"));
    let via_link = w.read(&home("link.conf")).await.unwrap();
    assert_eq!(via_link.text, "k=v\n");
    assert_eq!(
        via_link.version,
        w.read(&home("real.conf")).await.unwrap().version
    );
}

#[tokio::test]
async fn files_without_write_bits_are_read_only() {
    let w = world(113).await;
    w.put(&home("ro"), b"x");
    w.server.fs().set_mode(&home("ro"), 0o444);
    assert!(!w.read(&home("ro")).await.unwrap().writable);
    w.server.fs().set_mode(&home("ro"), 0o604);
    assert!(w.read(&home("ro")).await.unwrap().writable);
}

#[tokio::test]
async fn version_changes_with_content_even_at_the_same_size_and_mtime() {
    let w = world(114).await;
    let p = home("f");
    w.put(&p, b"aaaa");
    let v1 = w.read(&p).await.unwrap().version;
    assert_eq!(w.read(&p).await.unwrap().version, v1);
    w.put(&p, b"aaab");
    let v2 = w.read(&p).await.unwrap().version;
    assert_ne!(v1, v2);
    w.server.fs().set_mtime(&p, 1_800_000_000);
    assert_ne!(w.read(&p).await.unwrap().version, v2);
}

#[tokio::test]
async fn save_replaces_the_file_atomically_and_keeps_its_mode() {
    let w = world(115).await;
    let p = home("app.env");
    w.put(&p, b"A=1\n");
    w.server.fs().set_mode(&p, 0o640);
    let read = w.read(&p).await.unwrap();

    let saved = w.save(&p, "A=2\n", Some(&read.version)).await.unwrap();
    assert_eq!(w.bytes(&p), b"A=2\n");
    assert_eq!(saved.size, 4);
    assert_eq!(w.server.fs().mode(&p), Some(0o640));
    assert!(w.temps().is_empty());
    assert!(w.server.fs().fsyncs() >= 1);
    assert_eq!(w.read(&p).await.unwrap().version, saved.version);

    // The returned version is the next save's base.
    w.save(&p, "A=3\n", Some(&saved.version)).await.unwrap();
    assert_eq!(w.bytes(&p), b"A=3\n");
    let json = serde_json::to_value(&saved).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 2);
    assert_eq!(json["size"], 4);
}

#[tokio::test]
async fn save_writes_back_crlf_and_bom() {
    let w = world(116).await;
    let p = home("win.ini");
    w.put(&p, b"\xEF\xBB\xBF[a]\r\nk=v\r\n");
    let read = w.read(&p).await.unwrap();
    let text = read.text.replace("k=v", "k=w");
    w.write(&p, &text, Some(&read.version), Eol::Crlf, read.bom)
        .await
        .unwrap();
    assert_eq!(w.bytes(&p), b"\xEF\xBB\xBF[a]\r\nk=w\r\n");
    w.write(&p, "x\ny", None, Eol::Lf, false).await.unwrap();
    assert_eq!(w.bytes(&p), b"x\ny");
}

#[tokio::test]
async fn save_refuses_a_file_changed_or_deleted_since_it_was_read() {
    let w = world(117).await;
    let p = home("nginx.conf");
    w.put(&p, b"old\n");
    let read = w.read(&p).await.unwrap();

    w.put(&p, b"new\n");
    let changed = w.save(&p, "mine\n", Some(&read.version)).await.unwrap_err();
    assert_eq!(changed.code(), "conflict");
    assert_eq!(
        changed.to_string(),
        format!("{p} changed on the server since it was opened")
    );
    assert_eq!(w.bytes(&p), b"new\n");

    w.put(&p, b"longer than before\n");
    assert!(matches!(
        w.save(&p, "mine\n", Some(&read.version)).await,
        Err(FsError::Changed(_))
    ));

    w.server.fs().remove(&p);
    let deleted = w.save(&p, "mine\n", Some(&read.version)).await.unwrap_err();
    assert_eq!(deleted.code(), "conflict");
    assert_eq!(
        deleted.to_string(),
        format!("{p} no longer exists on the server")
    );
    assert!(w.server.fs().get(&p).is_none());
    assert!(w.temps().is_empty());
}

#[tokio::test]
async fn forced_save_overwrites_and_recreates() {
    let w = world(118).await;
    let p = home("f.txt");
    w.put(&p, b"old");
    let read = w.read(&p).await.unwrap();
    w.put(&p, b"theirs");
    w.save(&p, "mine", None).await.unwrap();
    assert_eq!(w.bytes(&p), b"mine");
    assert_ne!(w.read(&p).await.unwrap().version, read.version);

    w.server.fs().remove(&p);
    let saved = w.save(&p, "again", None).await.unwrap();
    assert_eq!(w.bytes(&p), b"again");
    assert_eq!(w.server.fs().mode(&p), Some(NEW_FILE_MODE));
    assert_eq!(w.read(&p).await.unwrap().version, saved.version);
}

#[tokio::test]
async fn failed_write_removes_the_temp_and_keeps_the_original() {
    let w = world(119).await;
    let p = home("keep");
    w.put(&p, b"original");
    let read = w.read(&p).await.unwrap();
    w.server.fs().set_fail_writes(true);
    let err = w.save(&p, "new", Some(&read.version)).await.unwrap_err();
    assert_eq!(err, FsError::Io(p.clone()));
    assert_eq!(w.bytes(&p), b"original");
    assert!(w.temps().is_empty());
}

#[tokio::test]
async fn without_posix_rename_the_temp_replaces_the_original_moved_aside() {
    let w = world(120).await;
    w.server.fs().set_posix_rename(false);
    let p = home("aside");
    w.put(&p, b"one two three");
    w.server.fs().set_mode(&p, 0o600);
    let read = w.read(&p).await.unwrap();
    let saved = w.save(&p, "four", Some(&read.version)).await.unwrap();
    assert_eq!(w.bytes(&p), b"four");
    assert_eq!(w.server.fs().mode(&p), Some(0o600));
    assert!(w.leftovers().is_empty(), "{:?}", w.leftovers());
    assert_eq!(w.read(&p).await.unwrap().version, saved.version);

    w.server.fs().set_fail_writes(true);
    let err = w.save(&p, "never", Some(&saved.version)).await.unwrap_err();
    assert_eq!(err, FsError::Io(p.clone()));
    assert_eq!(w.bytes(&p), b"four");
    assert!(w.leftovers().is_empty());
    w.server.fs().set_fail_writes(false);

    w.put(&p, b"five");
    assert_eq!(
        w.save(&p, "six", Some(&saved.version))
            .await
            .unwrap_err()
            .code(),
        "conflict"
    );
    // A new file still goes through a temp and a rename that never replaces.
    w.save(&home("brand-new"), "x", None).await.unwrap();
    assert_eq!(w.bytes(&home("brand-new")), b"x");
    assert!(w.temps().is_empty());
}

#[tokio::test]
async fn a_file_of_another_owner_or_in_a_locked_directory_is_rewritten_in_place() {
    let w = world(121).await;
    let p = home("owned-by-root");
    w.put(&p, b"x");
    w.server.fs().set_owner(&p, 0, 0);
    let read = w.read(&p).await.unwrap();
    w.save(&p, "y", Some(&read.version)).await.unwrap();
    assert_eq!(w.bytes(&p), b"y");
    assert_eq!(w.server.fs().owner(&p), (0, 0));
    assert!(w.temps().is_empty());

    w.server.fs().denied_dir("/etc");
    let conf = "/etc/hosts".to_string();
    w.put(&conf, b"127.0.0.1 a\n");
    let read = w.read(&conf).await.unwrap();
    w.save(&conf, "127.0.0.1 b\n", Some(&read.version))
        .await
        .unwrap();
    assert_eq!(w.bytes(&conf), b"127.0.0.1 b\n");
    assert_eq!(w.server.fs().owner(&p), (0, 0));
    assert_eq!(
        w.save("/etc/new", "x", None).await.unwrap_err(),
        FsError::PermissionDenied("/etc/new".into())
    );
    assert_ne!(DEFAULT_OWNER, (0, 0));
}

#[tokio::test]
async fn saving_through_a_link_writes_its_target_and_keeps_the_link() {
    let w = world(122).await;
    let target = home("real.conf");
    let link = home("link.conf");
    w.put(&target, b"a");
    w.server.fs().link(&link, &target);
    let read = w.read(&link).await.unwrap();
    w.save(&link, "b", Some(&read.version)).await.unwrap();
    assert_eq!(w.server.fs().get(&link), Some(Node::Link(target.clone())));
    assert_eq!(w.bytes(&target), b"b");

    w.server.fs().link(&home("dangling"), &home("nothing"));
    assert_eq!(
        w.save(&home("dangling"), "x", None)
            .await
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(
        w.save(&home("dangling"), "x", Some(&read.version))
            .await
            .unwrap_err()
            .code(),
        "conflict"
    );
}

#[tokio::test]
async fn save_validates_its_input() {
    let w = world(123).await;
    let p = home("v");
    w.put(&p, b"x");
    let code = |r: Result<Saved, FsError>| r.unwrap_err().code();
    assert_eq!(
        code(w.save(&p, "y", Some("v2:bogus")).await),
        "invalid_input"
    );
    let v1 = format!("v1:1:1700000000:{}", "a".repeat(64));
    assert_eq!(code(w.save(&p, "y", Some(&v1)).await), "invalid_input");
    let big = "x".repeat(MAX_TEXT_BYTES + 1);
    assert_eq!(code(w.save(&p, &big, None).await), "too_large");
    let crlf_big = "\n".repeat(MAX_TEXT_BYTES / 2 + 1);
    assert_eq!(
        code(w.write(&p, &crlf_big, None, Eol::Crlf, false).await),
        "too_large"
    );
    w.server.fs().dir(&home("d"));
    assert_eq!(code(w.save(&home("d"), "x", None).await), "invalid_input");
    assert_eq!(code(w.save("", "x", None).await), "invalid_input");
    assert_eq!(code(w.save("/", "x", None).await), "invalid_input");
    assert_eq!(w.bytes(&p), b"x");
}

#[tokio::test]
async fn editor_calls_need_a_live_connection() {
    let w = world(124).await;
    w.ssh.manager.disconnect("h1").await.unwrap();
    assert_eq!(
        w.read(&home(".profile")).await.unwrap_err(),
        FsError::NotConnected
    );
    assert_eq!(
        w.save(&home(".profile"), "x", None).await.unwrap_err(),
        FsError::NotConnected
    );
}

#[tokio::test]
async fn in_place_rewrite_refuses_a_file_swapped_for_a_link() {
    let w = world(125).await;
    let (p, victim) = (home("conf"), home("victim"));
    w.put(&p, b"original");
    w.put(&victim, b"precious data");
    let r = w.remote().await;
    let original = r.lstat(&p).await.unwrap();
    w.server.fs().link(&p, &victim);
    let err = r
        .rewrite(&p, &mut Body::bytes(b"new"), &original, &p)
        .await
        .unwrap_err();
    assert_eq!(err, FsError::Changed(p.clone()));
    assert_eq!(w.bytes(&victim), b"precious data");

    // Same size and mtime, other owner: still refused.
    w.put(&victim, b"original");
    w.server.fs().set_owner(&victim, 0, 0);
    let err = r
        .rewrite(&p, &mut Body::bytes(b"new"), &original, &p)
        .await
        .unwrap_err();
    assert_eq!(err, FsError::Changed(p.clone()));
    assert_eq!(w.bytes(&victim), b"original");
}

#[tokio::test]
async fn in_place_rewrite_shrinks_through_the_handle() {
    let w = world(126).await;
    let p = home("root-owned");
    w.put(&p, b"a much longer original content\n");
    w.server.fs().set_owner(&p, 0, 0);
    w.server.fs().set_mode(&p, 0o664);
    let read = w.read(&p).await.unwrap();
    let saved = w.save(&p, "short\n", Some(&read.version)).await.unwrap();
    assert_eq!(w.bytes(&p), b"short\n");
    assert_eq!(w.server.fs().owner(&p), (0, 0));
    assert_eq!(w.server.fs().mode(&p), Some(0o664));
    assert_eq!(w.read(&p).await.unwrap().version, saved.version);
    assert!(w.leftovers().is_empty());
    // Forced saves go through the same handle check.
    w.force(&p, "forced\n", None).await.unwrap();
    assert_eq!(w.bytes(&p), b"forced\n");
}

#[tokio::test]
async fn a_failure_during_an_in_place_rewrite_is_partial_write() {
    let w = world(127).await;
    let p = home("root-owned");
    w.put(&p, b"before");
    w.server.fs().set_owner(&p, 0, 0);
    let read = w.read(&p).await.unwrap();
    w.server.fs().set_fail_writes(true);
    let err = w.save(&p, "after", Some(&read.version)).await.unwrap_err();
    assert_eq!(err, FsError::PartialWrite(p.clone()));
    assert_eq!(err.code(), "partial_write");
    assert_eq!(
        err.to_string(),
        format!("{p} may be incomplete on the server: the save failed while writing")
    );
}

#[tokio::test]
async fn a_link_pointed_elsewhere_is_never_saved_through() {
    let w = world(128).await;
    let (link, a, b) = (home("current"), home("a.conf"), home("b.conf"));
    w.put(&a, b"A");
    w.put(&b, b"B");
    w.server.fs().link(&link, &a);
    let read = w.read(&link).await.unwrap();
    assert_eq!(read.target.as_deref(), Some(a.as_str()));
    assert_eq!(w.read(&a).await.unwrap().target, None);
    assert_eq!(serde_json::to_value(&read).unwrap()["target"], a.as_str());

    w.server.fs().link(&link, &b);
    let err = w
        .save(&link, "mine", Some(&read.version))
        .await
        .unwrap_err();
    assert_eq!(err, FsError::Retargeted(link.clone()));
    assert_eq!(err.code(), "conflict");
    let err = w.force(&link, "mine", Some(&a)).await.unwrap_err();
    assert_eq!(err, FsError::Retargeted(link.clone()));
    assert_eq!(
        w.force(&link, "mine", None).await.unwrap_err(),
        FsError::Retargeted(link.clone())
    );
    assert_eq!((w.bytes(&a), w.bytes(&b)), (b"A".to_vec(), b"B".to_vec()));

    w.force(&link, "mine", Some(&b)).await.unwrap();
    assert_eq!(w.bytes(&b), b"mine");
    // A forced save without a target never goes through a link.
    w.server.fs().link(&home("plain"), &a);
    assert_eq!(
        w.force(&home("plain"), "x", None).await.unwrap_err().code(),
        "conflict"
    );
}

#[tokio::test]
async fn setuid_and_setgid_are_not_copied() {
    let w = world(129).await;
    let p = home("tool.sh");
    w.put(&p, b"#!/bin/sh\n");
    w.server.fs().set_mode(&p, 0o6755);
    let read = w.read(&p).await.unwrap();
    w.save(&p, "#!/bin/sh\nexit 0\n", Some(&read.version))
        .await
        .unwrap();
    assert_eq!(w.server.fs().mode(&p), Some(0o755));
}

#[tokio::test]
async fn a_new_file_never_replaces_one_created_meanwhile() {
    let w = world(132).await;
    let p = home("race");
    let r = w.remote().await;
    w.put(&p, b"theirs");
    assert_eq!(
        r.create_file(&p, &mut Body::bytes(b"mine"), &p)
            .await
            .unwrap_err(),
        FsError::Changed(p.clone())
    );
    assert_eq!(w.bytes(&p), b"theirs");
    assert!(w.leftovers().is_empty());
}

#[test]
fn owners_missing_on_one_side_differ() {
    let with = |uid, gid| FileAttributes {
        uid,
        gid,
        ..FileAttributes::empty()
    };
    assert!(!owner_differs(
        &with(Some(1), Some(2)),
        &with(Some(1), Some(2))
    ));
    assert!(!owner_differs(&with(None, None), &with(None, None)));
    assert!(owner_differs(&with(Some(1), Some(2)), &with(None, Some(2))));
    assert!(owner_differs(&with(Some(1), None), &with(Some(1), Some(2))));
    assert!(owner_differs(
        &with(Some(1), Some(2)),
        &with(Some(3), Some(2))
    ));
}

#[test]
fn errors_on_resolved_paths_name_the_user_path() {
    for (e, want) in [
        (
            FsError::NotFound("/real".into()),
            FsError::NotFound("/l".into()),
        ),
        (
            FsError::PermissionDenied("/real".into()),
            FsError::PermissionDenied("/l".into()),
        ),
        (FsError::Io("/real".into()), FsError::Io("/l".into())),
        (
            FsError::TooLarge("/real".into()),
            FsError::TooLarge("/l".into()),
        ),
        (FsError::Network, FsError::Network),
    ] {
        assert_eq!(on_user_path(e, "/l"), want);
    }
}
