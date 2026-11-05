use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use zeroize::Zeroizing;

use super::Stamp;
use crate::fsutil;

pub const DIR: &str = "backups";
const KEEP: usize = 10;
const SUFFIX: &str = "-before-import.json";
/// Bounded attempts at a free name within one second.
const MAX_NAMES: u32 = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backup {
    pub name: String,
    pub path: PathBuf,
}

fn name_of(stamp: &str, n: u32) -> String {
    if n == 0 {
        format!("data-{stamp}{SUFFIX}")
    } else {
        format!("data-{stamp}-{}{SUFFIX}", n + 1)
    }
}

/// Copies the bytes of `data.json` into `$CARAPACE_HOME/backups` (owner-only directory and
/// file, never replacing a backup), then keeps the most recent ones only.
pub fn write(home: &Path, raw: &[u8], now: SystemTime) -> io::Result<Backup> {
    fs::create_dir_all(home)?;
    let dir = home.join(DIR);
    fsutil::ensure_dir_owner_only(&dir)?;
    let stamp = Stamp::of(now).compact();
    let mut last = io::Error::from(io::ErrorKind::AlreadyExists);
    for n in 0..MAX_NAMES {
        let name = name_of(&stamp, n);
        match fsutil::write_new(&dir, &name, raw, true) {
            Ok(path) => {
                rotate(&dir, &name);
                return Ok(Backup { name, path });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

/// Best effort: a failure keeps more backups than needed, never fewer.
fn rotate(dir: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut found: Vec<(SystemTime, String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let meta = e.metadata().ok()?;
            (name.starts_with("data-") && name.ends_with(SUFFIX) && meta.is_file()).then(|| {
                let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                (at, name, e.path())
            })
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let mut kept = 1;
    for (_, name, path) in found {
        if name == keep {
            continue;
        }
        if kept < KEEP {
            kept += 1;
            continue;
        }
        if fs::remove_file(&path).is_err() {
            log::warn!("could not delete an old data backup");
        }
    }
}

/// A backup taken by `write`, bounded like `data.json`.
pub fn read(path: &Path) -> io::Result<Zeroizing<Vec<u8>>> {
    fsutil::read_regular_capped(path, super::format::MAX_FILE_BYTES, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn backups_are_owner_only_never_replaced_and_rotated() {
        let home = tempfile::tempdir().unwrap();
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_873_520);
        let a = write(home.path(), b"one", t).unwrap();
        let b = write(home.path(), b"two", t).unwrap();
        assert_eq!(a.name, "data-20261105-101200-before-import.json");
        assert_eq!(b.name, "data-20261105-101200-2-before-import.json");
        assert_eq!(&*read(&a.path).unwrap(), b"one");
        assert!(fsutil::is_owner_only(&fs::File::open(&b.path).unwrap()));
        for i in 0..12u64 {
            std::thread::sleep(Duration::from_millis(15));
            write(home.path(), b"x", t + Duration::from_secs(i + 1)).unwrap();
        }
        let left: Vec<_> = fs::read_dir(home.path().join(DIR)).unwrap().collect();
        assert_eq!(left.len(), KEEP);
        assert!(!a.path.exists());
    }

    #[test]
    fn a_backup_failure_is_reported() {
        let home = tempfile::tempdir().unwrap();
        fs::write(home.path().join(DIR), b"not a dir").unwrap();
        assert!(write(home.path(), b"x", SystemTime::now()).is_err());
    }
}
