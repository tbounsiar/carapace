use std::fs;
use std::path::{Path, PathBuf};

use russh::keys::ssh_key::LineEnding;

use super::location::KeyDir;
use super::*;
use crate::fsutil::{self, is_owner_only};
use crate::ssh::test_server::ed25519;

fn s(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn canon(path: &Path) -> PathBuf {
    fsutil::canonical(path).unwrap()
}

/// A folder only the current user can open (a plain temp dir inherits a broad ACL here).
fn private_dir(parent: &Path, name: &str) -> PathBuf {
    let dir = parent.join(name);
    fsutil::ensure_dir_owner_only(&dir).unwrap();
    dir
}

fn shared_dir(parent: &Path, name: &str) -> PathBuf {
    let dir = parent.join(name);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(windows)]
    fsutil::create_dir_with_sddl(&dir, "D:P(A;OICI;FR;;;WD)(A;OICI;FA;;;%ME%)").unwrap();
    dir
}

/// A folder the user can list but not add files to. `None` when the OS ignores it (root).
fn read_only_dir(parent: &Path, name: &str) -> Option<PathBuf> {
    let dir = parent.join(name);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        if fs::write(dir.join("probe"), b"").is_ok() {
            return None;
        }
    }
    // Read, traverse and delete on the folder itself, nothing to create entries.
    #[cfg(windows)]
    fsutil::create_dir_with_sddl(&dir, "D:P(A;;0x1300a9;;;%ME%)").unwrap();
    Some(dir)
}

pub(super) fn dir_link(target: &Path, link: &Path) -> bool {
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

fn code<T: std::fmt::Debug>(r: Result<T, KeyError>) -> (&'static str, String) {
    let e = r.unwrap_err();
    (e.code(), e.to_string())
}

#[test]
fn default_location_is_the_managed_dir() {
    let home = tempfile::tempdir().unwrap();
    let managed = keys_dir(home.path());
    let loc = check_location(&managed, None, "id_ed25519").unwrap();
    assert_eq!(loc.dir, managed, "not created by a check");
    assert!(loc.is_default && loc.warning.is_none());
    assert!(!managed.exists());

    generate(
        &KeyDir::managed(&managed),
        "taken",
        KeyType::Ed25519,
        "",
        None,
    )
    .unwrap();
    let loc = check_location(&managed, None, "other").unwrap();
    assert_eq!(loc.dir, canon(&managed));
    assert_eq!(
        code(check_location(&managed, None, "taken")),
        (
            "already_exists",
            "taken or taken.pub already exists in this folder.".into()
        )
    );
    let same = check_location(&managed, Some(&s(&managed)), "other").unwrap();
    assert!(same.is_default && same.warning.is_none());
    assert_eq!(
        code(check_location(&managed, None, "../x")).0,
        "invalid_input"
    );
}

#[test]
fn custom_location_rules() {
    let home = tempfile::tempdir().unwrap();
    let managed = keys_dir(home.path());
    let own = private_dir(home.path(), "own");
    let loc = check_location(&managed, Some(&s(&own)), "id_work").unwrap();
    assert_eq!(loc.dir, canon(&own));
    assert!(!loc.is_default);
    assert_eq!(loc.warning, None);
    assert!(
        fs::read_dir(&own).unwrap().next().is_none(),
        "probe removed"
    );

    let shared = shared_dir(home.path(), "shared");
    let loc = check_location(&managed, Some(&s(&shared)), "id_work").unwrap();
    assert!(
        loc.warning
            .unwrap()
            .starts_with("Other users can open this folder.")
    );

    assert_eq!(
        code(check_location(
            &managed,
            Some(&s(&home.path().join("missing"))),
            "k"
        )),
        ("not_found", "This folder does not exist.".into())
    );
    let file = home.path().join("file");
    fs::write(&file, b"").unwrap();
    assert_eq!(
        code(check_location(&managed, Some(&s(&file)), "k")),
        ("invalid_input", "This is a file, not a folder.".into())
    );
    for bad in ["relative/dir", "", "  ", "\\\\server\\share", "~"] {
        assert_eq!(
            code(check_location(&managed, Some(bad), "k")).0,
            "invalid_input",
            "{bad}"
        );
    }
    fs::write(own.join("id_pub_only.pub"), b"x").unwrap();
    assert_eq!(
        code(check_location(&managed, Some(&s(&own)), "id_pub_only")).0,
        "already_exists"
    );

    let link = home.path().join("link");
    if dir_link(&own, &link) {
        assert_eq!(
            code(check_location(&managed, Some(&s(&link)), "k")),
            (
                "invalid_input",
                "Links are not accepted. Choose the real folder.".into()
            )
        );
    }
    if let Some(ro) = read_only_dir(home.path(), "ro") {
        assert_eq!(
            code(check_location(&managed, Some(&s(&ro)), "k")),
            (
                "permission_denied",
                "Carapace cannot write to this folder. Choose another one.".into()
            )
        );
        assert!(fs::read_dir(&ro).unwrap().next().is_none());
    }
}

#[test]
fn network_and_device_paths_are_refused_everywhere() {
    let home = tempfile::tempdir().unwrap();
    let managed = keys_dir(home.path());
    fs::create_dir(&managed).unwrap();
    for raw in fsutil::NON_LOCAL {
        assert_eq!(
            code(key_dir(&managed, Some(raw))).0,
            "invalid_input",
            "{raw}"
        );
        assert_eq!(
            code(check_location(&managed, Some(raw), "k")).0,
            "invalid_input",
            "{raw}"
        );
        assert_eq!(code(inspect(raw, None)).0, "invalid_input", "{raw}");
        assert!(crate::config::validate::key_path(raw).is_err(), "{raw}");
        assert_eq!(
            folder_start(Some(raw), &managed),
            Some(canon(&managed)),
            "{raw}"
        );
        let user = home.path();
        assert_eq!(
            file_start(Some(raw), Some(user)),
            Some(canon(user)),
            "{raw}"
        );
    }
}

#[test]
fn a_folder_swapped_after_the_check_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let managed = keys_dir(home.path());
    let own = private_dir(home.path(), "own");
    let dir = key_dir(&managed, Some(&s(&own))).unwrap();
    let held = super::location::hold(&dir).unwrap();
    #[cfg(windows)]
    assert!(
        fs::rename(&own, home.path().join("away")).is_err(),
        "a held folder cannot move"
    );
    drop(held);
    fs::rename(&own, home.path().join("away")).unwrap();
    private_dir(home.path(), "own");
    let err = generate(&dir, "k", KeyType::Ed25519, "", None).unwrap_err();
    assert_eq!(
        (err.code(), err.to_string()),
        (
            "invalid_input",
            "The folder changed. Choose it again.".into()
        )
    );
    assert!(fs::read_dir(&own).unwrap().next().is_none());

    fs::remove_dir(&own).unwrap();
    if dir_link(&home.path().join("away"), &own) {
        let err = generate(&dir, "k", KeyType::Ed25519, "", None).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert!(
            fs::read_dir(home.path().join("away"))
                .unwrap()
                .next()
                .is_none()
        );
    }
}

