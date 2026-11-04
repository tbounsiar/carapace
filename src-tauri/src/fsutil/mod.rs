//! Local file helpers for files that must never be readable by other users.

mod pinned;
#[cfg(windows)]
mod windows;

pub use pinned::{DirHandle, DirId, FileId, file_id, open_dir, open_for_delete};

use std::fs::{self, File};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::localfs;

/// Bounded attempts at a free temp name, so a leftover from a crash never blocks a write.
const MAX_TEMPS: u32 = 16;

/// Creates a new file readable and writable by its owner only: mode 0o600 on Unix, a protected
/// DACL granting only the current user on Windows. Both apply at creation, before any byte is
/// written. An existing entry (a link included) fails with `AlreadyExists`, never followed.
pub fn create_owner_only(path: &Path) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
    }
    #[cfg(windows)]
    {
        windows::create_owner_only(path)
    }
}

/// Creates the directory owner-only (0o700 / protected owner-only DACL, inherited by its
/// children) if missing. An existing directory must be a real directory owned by the current
/// user; on Unix its mode is tightened to 0o700 if group or others have any access. Anything
/// else at the path, a link included, is an error.
pub fn ensure_dir_owner_only(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    };
    #[cfg(windows)]
    let created = windows::create_dir_owner_only(path);
    match created {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(path)?;
            if !meta.is_dir() || localfs::is_link(&meta) {
                return Err(io::Error::new(
                    ErrorKind::AlreadyExists,
                    "not a real directory",
                ));
            }
            check_existing_dir(path, &meta)
        }
        Err(e) => Err(e),
    }
}

fn not_ours() -> io::Error {
    io::Error::new(
        ErrorKind::PermissionDenied,
        "the directory belongs to another user",
    )
}

#[cfg(unix)]
fn check_existing_dir(path: &Path, meta: &fs::Metadata) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    // SAFETY: geteuid has no preconditions.
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(not_ours());
    }
    if meta.mode() & 0o077 != 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(windows)]
fn check_existing_dir(path: &Path, _meta: &fs::Metadata) -> io::Result<()> {
    if windows::owned_by_current_user(path)? {
        Ok(())
    } else {
        Err(not_ours())
    }
}

/// Reads a regular file of at most `max` bytes through a single handle: the type and size are
/// checked on that handle, so a FIFO or device never blocks the read and a file swapped in
/// after a check is never read. `follow: false` refuses a link at the last component.
/// Errors: `InvalidInput` (not a regular file, or a link when not following), `FileTooLarge`.
pub fn read_regular_capped(path: &Path, max: u64, follow: bool) -> io::Result<Zeroizing<Vec<u8>>> {
    let file = open_regular(path, follow)?;
    if file.metadata()?.len() > max {
        return Err(ErrorKind::FileTooLarge.into());
    }
    let mut data = Zeroizing::new(Vec::new());
    file.take(max + 1).read_to_end(&mut data)?;
    if data.len() as u64 > max {
        return Err(ErrorKind::FileTooLarge.into());
    }
    Ok(data)
}

/// Opens a regular file for reading; the type is checked on the handle. `follow: false`
/// refuses a link (or any reparse point on Windows) at the last component. Errors:
/// `InvalidInput` for anything that is not a regular file.
pub fn open_regular(path: &Path, follow: bool) -> io::Result<File> {
    open_regular_with(path, follow, false)
}

/// `open_regular` without following a link, and on Windows without letting anyone else write,
/// rename or delete the file while it is open (others may still read it).
pub fn open_regular_locked(path: &Path) -> io::Result<File> {
    open_regular_with(path, false, true)
}

fn open_regular_with(path: &Path, follow: bool, locked: bool) -> io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    if locked {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        options.share_mode(FILE_SHARE_READ);
    }
    #[cfg(not(windows))]
    let _ = locked;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let nofollow = if follow { 0 } else { libc::O_NOFOLLOW };
        options.custom_flags(libc::O_NONBLOCK | nofollow);
    }
    #[cfg(windows)]
    if !follow {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let not_regular = || io::Error::new(ErrorKind::InvalidInput, "not a regular file");
    let file = match options.open(path) {
        Ok(f) => f,
        // Windows refuses to open a directory as a file with "access denied".
        Err(_) if fs::metadata(path).is_ok_and(|m| m.is_dir()) => return Err(not_regular()),
        #[cfg(unix)]
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Err(not_regular()),
        Err(e) => return Err(e),
    };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.file_type().is_symlink() || (!follow && localfs::is_link(&meta)) {
        return Err(not_regular());
    }
    Ok(file)
}

