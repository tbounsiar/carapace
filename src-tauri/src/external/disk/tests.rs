use super::*;

const HOST: &str = "3f2c1a6e-8d4b-4c2a-9f1e-2b7d6c5a4e3f";

fn manifest(slot: &Slot, hash: &str) -> Manifest {
    Manifest {
        version: 1,
        host_id: HOST.into(),
        remote_path: "/etc/a.conf".into(),
        file_name: slot.name.clone(),
        token: format!("v2:1:-:{}:{}", "a".repeat(64), "b".repeat(64)),
        target: None,
        synced_hash: hash.into(),
        synced_size: 1,
        opened_at: 1,
        synced_at: Some(1),
        uploaded_at: None,
        host_key: "SHA256:abc".into(),
        endpoint: "example.org:22:me".into(),
    }
}

fn hash_of(data: &[u8]) -> String {
    crate::sftp::hex(&Sha256::digest(data))
}

/// A slot holding `content`, synced at `synced` (or with no manifest).
fn slot_with(root: &Path, content: &[u8], synced: Option<&[u8]>) -> Slot {
    let slot = Slot::create(root, "a.conf").unwrap();
    let (temp, mut f) = slot.create_temp().unwrap();
    f.write_all(content).unwrap();
    drop(f);
    slot.place(&temp, false).unwrap();
    if let Some(s) = synced {
        slot.write_manifest(&manifest(&slot, &hash_of(s))).unwrap();
    }
    slot
}

#[test]
fn copies_dirs_and_manifests_are_owner_only() {
    let home = tempfile::tempdir().unwrap();
    let root = root(home.path());
    let slot = slot_with(&root, b"x", Some(b"x"));
    assert!(!fsutil::dir_open_to_others(&root).unwrap());
    assert!(!fsutil::dir_open_to_others(&slot.dir).unwrap());
    let open = |p: PathBuf| File::open(p).unwrap();
    assert!(fsutil::is_owner_only(&open(slot.file())));
    assert!(fsutil::is_owner_only(&open(slot.dir.join(MANIFEST))));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for d in [&root, &slot.dir] {
            assert_eq!(fs::metadata(d).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert!(!exec_bit(&fs::metadata(slot.file()).unwrap()));
    }
    let names: Vec<_> = fs::read_dir(&slot.dir)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    let back: Manifest =
        serde_json::from_slice(&fs::read(slot.dir.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(back, manifest(&slot, &hash_of(b"x")));
}

#[test]
fn a_replaced_slot_directory_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let root = root(home.path());
    let slot = slot_with(&root, b"x", None);
    assert_eq!(slot.local_state().unwrap().hash, hash_of(b"x"));
    fs::remove_dir_all(&slot.dir).unwrap();
    fs::create_dir(&slot.dir).unwrap();
    fs::write(slot.file(), b"x").unwrap();
    assert_eq!(
        slot.local_state().unwrap_err().kind(),
        ErrorKind::InvalidInput
    );
    assert!(slot.write_manifest(&manifest(&slot, "h")).is_err());
}

#[test]
fn a_link_planted_as_the_copy_is_never_followed() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret");
    fs::write(&secret, b"outside").unwrap();
    let slot = slot_with(&root(home.path()), b"x", None);
    fs::remove_file(slot.file()).unwrap();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&secret, slot.file()).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&secret, slot.file()).is_ok();
    if !linked {
        return;
    }
    assert_eq!(slot.open().unwrap_err().kind(), ErrorKind::InvalidInput);
    slot.remove().unwrap();
    assert_eq!(fs::read(&secret).unwrap(), b"outside");
}

#[cfg(windows)]
#[test]
fn a_junction_planted_as_a_slot_is_removed_as_a_link() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep"), b"k").unwrap();
    let root = root(home.path());
    ensure_root(&root).unwrap();
    let planted = root.join(Uuid::new_v4().to_string());
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&planted)
        .arg(outside.path())
        .output()
        .is_ok_and(|o| o.status.success());
    if !made {
        return;
    }
    assert!(scan(&root).is_empty());
    assert!(fs::symlink_metadata(&planted).is_err());
    assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"k");
}

#[test]
fn startup_scan_keeps_unsynced_copies_only() {
    let home = tempfile::tempdir().unwrap();
    let root = root(home.path());
    let synced = slot_with(&root, b"same", Some(b"same"));
    let changed = slot_with(&root, b"edited", Some(b"original"));
    let incomplete = slot_with(&root, b"partial", None);
    let empty = Slot::create(&root, "e").unwrap();
    fs::write(empty.dir.join(MANIFEST), b"{not json").unwrap();
    let unreadable = slot_with(&root, b"keep me", None);
    fs::write(unreadable.dir.join(MANIFEST), b"{not json").unwrap();
    let gone = slot_with(&root, b"x", Some(b"x"));
    fs::remove_file(gone.file()).unwrap();
    let stranger = root.join("not-an-id");
    fs::create_dir(&stranger).unwrap();

    let found = scan(&root);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].slot.id, changed.id);
    assert_eq!(found[0].size, 6);
    assert!(found[0].modified_ms.is_some());
    assert_eq!(found[0].manifest.remote_path, "/etc/a.conf");
    for gone in [&synced, &incomplete, &empty, &gone] {
        assert!(!gone.dir.exists(), "{}", gone.id);
    }
    assert!(changed.dir.exists());
    assert!(
        unreadable.dir.exists(),
        "never deleted without knowing what it is"
    );
    assert!(stranger.exists());
    assert_eq!(scan(&root).len(), 1, "a second scan keeps it");
}