#[test]
fn generates_into_a_custom_folder_without_touching_it() {
    let home = tempfile::tempdir().unwrap();
    let managed = keys_dir(home.path());
    let shared = shared_dir(home.path(), "shared");
    let dir = key_dir(&managed, Some(&s(&shared))).unwrap();
    assert!(!dir.managed);
    let g = generate(&dir, "id_work", KeyType::Ed25519, "c", None).unwrap();
    assert!(!g.managed);
    assert_eq!(g.path, canon(&shared.join("id_work")));
    assert!(is_owner_only(&fs::File::open(&g.path).unwrap()));
    assert!(shared.join("id_work.pub").is_file());
    assert!(!managed.exists(), "the managed dir is not created");
    assert!(
        fsutil::dir_open_to_others(&shared).unwrap(),
        "folder unchanged"
    );
    assert_eq!(
        code(generate(&dir, "id_work", KeyType::Ed25519, "", None)).0,
        "already_exists"
    );
    fs::remove_dir_all(&shared).unwrap();
    assert_eq!(
        code(generate(&dir, "again", KeyType::Ed25519, "", None)).0,
        "not_found"
    );
}

fn pair(dir: &Path, name: &str, seed: u8) -> (String, String) {
    let key = ed25519(seed);
    let path = dir.join(name);
    fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
    let public = key.public_key().to_openssh().unwrap();
    fs::write(dir.join(format!("{name}.pub")), format!("{public}\n")).unwrap();
    let fp = key
        .public_key()
        .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
        .to_string();
    (s(&path), fp)
}

#[test]
fn removes_a_pair_only_when_it_still_holds_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let (path, fp) = pair(dir.path(), "k", 1);
    let (_, other_fp) = pair(dir.path(), "other", 2);
    let refused = (
        "conflict",
        "The file at this path no longer holds this key. Nothing was deleted.".into(),
    );
    assert_eq!(code(remove_pair(&path, &other_fp, None)), refused);
    assert!(Path::new(&path).exists());

    fs::copy(dir.path().join("other.pub"), dir.path().join("k.pub")).unwrap();
    assert_eq!(code(remove_pair(&path, &fp, None)), refused, "swapped .pub");
    pair(dir.path(), "k", 1);
    fs::write(&path, b"not a key").unwrap();
    assert_eq!(code(remove_pair(&path, &fp, None)), refused, "garbage");

    let (path, fp) = pair(dir.path(), "k2", 3);
    fs::remove_file(&path).unwrap();
    remove_pair(&path, &fp, None).unwrap();
    assert!(!dir.path().join("k2.pub").exists());
    remove_pair(&path, &fp, None).unwrap();

    let (path, fp) = pair(dir.path(), "k3", 4);
    remove_pair(&path, &fp, None).unwrap();
    assert!(!Path::new(&path).exists() && !dir.path().join("k3.pub").exists());
    assert_eq!(
        code(remove_pair("relative/k", &fp, None)).0,
        "invalid_input"
    );
}

