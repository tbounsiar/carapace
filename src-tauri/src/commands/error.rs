use serde::Serialize;

use crate::config::ConfigError;
use crate::files::FsError;
use crate::secrets::SecretError;
use crate::ssh::SshError;
use crate::terminal::TerminalError;
use crate::vars::ResolveError;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<ConfigError> for CommandError {
    fn from(e: ConfigError) -> Self {
        let code = match e {
            ConfigError::NotFound(_) => "not_found",
            ConfigError::InvalidInput(_) => "invalid_input",
            ConfigError::Conflict(_) => "conflict",
            ConfigError::Io => "io",
            ConfigError::Corrupt => "corrupt_config",
        };
        Self::new(code, e.to_string())
    }
}

impl From<ResolveError> for CommandError {
    fn from(e: ResolveError) -> Self {
        let code = match e {
            ResolveError::Missing(_) => "missing_variables",
            ResolveError::Invalid(_) => "invalid_input",
        };
        Self::new(code, e.to_string())
    }
}

impl From<SshError> for CommandError {
    fn from(e: SshError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

impl From<TerminalError> for CommandError {
    fn from(e: TerminalError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

impl From<FsError> for CommandError {
    fn from(e: FsError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

impl From<SecretError> for CommandError {
    fn from(e: SecretError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_codes_and_serializes() {
        let cases = [
            (ConfigError::NotFound("project"), "not_found"),
            (ConfigError::InvalidInput("bad".into()), "invalid_input"),
            (ConfigError::Conflict("host"), "conflict"),
            (ConfigError::Io, "io"),
            (ConfigError::Corrupt, "corrupt_config"),
        ];
        for (err, code) in cases {
            assert_eq!(CommandError::from(err).code, code);
        }
        let json = serde_json::to_value(CommandError::from(ConfigError::Corrupt)).unwrap();
        assert_eq!(json["code"], "corrupt_config");
        assert!(json["message"].is_string());
    }

    #[test]
    fn maps_ssh_codes() {
        let cases = [
            (SshError::NotFound("host"), "not_found"),
            (SshError::InvalidInput("bad".into()), "invalid_input"),
            (SshError::HostKeyRejected, "host_key_rejected"),
            (SshError::HostKeyChanged, "host_key_changed"),
            (SshError::HostKeyRevoked, "host_key_revoked"),
            (SshError::AuthFailed("no".into()), "auth_failed"),
            (SshError::SecretRequired, "secret_required"),
            (SshError::InvalidPassphrase, "invalid_passphrase"),
            (SshError::KeychainUnavailable, "keychain_unavailable"),
            (SshError::Timeout, "timeout"),
            (SshError::Network, "network"),
            (SshError::Io, "io"),
        ];
        for (err, code) in cases {
            assert_eq!(CommandError::from(err).code, code);
        }
    }

    #[test]
    fn maps_terminal_codes() {
        let cases = [
            (TerminalError::NotFound, "not_found"),
            (TerminalError::NotConnected, "not_connected"),
            (TerminalError::InvalidInput("bad".into()), "invalid_input"),
            (TerminalError::Network, "network"),
            (TerminalError::Busy, "busy"),
        ];
        for (err, code) in cases {
            assert_eq!(CommandError::from(err).code, code);
        }
    }

    #[test]
    fn maps_file_codes() {
        let p = || "/p".to_string();
        let cases = [
            (FsError::NotConnected, "not_connected"),
            (FsError::NotFound(p()), "not_found"),
            (FsError::PermissionDenied(p()), "permission_denied"),
            (FsError::AlreadyExists(p()), "already_exists"),
            (FsError::NotEmpty(p()), "not_empty"),
            (FsError::TooLarge(p()), "too_large"),
            (FsError::InvalidInput("bad".into()), "invalid_input"),
            (FsError::Io(p()), "io"),
            (FsError::Network, "network"),
        ];
        for (err, code) in cases {
            assert_eq!(CommandError::from(err).code, code);
        }
    }

    #[test]
    fn maps_resolve_codes() {
        let missing = CommandError::from(ResolveError::Missing(vec!["a".into(), "b".into()]));
        assert_eq!(missing.code, "missing_variables");
        assert_eq!(missing.message, "missing variables: a, b");
        let invalid = CommandError::from(ResolveError::Invalid(vec!["x".into(), "y".into()]));
        assert_eq!(invalid.code, "invalid_input");
        assert_eq!(invalid.message, "x; y");
    }

    #[test]
    fn maps_secret_codes() {
        assert_eq!(
            CommandError::from(SecretError::Unavailable).code,
            "keychain_unavailable"
        );
        assert_eq!(
            CommandError::from(SecretError::TooLong).code,
            "invalid_input"
        );
        assert_eq!(
            CommandError::from(SshError::from(SecretError::Unavailable)).code,
            "keychain_unavailable"
        );
    }
}
