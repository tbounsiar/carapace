use super::*;

fn s(p: &Path) -> String {
    display(&fs::canonicalize(p).unwrap()).unwrap()
}

fn names(l: &Listing) -> Vec<&str> {
    let mut n: Vec<&str> = l.entries.iter().map(|e| e.name.as_str()).collect();
    n.sort();
    n
}

#[test]
fn lists_entries_including_hidden() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), b"hello").unwrap();
    fs::write(dir.path().join(".hidden"), b"").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    let l = list(&s(dir.path())).unwrap();
    assert_eq!(l.path, s(dir.path()));
    assert_eq!(
        l.parent.as_deref(),
        Some(s(dir.path().parent().unwrap()).as_str())
    );
    assert_eq!(names(&l), [".hidden", "a.txt", "sub"]);
    let a = l.entries.iter().find(|e| e.name == "a.txt").unwrap();
    assert_eq!(
        (a.kind, a.size, a.hidden),
        (EntryKind::File, Some(5), false)
    );
    assert_eq!(PathBuf::from(&a.path), PathBuf::from(&l.path).join("a.txt"));
    assert!(a.modified.is_some());
    assert_eq!(a.permissions.is_some(), cfg!(unix));
    assert!(
        l.entries
            .iter()
            .find(|e| e.name == ".hidden")
            .unwrap()
            .hidden
    );
    let sub = l.entries.iter().find(|e| e.name == "sub").unwrap();
    assert_eq!((sub.kind, sub.size), (EntryKind::Dir, None));
}

#[cfg(windows)]
#[test]
fn windows_hidden_attribute_marks_entries_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("plain");
    fs::write(&f, b"").unwrap();
    let ok = std::process::Command::new("attrib")
        .arg("+h")
        .arg(&f)
        .status()
        .is_ok_and(|st| st.success());
    if !ok {
        eprintln!("skipped: attrib unavailable");
        return;
    }
    let l = list(&s(dir.path())).unwrap();
    assert!(l.entries[0].hidden);
}

#[test]
fn lists_normalized_path_and_rejects_files_and_missing() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("f"), b"").unwrap();
    let base = s(dir.path());
    let dotted = format!("{base}{0}sub{0}..{0}.", std::path::MAIN_SEPARATOR);
    assert_eq!(list(&dotted).unwrap().path, base);
    let f = format!("{base}{}f", std::path::MAIN_SEPARATOR);
    assert_eq!(list(&f).unwrap_err().code(), "invalid_input");
    let missing = format!("{base}{}nope", std::path::MAIN_SEPARATOR);
    assert_eq!(list(&missing).unwrap_err().code(), "not_found");
    assert_eq!(list("relative").unwrap_err().code(), "invalid_input");
}

#[test]
fn empty_path_lists_roots() {
    let l = list("").unwrap();
    assert_eq!((l.path.as_str(), l.parent.as_ref()), ("", None));
    assert!(!l.entries.is_empty());
    for e in &l.entries {
        assert_eq!(e.kind, EntryKind::Dir);
        let resolved = resolve(&e.path).unwrap().unwrap();
        assert!(resolved.parent().is_none(), "{}", e.path);
    }
    if cfg!(unix) {
        assert_eq!(l.entries[0].path, "/");
    } else {
        assert!(
            l.entries
                .iter()
                .all(|e| e.path.ends_with(":\\") && e.name.len() == 2)
        );
    }
}

#[test]
fn home_is_absolute() {
    let h = home().unwrap();
    assert!(resolve(&h).unwrap().is_some());
}

#[test]
fn mkdir_creates_and_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let base = s(dir.path());
    let made = mkdir(&base, "new").unwrap();
    assert_eq!(made.kind, EntryKind::Dir);
    assert_eq!(made.name, "new");
    assert!(dir.path().join("new").is_dir());
    assert_eq!(mkdir(&base, "new").unwrap_err().code(), "already_exists");
    for bad in ["", ".", "..", "a/b", "a\\b", "a\0", &"x".repeat(256)] {
        assert_eq!(
            mkdir(&base, bad).unwrap_err().code(),
            "invalid_input",
            "{bad:?}"
        );
    }
    assert_eq!(mkdir("", "x").unwrap_err().code(), "invalid_input");
    let missing = format!("{base}{}nope", std::path::MAIN_SEPARATOR);
    assert_eq!(mkdir(&missing, "x").unwrap_err().code(), "not_found");
}