/// Whether the file's DACL lets accounts other than the current user, SYSTEM and the
/// Administrators group read it (a null DACL counts as readable by everyone).
#[cfg(windows)]
pub fn readable_by_others(file: &File) -> io::Result<bool> {
    windows::readable_by_others(file)
}

/// Whether the directory itself (never a link's target) is owned by the current user.
pub fn dir_owned_by_me(dir: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        Ok(fs::symlink_metadata(dir)?.uid() == unsafe { libc::geteuid() })
    }
    #[cfg(windows)]
    {
        windows::owned_by_current_user(dir)
    }
}

/// Whether accounts other than the current user (and SYSTEM / Administrators on Windows) can
/// list, add or remove entries in the directory. The directory itself is inspected, never a
/// link's target.
pub fn dir_open_to_others(dir: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(fs::symlink_metadata(dir)?.permissions().mode() & 0o066 != 0)
    }
    #[cfg(windows)]
    {
        windows::dir_open_to_others(dir)
    }
}

/// Checks that an owner-only file can be created in `dir` by creating one under a temp name
/// (the names `write_new` uses) and removing it at once.
pub fn probe_writable(dir: &Path, name: &str) -> io::Result<()> {
    for n in 0..MAX_TEMPS {
        let temp = dir.join(temp_name(name, n));
        match create_owner_only(&temp) {
            Ok(file) => {
                drop(file);
                return fs::remove_file(&temp);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(ErrorKind::AlreadyExists.into())
}

fn temp_name(name: &str, n: u32) -> String {
    if n == 0 {
        format!(".{name}.carapace-part")
    } else {
        format!(".{name}.{n}.carapace-part")
    }
}

/// Writes `data` to `dir/name` atomically and without replacing anything: a temp sibling is
/// created exclusively (owner-only when asked), written, synced, then renamed with no-replace
/// onto `name` (`AlreadyExists` if taken). The temp is removed on failure.
pub fn write_new(dir: &Path, name: &str, data: &[u8], owner_only: bool) -> io::Result<PathBuf> {
    let target = dir.join(name);
    let (temp, mut file) = (0..MAX_TEMPS)
        .find_map(|n| {
            let temp = dir.join(temp_name(name, n));
            let opened = if owner_only {
                create_owner_only(&temp)
            } else {
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)
            };
            match opened {
                Err(e) if e.kind() == ErrorKind::AlreadyExists => None,
                other => Some(other.map(|f| (temp, f))),
            }
        })
        .unwrap_or_else(|| Err(ErrorKind::AlreadyExists.into()))?;
    let written = file
        .write_all(data)
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            drop(file);
            localfs::rename_no_replace(&temp, &target)
        });
    match written {
        Ok(()) => Ok(target),
        Err(e) => {
            let _ = fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// An absolute path that stays on this machine: on Windows it must start with a drive
/// (`C:\`, or its verbatim form), never a UNC or device prefix, because opening or even
/// canonicalizing `\\host\share` authenticates to that host with the user's credentials.
pub fn is_local_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let drive = matches!(
            path.components().next(),
            Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        );
        drive && path.is_absolute()
    }
    #[cfg(not(windows))]
    {
        path.is_absolute()
    }
}

/// What may follow `~/`: only plain components. A root, drive or UNC prefix would make
/// `join` replace the home directory (`~///host/share`, `~/C:/x`).
pub fn is_home_relative(rest: &str) -> bool {
    use std::path::Component;
    Path::new(rest).components().all(|c| {
        matches!(
            c,
            Component::Normal(_) | Component::CurDir | Component::ParentDir
        )
    })
}

/// Expands a leading `~/` (or `~\`) to the user's home directory. `None` unless the result is
/// a local absolute path (see `is_local_path`); callers refuse the input then.
pub fn expand_local(raw: &str) -> Option<PathBuf> {
    let path = match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        Some(rest) if is_home_relative(rest) => std::env::home_dir()?.join(rest),
        Some(_) => return None,
        None => PathBuf::from(raw),
    };
    is_local_path(&path).then_some(path)
}

