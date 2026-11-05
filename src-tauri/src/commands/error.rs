use serde::Serialize;

use crate::config::ConfigError;
use crate::files::FsError;
use crate::keys::KeyError;
use crate::secrets::SecretError;
use crate::ssh::SshError;
use crate::terminal::TerminalError;
use crate::text::{Localized, Text};
use crate::vars::ResolveError;

/// `{ code, message, key?, params? }`: `code` is the category the interface reacts to, `key` and
/// `params` its translated text, `message` the English text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<&'static str>,
    #[serde(skip_serializing_if = "serde_json::Map::is_empty")]
    pub params: serde_json::Map<String, serde_json::Value>,
}

impl CommandError {
    pub fn new(code: &'static str, text: impl Into<Text>) -> Self {
        let text = text.into();
        Self {
            code,
            message: text.message,
            key: text.key,
            params: text.params,
        }
    }

    fn localized(code: &'static str, e: &impl Localized) -> Self {
        Self::new(code, e.text())
    }
}

impl From<ConfigError> for CommandError {
    fn from(e: ConfigError) -> Self {
        let code = match e {
            ConfigError::NotFound(_) => "not_found",
            ConfigError::InvalidInput(_) => "invalid_input",
            ConfigError::Conflict(_) | ConfigError::NameTaken(_) | ConfigError::Changed => {
                "conflict"
            }
            ConfigError::Exists(_) => "already_exists",
            ConfigError::Io => "io",
            ConfigError::Corrupt => "corrupt_config",
            ConfigError::Keychain => "keychain_unavailable",
        };
        Self::localized(code, &e)
    }
}

impl From<ResolveError> for CommandError {
    fn from(e: ResolveError) -> Self {
        let code = match e {
            ResolveError::Missing(_) => "missing_variables",
            ResolveError::Invalid(_) => "invalid_input",
        };
        Self::localized(code, &e)
    }
}

impl From<SshError> for CommandError {
    fn from(e: SshError) -> Self {
        Self::localized(e.code(), &e)
    }
}

impl From<TerminalError> for CommandError {
    fn from(e: TerminalError) -> Self {
        Self::localized(e.code(), &e)
    }
}

impl From<FsError> for CommandError {
    fn from(e: FsError) -> Self {
        Self::localized(e.code(), &e)
    }
}

impl From<KeyError> for CommandError {
    fn from(e: KeyError) -> Self {
        Self::localized(e.code(), &e)
    }
}

impl From<SecretError> for CommandError {
    fn from(e: SecretError) -> Self {
        Self::localized(e.code(), &e)
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
            (ConfigError::NameTaken("x".into()), "conflict"),
            (ConfigError::Changed, "conflict"),
            (ConfigError::Exists("key"), "already_exists"),
            (ConfigError::Io, "io"),
            (ConfigError::Corrupt, "corrupt_config"),
            (ConfigError::Keychain, "keychain_unavailable"),
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
            (SshError::HostChanged, "not_found"),
            (SshError::InvalidInput("bad".into()), "invalid_input"),
            (SshError::HostKeyRejected, "host_key_rejected"),
            (SshError::HostKeyChanged, "host_key_changed"),
            (SshError::HostKeyRevoked, "host_key_revoked"),
            (SshError::AuthFailed("no".into()), "auth_failed"),
            (SshError::SecretRequired, "secret_required"),
            (SshError::InvalidPassphrase, "invalid_passphrase"),
            (
                SshError::PassphraseRefused("no".into()),
                "invalid_passphrase",
            ),
            (SshError::Cancelled, "cancelled"),
            (SshError::Busy, "busy"),
            (SshError::KeychainUnavailable, "keychain_unavailable"),
            (SshError::Timeout, "timeout"),
            (SshError::Network, "network"),
            (SshError::Io, "io"),
            (
                SshError::UserKnownHostsUnreadable(std::io::ErrorKind::PermissionDenied),
                "io",
            ),
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
    fn maps_key_codes() {
        let cases = [
            (KeyError::invalid("bad"), "invalid_input"),
            (KeyError::AlreadyExists("/k".into()), "already_exists"),
            (KeyError::NotFound("/k".into()), "not_found"),
            (KeyError::InvalidPassphrase, "invalid_passphrase"),
            (KeyError::TooLarge("/k".into()), "too_large"),
            (KeyError::PermissionDenied("/k".into()), "permission_denied"),
            (KeyError::Io("/k".into()), "io"),
            (KeyError::Fs(FsError::NotConnected), "not_connected"),
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