type Breaker = Box<dyn Fn(&mut Manifest)>;

#[test]
fn manifests_that_do_not_hold_together_are_kept_aside() {
    let home = tempfile::tempdir().unwrap();
    let root = root(home.path());
    let cases: Vec<Breaker> = vec![
        Box::new(|m| m.file_name = "../../escape".into()),
        // A planted manifest aiming an upload at another file.
        Box::new(|m| m.remote_path = "/root/.ssh/authorized_keys".into()),
        Box::new(|m| m.remote_path = "/etc/../etc/a.conf".into()),
        Box::new(|m| m.remote_path = "/".into()),
        Box::new(|m| m.remote_path = "etc/a.conf".into()),
        Box::new(|m| m.token = "v2:garbage".into()),
        Box::new(|m| m.target = Some("/x/../y".into())),
        Box::new(|m| m.host_id = "not-an-id".into()),
        Box::new(|m| m.host_key = String::new()),
        Box::new(|m| m.endpoint = String::new()),
        Box::new(|m| m.version = 2),
    ];
    for (i, break_it) in cases.iter().enumerate() {
        let slot = slot_with(&root, b"x", None);
        let mut m = manifest(&slot, &hash_of(b"y"));
        assert!(m.is_valid());
        break_it(&mut m);
        assert!(!m.is_valid(), "case {i}");
        slot.write_manifest(&m).unwrap();
        assert!(scan(&root).is_empty(), "case {i}");
        assert!(slot.dir.exists(), "case {i}: never deleted");
        slot.remove().unwrap();
    }
    let slot = slot_with(&root, b"x", None);
    let mut m = manifest(&slot, &hash_of(b"y"));
    m.target = Some("/srv/real/a.conf".into());
    slot.write_manifest(&m).unwrap();
    assert_eq!(scan(&root).len(), 1);
}

#[cfg(windows)]
#[test]
fn nothing_is_read_from_directories_others_can_reach() {
    let home = tempfile::tempdir().unwrap();
    let root = root(home.path());
    let slot = slot_with(&root, b"changed", Some(b"orig"));
    let open_slot = root.join(Uuid::new_v4().to_string());
    fsutil::create_dir_with_sddl(&open_slot, "D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;%ME%)").unwrap();
    fs::write(open_slot.join(MANIFEST), b"{}").unwrap();
    let found = scan(&root);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].slot.id, slot.id);
    assert!(open_slot.join(MANIFEST).exists(), "left alone, not deleted");

    let shared_home = tempfile::tempdir().unwrap();
    let shared_root = shared_home.path().join("edit");
    fsutil::create_dir_with_sddl(&shared_root, "D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;%ME%)").unwrap();
    let id = Uuid::new_v4().to_string();
    fs::create_dir(shared_root.join(&id)).unwrap();
    assert!(scan(&shared_root).is_empty());
    assert!(shared_root.join(&id).exists());
}

#[cfg(windows)]
#[test]
fn downloaded_copies_are_marked_as_from_the_internet() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.conf");
    fs::write(&file, b"x").unwrap();
    mark_downloaded(&file);
    let mut stream = file.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let mark = fs::read_to_string(stream).unwrap();
    assert!(mark.contains("ZoneId=3"), "{mark}");
}

#[test]
fn a_stamp_sees_rewrites_and_replacements() {
    let home = tempfile::tempdir().unwrap();
    let slot = slot_with(&root(home.path()), b"one", None);
    let (file, stamp) = slot.open_locked().unwrap();
    assert!(slot.unchanged_since(&stamp));
    #[cfg(windows)]
    {
        assert!(
            fs::write(slot.file(), b"two").is_err(),
            "locked while streamed"
        );
        let other = slot.dir.join("other");
        fs::write(&other, b"two").unwrap();
        assert!(
            fs::rename(&other, slot.file()).is_err(),
            "cannot be replaced while streamed"
        );
        fs::remove_file(&other).unwrap();
    }
    drop(file);
    let other = slot.dir.join("other");
    fs::write(&other, b"one").unwrap();
    fs::rename(&other, slot.file()).unwrap();
    assert!(!slot.unchanged_since(&stamp));
}

#[test]
fn scanning_a_missing_root_does_nothing() {
    let home = tempfile::tempdir().unwrap();
    assert!(scan(&root(home.path())).is_empty());
    assert!(!root(home.path()).exists());
}

#[test]
fn snapshots_are_private_bounded_and_deleted_after_use() {
    let home = tempfile::tempdir().unwrap();
    let slot = slot_with(&root(home.path()), b"content", None);
    assert!(matches!(slot.snapshot(3).unwrap(), Snap::TooLarge));
    let Snap::Ready(mut snap) = slot.snapshot(1024).unwrap() else {
        panic!("not ready");
    };
    let mut f = snap.take_file().unwrap();
    assert!(fsutil::is_owner_only(&f));
    let mut back = Vec::new();
    f.read_to_end(&mut back).unwrap();
    assert_eq!(back, b"content");
    drop(f);
    let names = |d: &Path| fs::read_dir(d).unwrap().count();
    assert_eq!(names(&slot.dir), 2, "copy and snapshot");
    drop(snap);
    assert_eq!(names(&slot.dir), 1, "snapshot removed");
}

#[cfg(unix)]
#[test]
fn an_open_root_is_refused_not_tightened() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let root = root(home.path());
    let slot = slot_with(&root, b"changed", Some(b"orig"));
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(scan(&root).is_empty());
    assert!(slot.dir.exists());
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert!(Slot::create(&root, "b").is_err());
}
