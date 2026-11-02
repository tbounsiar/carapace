use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const HOME_ENV: &str = "CARAPACE_HOME";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum HomeError {
    #[error("CARAPACE_HOME must be an absolute path or start with ~/")]
    NotAbsolute,
    #[error("the user home directory could not be determined")]
    NoUserHome,
}

/// Resolves the app home: `$CARAPACE_HOME` when set and non-empty, `~/carapace` otherwise.
pub fn resolve_home() -> Result<PathBuf, HomeError> {
    resolve(std::env::var_os(HOME_ENV), std::env::home_dir())
}

fn resolve(var: Option<OsString>, user_home: Option<PathBuf>) -> Result<PathBuf, HomeError> {
    let Some(value) = var.filter(|v| !v.is_empty()) else {
        return user_home
            .map(|h| h.join("carapace"))
            .ok_or(HomeError::NoUserHome);
    };
    let value = PathBuf::from(value);
    let path = match strip_tilde(&value) {
        Some(rest) => user_home.ok_or(HomeError::NoUserHome)?.join(rest),
        None => value,
    };
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(HomeError::NotAbsolute)
    }
}

fn strip_tilde(path: &Path) -> Option<&Path> {
    let s = path.to_str()?;
    if s == "~" {
        return Some(Path::new(""));
    }
    s.strip_prefix("~/")
        .or_else(|| s.strip_prefix("~\\"))
        .map(Path::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_home() -> PathBuf {
        std::env::temp_dir().join("user")
    }

    #[test]
    fn defaults_to_carapace_in_user_home() {
        assert_eq!(
            resolve(None, Some(user_home())),
            Ok(user_home().join("carapace"))
        );
    }

    #[test]
    fn empty_variable_uses_default() {
        assert_eq!(
            resolve(Some(OsString::new()), Some(user_home())),
            Ok(user_home().join("carapace"))
        );
    }

    #[test]
    fn absolute_variable_is_used_as_is() {
        let custom = std::env::temp_dir().join("custom-home");
        assert_eq!(
            resolve(Some(custom.clone().into()), Some(user_home())),
            Ok(custom)
        );
    }

    #[test]
    fn tilde_is_expanded() {
        assert_eq!(
            resolve(Some("~/work/carapace".into()), Some(user_home())),
            Ok(user_home().join("work/carapace"))
        );
        assert_eq!(
            resolve(Some("~".into()), Some(user_home())),
            Ok(user_home().join(""))
        );
    }

    #[test]
    fn relative_variable_is_rejected() {
        assert_eq!(
            resolve(Some("carapace".into()), Some(user_home())),
            Err(HomeError::NotAbsolute)
        );
    }

    #[test]
    fn missing_user_home_is_an_error() {
        assert_eq!(resolve(None, None), Err(HomeError::NoUserHome));
        assert_eq!(
            resolve(Some("~/x".into()), None),
            Err(HomeError::NoUserHome)
        );
    }
}
