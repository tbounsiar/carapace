use serde::Serialize;

use crate::config::ConfigError;
use crate::secrets::SecretError;
use crate::ssh::SshError;

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

impl From<SshError> for CommandError {
    fn from(e: SshError) -> Self {
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
