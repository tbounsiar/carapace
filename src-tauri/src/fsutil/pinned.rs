//! Operations bound to an open handle rather than a path, so a link or junction swapped into
//! the path between a check and the action cannot redirect the action.

use std::fs::File;
use std::io::{self, ErrorKind, Read};
use std::path::Path;

use zeroize::Zeroizing;

fn not_regular() -> io::Error {
    io::Error::new(ErrorKind::InvalidInput, "not a regular file")
}

fn read_capped(file: &File, max: u64) -> io::Result<Zeroizing<Vec<u8>>> {
    let meta = file.metadata()?;
    if !meta.is_file() || crate::localfs::is_link(&meta) {
        return Err(not_regular());
    }
    if meta.len() > max {
        return Err(ErrorKind::FileTooLarge.into());
    }
    let mut data = Zeroizing::new(Vec::new());
    file.take(max + 1).read_to_end(&mut data)?;
    if data.len() as u64 > max {
        return Err(ErrorKind::FileTooLarge.into());
    }
    Ok(data)
}

/// A file opened for deletion. Its content was read from the same handle, so what gets
/// deleted is exactly what the caller checked.
pub struct Doomed {
    file: File,
    #[cfg(unix)]
    dir: File,
    #[cfg(unix)]
    name: std::ffi::CString,
}

/// Opens `path` to delete it later, without following a link at the last component, and reads
/// at most `max` bytes. `None` when it is missing. Errors: `InvalidInput` (link, not a regular
/// file), `FileTooLarge`. On Windows other processes cannot rename, delete or write it while
/// open.
pub fn open_for_delete(path: &Path, max: u64) -> io::Result<Option<(Doomed, Zeroizing<Vec<u8>>)>> {
    let opened = imp::open_for_delete(path);
    let doomed = match opened {
        Ok(d) => d,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let data = read_capped(&doomed.file, max)?;
    Ok(Some((doomed, data)))
}

impl Doomed {
    pub fn delete(self) -> io::Result<()> {
        imp::delete(self)
    }
}

/// Identity of a directory (volume + file id on Windows, device + inode on Unix).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirId(u64, u64);

/// An open handle on a directory. On Windows it is opened without delete sharing, so the
/// directory cannot be renamed or removed while held.
#[derive(Debug)]
pub struct DirHandle {
    _file: File,
    pub id: DirId,
}

/// Opens the directory itself (a link or junction at `path` is `InvalidInput`).
pub fn open_dir(path: &Path) -> io::Result<DirHandle> {
    imp::open_dir(path)
}

#[cfg(windows)]
mod imp {
    use std::fs::{File, OpenOptions};
    use std::io::{self, ErrorKind};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, FileDispositionInfo,
        GetFileInformationByHandle, SetFileInformationByHandle,
    };

    use super::{DirHandle, DirId, Doomed, not_regular};

    const DELETE: u32 = 0x0001_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_READ_DATA: u32 = 0x1;
    const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    fn info(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
        // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is valid (plain integers).
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the handle is open and `info` is writable.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info)
    }

    pub(super) fn open_for_delete(path: &Path) -> io::Result<Doomed> {
        // Without FILE_SHARE_DELETE / FILE_SHARE_WRITE nobody can rename, replace or change
        // the file between the check and the deletion.
        let opened = OpenOptions::new()
            .access_mode(DELETE | FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path);
        match opened {
            Ok(file) => Ok(Doomed { file }),
            // Windows refuses to open a directory as a file with "access denied".
            Err(_) if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) => {
                Err(not_regular())
            }
            Err(e) => Err(e),
        }
    }

    pub(super) fn delete(doomed: Doomed) -> io::Result<()> {
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: the handle is open with DELETE access; the buffer is a FILE_DISPOSITION_INFO
        // of the size given.
        let ok = unsafe {
            SetFileInformationByHandle(
                doomed.file.as_raw_handle(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // The file goes away when the last handle (this one) closes.
        drop(doomed);
        Ok(())
    }

    pub(super) fn open_dir(path: &Path) -> io::Result<DirHandle> {
        // A handle without a data right (list here) takes no part in sharing checks, and
        // would not keep the directory from being renamed.
        let file = OpenOptions::new()
            .access_mode(FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let info = info(&file)?;
        let attrs = info.dwFileAttributes;
        if attrs & FILE_ATTRIBUTE_DIRECTORY == 0 || attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "not a real directory",
            ));
        }
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        Ok(DirHandle {
            id: DirId(u64::from(info.dwVolumeSerialNumber), index),
            _file: file,
        })
    }
}

