use crate::files::{FsError, MAX_PATH_BYTES};

/// Lexically normalized absolute POSIX path; `None` for `""` (the user's home).
pub fn normalize(raw: &str) -> Result<Option<String>, FsError> {
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > MAX_PATH_BYTES {
        return Err(FsError::invalid(crate::text!(
            "errors.files.pathTooLong",
            "path is too long"
        )));
    }
    if raw.contains('\0') {
        return Err(FsError::invalid(crate::text!(
            "errors.files.pathNul",
            "path must not contain NUL"
        )));
    }
    if !raw.starts_with('/') {
        return Err(FsError::invalid(crate::text!(
            "errors.files.pathRelative",
            "remote path must be absolute"
        )));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    Ok(Some(format!("/{}", parts.join("/"))))
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Parent of a normalized path; `None` for `/`.
pub fn parent(path: &str) -> Option<String> {
    if path == "/" {
        return None;
    }
    let idx = path.rfind('/')?;
    Some(if idx == 0 {
        "/".into()
    } else {
        path[..idx].into()
    })
}

/// Last component of a normalized path other than `/`.
pub fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lexically() {
        let cases = [
            ("/", "/"),
            ("//a///b/", "/a/b"),
            ("/a/./b/../c", "/a/c"),
            ("/../..", "/"),
            ("/a/..", "/"),
        ];
        for (raw, want) in cases {
            assert_eq!(normalize(raw).unwrap().as_deref(), Some(want), "{raw}");
        }
        assert_eq!(normalize("").unwrap(), None);
    }

    #[test]
    fn rejects_relative_nul_and_long_paths() {
        for bad in [
            "a/b".to_string(),
            "./a".into(),
            "~/a".into(),
            "/a\0b".into(),
            format!("/{}", "x".repeat(MAX_PATH_BYTES)),
        ] {
            assert_eq!(normalize(&bad).unwrap_err().code(), "invalid_input");
        }
    }

    #[test]
    fn joins_and_splits() {
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/a", "b"), "/a/b");
        assert_eq!(parent("/a/b").as_deref(), Some("/a"));
        assert_eq!(parent("/a").as_deref(), Some("/"));
        assert_eq!(parent("/"), None);
        assert_eq!(file_name("/a/b"), "b");
    }
}
