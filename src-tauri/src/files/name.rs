use super::FsError;

/// Checks a single path component for mkdir and rename (both sides).
pub fn name(raw: &str) -> Result<&str, FsError> {
    if raw.is_empty() || raw.len() > 255 {
        return Err(FsError::invalid("name must be 1 to 255 bytes"));
    }
    if raw == "." || raw == ".." {
        return Err(FsError::invalid("name must not be . or .."));
    }
    if raw.contains('/') {
        return Err(FsError::invalid("name must not contain /"));
    }
    if raw.chars().any(char::is_control) {
        return Err(FsError::invalid("name must not contain control characters"));
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_and_hidden_names() {
        for ok in ["a", ".profile", "with space", "été", &"x".repeat(255)] {
            assert_eq!(name(ok), Ok(ok));
        }
    }

    #[test]
    fn rejects_bad_names() {
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "/",
            "a\0b",
            "a\nb",
            "\u{7f}",
            &"x".repeat(256),
            &"é".repeat(128),
        ] {
            assert_eq!(name(bad).unwrap_err().code(), "invalid_input", "{bad:?}");
        }
    }
}