#[test]
fn a_link_in_place_of_the_key_is_not_this_key() {
    let dir = tempfile::tempdir().unwrap();
    let (target, fp) = pair(dir.path(), "real", 5);
    let link = dir.path().join("k");
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&target, &link).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&target, &link).is_ok();
    if linked {
        assert_eq!(code(remove_pair(&s(&link), &fp, None)).0, "conflict");
        assert!(Path::new(&target).exists());
    }
}

#[test]
fn picker_start_folders() {
    let home = tempfile::tempdir().unwrap();
    let keys = keys_dir(home.path());
    assert_eq!(folder_start(None, &keys), Some(canon(home.path())));
    fs::create_dir(&keys).unwrap();
    assert_eq!(folder_start(None, &keys), Some(canon(&keys)));
    let other = home.path().join("other");
    fs::create_dir(&other).unwrap();
    assert_eq!(folder_start(Some(&s(&other)), &keys), Some(canon(&other)));
    let file = other.join("f");
    fs::write(&file, b"").unwrap();
    for fallback in [
        s(&file),
        "${dir}".into(),
        "relative".into(),
        s(&home.path().join("gone")),
    ] {
        assert_eq!(
            folder_start(Some(&fallback), &keys),
            Some(canon(&keys)),
            "{fallback}"
        );
    }

    let user = home.path().join("user");
    fs::create_dir(&user).unwrap();
    assert_eq!(file_start(None, Some(&user)), Some(canon(&user)));
    fs::create_dir(user.join(".ssh")).unwrap();
    assert_eq!(
        file_start(None, Some(&user)),
        Some(canon(&user.join(".ssh")))
    );
    assert_eq!(
        file_start(Some(&s(&file)), Some(&user)),
        Some(canon(&other))
    );
    assert_eq!(
        file_start(Some(&s(&other.join("missing-key"))), Some(&user)),
        Some(canon(&other))
    );
    assert_eq!(
        file_start(Some(&s(&other)), Some(&user)),
        Some(canon(&other))
    );
    let template = format!("{}/${{name}}", s(&other));
    assert_eq!(
        file_start(Some(&template), Some(&user)),
        Some(canon(&user.join(".ssh")))
    );
    assert_eq!(
        file_start(Some(&s(&home.path().join("gone").join("k"))), Some(&user)),
        Some(canon(&user.join(".ssh")))
    );
    assert_eq!(file_start(None, None), None);
}

#[test]
fn picked_paths_are_absolute_without_the_verbatim_prefix() {
    #[cfg(windows)]
    assert_eq!(
        picked_path(PathBuf::from(r"\\?\C:\Users\me\.ssh\id")).unwrap(),
        r"C:\Users\me\.ssh\id"
    );
    #[cfg(unix)]
    assert_eq!(
        picked_path(PathBuf::from("/home/me/id")).unwrap(),
        "/home/me/id"
    );
    assert_eq!(
        picked_path(PathBuf::from("relative")).unwrap_err().code(),
        "invalid_input"
    );
}

/// One test for the global guard, so parallel tests never race on it.
#[tokio::test]
async fn one_picker_at_a_time_and_never_stuck() {
    let (first, cancelled) = PickerGuard::acquire().unwrap();
    assert!(PickerGuard::acquire().is_none());
    drop(first);
    drop(cancelled);

    // A cancelled wait (window destroyed) ends the command, which releases the guard.
    let (guard, cancelled) = PickerGuard::acquire().unwrap();
    let waiting = tokio::spawn(async move {
        let _guard = guard;
        let never = std::future::pending::<()>();
        tokio::select! {
            _ = never => false,
            _ = cancelled => true,
        }
    });
    tokio::task::yield_now().await;
    assert!(PickerGuard::acquire().is_none());
    cancel_picker();
    assert!(waiting.await.unwrap());
    let (guard, cancelled) = PickerGuard::acquire().unwrap();

    // A command future dropped mid-wait releases it too.
    let stuck = tokio::spawn(async move {
        let _guard = guard;
        let _ = cancelled.await;
        std::future::pending::<()>().await;
    });
    tokio::task::yield_now().await;
    assert!(PickerGuard::acquire().is_none());
    stuck.abort();
    let _ = stuck.await;
    assert!(PickerGuard::acquire().is_some());
    cancel_picker();
}