/// `canonicalize` without the `\\?\` prefix Windows adds to drive paths.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    Ok(strip_verbatim(fs::canonicalize(path)?))
}

/// Drops the `\\?\` prefix of a verbatim drive path; any other path is returned as is.
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

/// Test inputs that must never reach the file system: they name another host, a device, a
/// pipe, or escape the home directory through `~/`.
#[cfg(all(test, windows))]
pub(crate) const NON_LOCAL: &[&str] = &[
    r"~///host/share",
    r"~/\\host\share",
    r"~/C:/x",
    r"~/\x",
    r"~\\\host\share",
    r"\\?\UNC\host\share",
    r"\\.\pipe\x",
    r"\\host\share\k",
    r"//host/share/k",
    r"/\host\share\k",
    r"\/host/share/k",
    "relative",
];
#[cfg(all(test, unix))]
pub(crate) const NON_LOCAL: &[&str] = &["~//etc/k", "~///host/share", "relative"];

#[cfg(all(test, windows))]
pub(crate) use windows::acl::is_owner_only;

/// Test helper: a directory with the given DACL (`%ME%` = the current user's SID).
#[cfg(all(test, windows))]
pub(crate) use windows::create_dir_with_sddl;

/// Whether the file is readable or writable by its owner only.
#[cfg(all(test, unix))]
pub(crate) fn is_owner_only(file: &File) -> bool {
    use std::os::unix::fs::PermissionsExt;
    file.metadata().unwrap().permissions().mode() & 0o777 == 0o600
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(path: &Path) -> File {
        File::open(path).unwrap()
    }

    #[test]
    fn owner_only_file_is_restricted_from_creation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        let mut f = create_owner_only(&path).unwrap();
        f.write_all(b"x").unwrap();
        drop(f);
        assert!(is_owner_only(&open(&path)));
        let err = create_owner_only(&path).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).unwrap(), b"x");
    }

    #[test]
    fn owner_only_dir_is_created_once_and_children_inherit_it() {
        let dir = tempfile::tempdir().unwrap();
        let keys = dir.path().join("keys");
        ensure_dir_owner_only(&keys).unwrap();
        ensure_dir_owner_only(&keys).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&keys).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        fs::write(dir.path().join("file"), b"").unwrap();
        assert!(ensure_dir_owner_only(&dir.path().join("file")).is_err());
        #[cfg(windows)]
        {
            let child = keys.join("plain");
            fs::write(&child, b"").unwrap();
            assert!(
                !is_owner_only(&open(&child)),
                "inherited ACEs are not owner-only"
            );
        }
    }

    #[test]
    fn write_new_is_atomic_and_never_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_new(dir.path(), "id", b"key", true).unwrap();
        assert_eq!(path, dir.path().join("id"));
        assert_eq!(fs::read(&path).unwrap(), b"key");
        assert!(is_owner_only(&open(&path)));
        let err = write_new(dir.path(), "id", b"other", true).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).unwrap(), b"key");
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec!["id"]);
    }

    #[test]
    fn write_new_skips_a_leftover_temp() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".id.carapace-part"), b"leftover").unwrap();
        write_new(dir.path(), "id.pub", b"pub", false).unwrap();
        write_new(dir.path(), "id", b"key", true).unwrap();
        assert_eq!(fs::read(dir.path().join("id")).unwrap(), b"key");
        assert_eq!(
            fs::read(dir.path().join(".id.carapace-part")).unwrap(),
            b"leftover"
        );
        assert!(!dir.path().join(".id.1.carapace-part").exists());
    }

    #[test]
    fn bounded_read_checks_the_handle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        fs::write(&path, b"12345").unwrap();
        assert_eq!(&**read_regular_capped(&path, 5, false).unwrap(), b"12345");
        let err = read_regular_capped(&path, 4, false).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::FileTooLarge);
        let err = read_regular_capped(dir.path(), 5, true).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        let link = dir.path().join("link");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&path, &link).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&path, &link).is_ok();
        if linked {
            let err = read_regular_capped(&link, 5, false).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidInput);
            assert_eq!(&**read_regular_capped(&link, 5, true).unwrap(), b"12345");
        }
    }

    #[cfg(unix)]
    #[test]
    fn bounded_read_never_blocks_on_a_fifo() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let err = read_regular_capped(&fifo, 5, false).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_dir_is_tightened() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let keys = dir.path().join("keys");
        fs::create_dir(&keys).unwrap();
        fs::set_permissions(&keys, fs::Permissions::from_mode(0o755)).unwrap();
        ensure_dir_owner_only(&keys).unwrap();
        assert_eq!(
            fs::metadata(&keys).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[cfg(windows)]
    #[test]
    fn readable_by_others_reads_the_dacl() {
        let dir = tempfile::tempdir().unwrap();
        let own = dir.path().join("own");
        drop(create_owner_only(&own).unwrap());
        assert!(!readable_by_others(&File::open(&own).unwrap()).unwrap());
        let shared = dir.path().join("shared");
        drop(windows::create_with_sddl(&shared, "D:P(A;;FR;;;WD)(A;;FA;;;%ME%)").unwrap());
        assert!(readable_by_others(&File::open(&shared).unwrap()).unwrap());
        let open = dir.path().join("null");
        drop(windows::create_with_sddl(&open, "D:NO_ACCESS_CONTROL").unwrap());
        assert!(readable_by_others(&File::open(&open).unwrap()).unwrap());
        assert!(windows::owned_by_current_user(dir.path()).unwrap());
    }

    #[test]
    fn non_local_paths_never_expand() {
        for raw in NON_LOCAL {
            assert_eq!(expand_local(raw), None, "{raw}");
        }
        #[cfg(windows)]
        {
            assert!(is_local_path(Path::new(r"C:\x")));
            assert!(is_local_path(Path::new(r"\\?\C:\x")));
            assert!(!is_local_path(Path::new(r"\\?\UNC\h\s")));
            assert!(!is_local_path(Path::new(r"C:x")));
        }
    }

    #[test]
    fn probe_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".id.carapace-part"), b"leftover").unwrap();
        probe_writable(dir.path(), "id").unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![".id.carapace-part"]);
    }

    #[test]
    fn dir_exposure_follows_the_acl() {
        let dir = tempfile::tempdir().unwrap();
        let own = dir.path().join("own");
        ensure_dir_owner_only(&own).unwrap();
        assert!(!dir_open_to_others(&own).unwrap());
        let shared = dir.path().join("shared");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::create_dir(&shared).unwrap();
            fs::set_permissions(&shared, fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        create_dir_with_sddl(&shared, "D:P(A;OICI;FR;;;WD)(A;OICI;FA;;;%ME%)").unwrap();
        assert!(dir_open_to_others(&shared).unwrap());
        #[cfg(windows)]
        {
            let inherit_only = dir.path().join("inherit-only");
            create_dir_with_sddl(&inherit_only, "D:P(A;OICIIO;FA;;;WD)(A;OICI;FA;;;%ME%)").unwrap();
            assert!(!dir_open_to_others(&inherit_only).unwrap());
        }
    }

    #[test]
    fn canonical_strips_the_verbatim_prefix() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\k")),
            PathBuf::from(r"C:\k")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\s\k")),
            PathBuf::from(r"\\?\UNC\s\k")
        );
        let dir = tempfile::tempdir().unwrap();
        let c = canonical(dir.path()).unwrap();
        assert!(!c.to_string_lossy().starts_with(r"\\?\"));
        assert!(c.is_absolute());
        if let Some(home) = std::env::home_dir() {
            assert_eq!(expand_local("~/x"), Some(home.join("x")));
            assert_eq!(expand_local("~/a/../b"), Some(home.join("a/../b")));
        }
    }
}