#[cfg(unix)]
mod imp {
    use std::ffi::CString;
    use std::fs::{File, OpenOptions};
    use std::io::{self, ErrorKind};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Path;

    use super::{DirHandle, DirId, Doomed, not_regular};

    fn dir_fd(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|e| match e.raw_os_error() {
                Some(libc::ELOOP) | Some(libc::ENOTDIR) => {
                    io::Error::new(ErrorKind::InvalidInput, "not a real directory")
                }
                _ => e,
            })
    }

    pub(super) fn open_for_delete(path: &Path) -> io::Result<Doomed> {
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Err(not_regular());
        };
        let dir = dir_fd(parent)?;
        let name = CString::new(name.as_bytes()).map_err(|_| not_regular())?;
        // SAFETY: a valid directory fd and a NUL-terminated name.
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let e = io::Error::last_os_error();
            return Err(match e.raw_os_error() {
                Some(libc::ELOOP) => not_regular(),
                _ => e,
            });
        }
        // SAFETY: a fresh fd that nothing else owns.
        let file = unsafe { File::from_raw_fd(fd) };
        Ok(Doomed { file, dir, name })
    }

    /// Unlinks the name only if it still refers to the opened file. A swap between this check
    /// and `unlinkat` remains possible for someone who can write the directory.
    pub(super) fn delete(doomed: Doomed) -> io::Result<()> {
        let opened = doomed.file.metadata()?;
        // SAFETY: an all-zero stat is valid (plain integers).
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: valid fd, NUL-terminated name, writable `st`.
        let r = unsafe {
            libc::fstatat(
                doomed.dir.as_raw_fd(),
                doomed.name.as_ptr(),
                &mut st,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if r != 0 {
            return Err(io::Error::last_os_error());
        }
        if st.st_dev as u64 != opened.dev() || st.st_ino as u64 != opened.ino() {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "the file was replaced",
            ));
        }
        // SAFETY: valid fd and NUL-terminated name.
        if unsafe { libc::unlinkat(doomed.dir.as_raw_fd(), doomed.name.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn open_dir(path: &Path) -> io::Result<DirHandle> {
        let file = dir_fd(path)?;
        let meta = file.metadata()?;
        Ok(DirHandle {
            id: DirId(meta.dev(), meta.ino()),
            _file: file,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn deletes_exactly_the_opened_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("k");
        fs::write(&path, b"key").unwrap();
        let (doomed, data) = open_for_delete(&path, 16).unwrap().unwrap();
        assert_eq!(&**data, b"key");
        #[cfg(windows)]
        {
            assert!(fs::rename(&path, dir.path().join("moved")).is_err());
            assert!(fs::write(&path, b"other").is_err());
        }
        doomed.delete().unwrap();
        assert!(!path.exists());
        assert!(open_for_delete(&path, 16).unwrap().is_none());
        fs::write(&path, b"12345").unwrap();
        let err = open_for_delete(&path, 4).err().unwrap();
        assert_eq!(err.kind(), ErrorKind::FileTooLarge);
        let err = open_for_delete(dir.path(), 4).err().unwrap();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn a_link_is_never_opened_for_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("t");
        fs::write(&target, b"key").unwrap();
        let link = dir.path().join("l");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &link).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &link).is_ok();
        if linked {
            let err = open_for_delete(&link, 16).err().unwrap();
            assert_eq!(err.kind(), ErrorKind::InvalidInput);
            assert!(target.exists());
        }
    }

    #[test]
    fn a_held_directory_keeps_its_identity() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("d");
        fs::create_dir(&dir).unwrap();
        let held = open_dir(&dir).unwrap();
        assert_eq!(open_dir(&dir).unwrap().id, held.id);
        #[cfg(windows)]
        assert!(fs::rename(&dir, root.path().join("moved")).is_err());
        let other = root.path().join("o");
        fs::create_dir(&other).unwrap();
        assert_ne!(open_dir(&other).unwrap().id, held.id);
        let file = root.path().join("f");
        fs::write(&file, b"").unwrap();
        assert_eq!(open_dir(&file).unwrap_err().kind(), ErrorKind::InvalidInput);
        drop(held);
        fs::rename(&dir, root.path().join("moved")).unwrap();
    }
}
