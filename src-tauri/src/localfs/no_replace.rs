use std::io;
use std::path::Path;

/// Renames `from` to `to`, failing with `AlreadyExists` instead of replacing an existing `to`,
/// atomically where the OS offers it.
#[cfg(windows)]
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain([0]).collect() };
    let (from, to) = (wide(from), wide(to));
    // No MOVEFILE_REPLACE_EXISTING (and no copy fallback): an existing target fails the call.
    // SAFETY: both buffers are NUL-terminated UTF-16 that outlive the call.
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn c_path(p: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(p.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

#[cfg(target_os = "linux")]
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let (f, t) = (c_path(from)?, c_path(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    let rc = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            f.as_ptr(),
            libc::AT_FDCWD,
            t.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        // Kernel or filesystem without RENAME_NOREPLACE.
        Some(libc::EINVAL) | Some(libc::ENOSYS) => check_then_rename(from, to),
        _ => Err(err),
    }
}

#[cfg(target_os = "macos")]
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let (f, t) = (c_path(from)?, c_path(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    let rc = unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ENOTSUP) | Some(libc::EINVAL) => check_then_rename(from, to),
        _ => Err(err),
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    check_then_rename(from, to)
}

/// Fallback with a race window between the check and the rename.
#[cfg(unix)]
fn check_then_rename(from: &Path, to: &Path) -> io::Result<()> {
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    std::fs::rename(from, to)
}