#[test]
fn rename_in_place_with_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(s(dir.path()));
    fs::write(base.join("a"), b"1").unwrap();
    fs::write(base.join("b"), b"2").unwrap();
    let a = base.join("a").to_str().unwrap().to_owned();
    assert_eq!(rename(&a, "b").unwrap_err().code(), "already_exists");
    assert_eq!(fs::read(base.join("b")).unwrap(), b"2");
    let moved = rename(&a, "c").unwrap();
    assert_eq!(moved.name, "c");
    assert!(!base.join("a").exists());
    assert_eq!(fs::read(base.join("c")).unwrap(), b"1");
    let c = base.join("c").to_str().unwrap().to_owned();
    assert_eq!(rename(&c, "c").unwrap().name, "c");
    assert_eq!(rename(&c, "x/y").unwrap_err().code(), "invalid_input");
    let ghost = base.join("ghost").to_str().unwrap().to_owned();
    assert_eq!(rename(&ghost, "z").unwrap_err().code(), "not_found");
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    assert_eq!(rename(root, "z").unwrap_err().code(), "invalid_input");
}

#[test]
fn case_only_rename_works() {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(s(dir.path()));
    fs::write(base.join("name"), b"").unwrap();
    let p = base.join("name").to_str().unwrap().to_owned();
    assert_eq!(rename(&p, "NAME").unwrap().name, "NAME");
    let listed = list(base.to_str().unwrap()).unwrap();
    assert_eq!(names(&listed), ["NAME"]);
}

#[test]
fn delete_needs_recursive_for_non_empty_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(s(dir.path()));
    let tree = base.join("tree");
    fs::create_dir_all(tree.join("sub/deeper")).unwrap();
    fs::write(tree.join("sub/deeper/f"), b"").unwrap();
    fs::write(tree.join("g"), b"").unwrap();
    let t = tree.to_str().unwrap();
    assert_eq!(delete(t, false).unwrap_err().code(), "not_empty");
    delete(tree.join("g").to_str().unwrap(), false).unwrap();
    delete(t, true).unwrap();
    assert!(!tree.exists());
    assert_eq!(delete(t, true).unwrap_err().code(), "not_found");
    fs::create_dir(&tree).unwrap();
    delete(t, false).unwrap();
}

#[test]
fn delete_refuses_roots_and_home() {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    assert_eq!(delete(root, true).unwrap_err().code(), "invalid_input");
    assert_eq!(delete("", true).unwrap_err().code(), "invalid_input");
    assert_eq!(
        delete(&home().unwrap(), true).unwrap_err().code(),
        "invalid_input"
    );
}

/// Creates `link` -> `target` (a directory) if the OS lets the test do it.
fn dir_link(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }
}

#[cfg(windows)]
fn junction(target: &Path, link: &Path) -> bool {
    std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn assert_link_not_followed(make: fn(&Path, &Path) -> bool, what: &str) {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(s(dir.path()));
    let keep = base.join("keep");
    fs::create_dir(&keep).unwrap();
    fs::write(keep.join("precious"), b"x").unwrap();
    let tree = base.join("tree");
    fs::create_dir(&tree).unwrap();
    if !make(&keep, &tree.join("link")) || !make(&keep, &base.join("top-link")) {
        eprintln!("skipped: cannot create a {what} here");
        return;
    }
    let l = list(tree.to_str().unwrap()).unwrap();
    assert_eq!(l.entries[0].kind, EntryKind::Symlink, "{what}");

    delete(tree.to_str().unwrap(), true).unwrap();
    assert!(!tree.exists());
    delete(base.join("top-link").to_str().unwrap(), false).unwrap();
    assert!(fs::symlink_metadata(base.join("top-link")).is_err());
    assert_eq!(fs::read(keep.join("precious")).unwrap(), b"x", "{what}");
}

#[test]
fn delete_never_follows_symlinks() {
    assert_link_not_followed(dir_link, "symlink");
}

#[cfg(windows)]
#[test]
fn delete_never_follows_junctions() {
    assert_link_not_followed(junction, "junction");
}

#[cfg(unix)]
#[test]
fn file_symlink_is_removed_not_its_target() {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(s(dir.path()));
    fs::write(base.join("t"), b"x").unwrap();
    std::os::unix::fs::symlink(base.join("t"), base.join("l")).unwrap();
    delete(base.join("l").to_str().unwrap(), true).unwrap();
    assert!(base.join("t").exists());
}
