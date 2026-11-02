use std::path::{Component, Path, Prefix};

use super::model::{AuthMethod, HostInput};
use super::store::ConfigError;

fn invalid(msg: &str) -> ConfigError {
    ConfigError::InvalidInput(msg.to_string())
}

pub(super) fn name(raw: &str) -> Result<String, ConfigError> {
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if !(1..=100).contains(&len) {
        return Err(invalid("name must be 1 to 100 characters"));
    }
    Ok(trimmed.to_string())
}

fn token(value: &str, max: usize, label: &str) -> Result<String, ConfigError> {
    let len = value.chars().count();
    if len == 0 || len > max {
        return Err(ConfigError::InvalidInput(format!(
            "{label} must be 1 to {max} characters"
        )));
    }
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ConfigError::InvalidInput(format!(
            "{label} must not contain whitespace or control characters"
        )));
    }
    Ok(value.to_string())
}

fn is_local_absolute(path: &str) -> bool {
    if path.starts_with("\\") || path.starts_with("//") {
        return false;
    }
    let p = Path::new(path);
    if let Some(Component::Prefix(prefix)) = p.components().next()
        && !matches!(prefix.kind(), Prefix::Disk(_))
    {
        return false;
    }
    p.is_absolute()
}

pub(super) struct ValidHost {
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
}

pub(super) fn host(input: &HostInput) -> Result<ValidHost, ConfigError> {
    let name = name(&input.name)?;
    let hostname = token(&input.hostname, 253, "hostname")?;
    if !hostname
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        return Err(invalid(
            "hostname may only contain letters, digits, '.', '-' and ':'",
        ));
    }
    let port = u16::try_from(input.port)
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| invalid("port must be between 1 and 65535"))?;
    let username = token(&input.username, 64, "username")?;
    if let AuthMethod::Key { key_path } = &input.auth {
        if key_path.chars().count() > 4096 || key_path.chars().any(char::is_control) {
            return Err(invalid("key path is invalid"));
        }
        if !key_path.starts_with("~/") && !is_local_absolute(key_path) {
            return Err(invalid("key path must be absolute or start with ~/"));
        }
    }
    Ok(ValidHost {
        name,
        hostname,
        port,
        username,
        auth: input.auth.clone(),
    })
}
