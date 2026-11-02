use std::path::{Component, Path, PathBuf};

use crate::config::is_local_absolute;
use crate::files::{self, FsError, MAX_PATH_BYTES};

/// Lexically normalized absolute local path; `None` for `""` (the list of roots).
pub fn resolve(raw: &str) -> Result<Option<PathBuf>, FsError> {
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > MAX_PATH_BYTES {
        return Err(FsError::invalid("path is too long"));
    }
    if raw.chars().any(char::is_control) {
        return Err(FsError::invalid("path must not contain control characters"));
    }
    // Also rejects UNC, verbatim (`\\?\`) and device (`\\.\`) paths.
    if !is_local_absolute(raw) {
        return Err(FsError::invalid("local path must be absolute"));
    }
    let mut out = PathBuf::new();
    for c in Path::new(raw).components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            Component::Normal(part) => {
                if cfg!(windows) {
                    windows_component(part.to_str().unwrap_or_default())?;
                }
                out.push(part);
            }
            other => out.push(other.as_os_str()),
        }
    }
    Ok(Some(out))
}

/// Path as the frontend sees it: UTF-8, without the `\\?\` prefix `canonicalize` adds on Windows.
pub fn display(path: &Path) -> Result<String, FsError> {
    let s = path
        .to_str()
        .ok_or_else(|| FsError::invalid("path is not valid Unicode"))?;
    let s = match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest,
        _ => s,
    };
    if !is_local_absolute(s) {
        return Err(FsError::invalid(format!("{s} is not a local path")));
    }
    Ok(s.to_owned())
}

/// Rules every Windows path component follows, so no path reaches a device or a stream.
fn windows_component(raw: &str) -> Result<(), FsError> {
    // `:` would address an alternate data stream instead of a file.
    if raw.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return Err(FsError::invalid("name must not contain < > : \" | ? or *"));
    }
    let stem = raw
        .split('.')
        .next()
        .unwrap_or(raw)
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(FsError::invalid(format!("{raw} is a reserved name")));
    }
    Ok(())
}

/// `files::name` plus the separators and reserved names of the local platform.
pub fn name(raw: &str) -> Result<&str, FsError> {
    files::name(raw)?;
    if raw.contains('\\') {
        return Err(FsError::invalid("name must not contain \\"));
    }
    if cfg!(windows) {
        windows_component(raw)?;
        if raw.ends_with(['.', ' ']) {
            return Err(FsError::invalid("name must not end with a dot or a space"));
        }
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn resolves_windows_paths() {
        let r = |s: &str| resolve(s).unwrap().unwrap();
        assert_eq!(r(r"C:\a\.\b\..\c"), PathBuf::from(r"C:\a\c"));
        assert_eq!(r(r"C:\..\.."), PathBuf::from(r"C:\"));
        assert_eq!(r("C:/a//b"), PathBuf::from(r"C:\a\b"));
        for bad in [
            r"\\server\share\x",
            r"\\?\C:\x",
            r"\\.\COM1",
            r"//server/share",
            r"\a",
            "C:a",
            "a\\b",
            "C:\\a\nb",
            r"C:\x\f.txt:stream",
            r"C:\x\CON",
            r"C:\x\nul.txt\y",
            r"C:\x\a?b",
        ] {
            assert_eq!(resolve(bad).unwrap_err().code(), "invalid_input", "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolves_unix_paths() {
        let r = |s: &str| resolve(s).unwrap().unwrap();
        assert_eq!(r("/a/./b/../c"), PathBuf::from("/a/c"));
        assert_eq!(r("/../.."), PathBuf::from("/"));
        for bad in ["a/b", "//server/share", r"\\server\share", "/a\0b"] {
            assert_eq!(resolve(bad).unwrap_err().code(), "invalid_input", "{bad}");
        }
    }

    #[test]
    fn empty_means_roots_and_long_is_rejected() {
        assert_eq!(resolve("").unwrap(), None);
        let long = format!("/{}", "x".repeat(MAX_PATH_BYTES));
        assert_eq!(resolve(&long).unwrap_err().code(), "invalid_input");
    }

    #[cfg(windows)]
    #[test]
    fn strips_verbatim_drive_prefix_only() {
        assert_eq!(display(Path::new(r"\\?\C:\Users")).unwrap(), r"C:\Users");
        assert_eq!(display(Path::new(r"C:\Users")).unwrap(), r"C:\Users");
        assert!(display(Path::new(r"\\?\UNC\server\share")).is_err());
    }

    #[test]
    fn rejects_local_name_specials() {
        assert_eq!(name("a\\b").unwrap_err().code(), "invalid_input");
        assert!(name("notes.txt").is_ok());
        if cfg!(windows) {
            for bad in [
                "a:b", "a?", "x.", "x ", "CON", "con.txt", "COM1", "lpt9.log",
            ] {
                assert_eq!(name(bad).unwrap_err().code(), "invalid_input", "{bad}");
            }
            assert!(name("COM10").is_ok());
            assert!(name("console").is_ok());
        }
    }
}
