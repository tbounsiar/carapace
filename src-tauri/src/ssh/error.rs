use thiserror::Error;

use crate::secrets::SecretError;
use crate::text::{Localized, Text};

#[derive(Debug, Error, PartialEq)]
pub enum SshError {
    #[error("{0} not found")]
    NotFound(&'static str),
    /// The host was edited, moved or deleted while the connection was being made.
    #[error("the host changed while connecting; connect again")]
    HostChanged,
    #[error("{0}")]
    InvalidInput(Text),
    #[error("the host key was not accepted")]
    HostKeyRejected,
    #[error("the host key has changed")]
    HostKeyChanged,
    #[error("the host key has been revoked")]
    HostKeyRevoked,
    #[error("{0}")]
    AuthFailed(Text),
    #[error("a password or passphrase is required")]
    SecretRequired,
    #[error("the passphrase does not unlock the private key")]
    InvalidPassphrase,
    /// A stored passphrase that does not unlock the key, with where it came from.
    #[error("{0}")]
    PassphraseRefused(Text),
    #[error("the test was cancelled")]
    Cancelled,
    #[error("too many connection tests are running")]
    Busy,
    #[error("the system keychain is not available")]
    KeychainUnavailable,
    #[error("the connection timed out")]
    Timeout,
    #[error("could not reach the host or the connection was lost")]
    Network,
    #[error("could not read or write a local file")]
    Io,
    #[error(
        "Could not read ~/.ssh/known_hosts to verify the host key: {0}. Fix or move that file, then retry."
    )]
    UserKnownHostsUnreadable(std::io::ErrorKind),
}

impl SshError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) | Self::HostChanged => "not_found",
            Self::InvalidInput(_) => "invalid_input",
            Self::HostKeyRejected => "host_key_rejected",
            Self::HostKeyChanged => "host_key_changed",
            Self::HostKeyRevoked => "host_key_revoked",
            Self::AuthFailed(_) => "auth_failed",
            Self::SecretRequired => "secret_required",
            Self::InvalidPassphrase | Self::PassphraseRefused(_) => "invalid_passphrase",
            Self::Cancelled => "cancelled",
            Self::Busy => "busy",
            Self::KeychainUnavailable => "keychain_unavailable",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Io | Self::UserKnownHostsUnreadable(_) => "io",
        }
    }
}

/// Stable code of why a file could not be read, for the translated text.
pub fn io_kind(kind: std::io::ErrorKind) -> &'static str {
    use std::io::ErrorKind;
    match kind {
        ErrorKind::PermissionDenied => "permission_denied",
        ErrorKind::IsADirectory => "is_a_directory",
        ErrorKind::InvalidData => "invalid_data",
        _ => "other",
    }
}

impl From<SecretError> for SshError {
    fn from(e: SecretError) -> Self {
        match e {
            SecretError::Unavailable => Self::KeychainUnavailable,
            SecretError::TooLong | SecretError::InvalidScope => Self::InvalidInput(e.text()),
        }
    }
}

impl Localized for SshError {
    fn text(&self) -> Text {
        match self {
            Self::NotFound("host key") => {
                crate::text!("errors.ssh.hostKeyNotFound", "host key not found")
            }
            Self::NotFound("host key request") => crate::text!(
                "errors.ssh.hostKeyRequestNotFound",
                "host key request not found"
            ),
            Self::NotFound(what) => {
                crate::text!("errors.ssh.notFound", "{what} not found", what = *what)
            }
            Self::HostChanged => crate::text!(
                "errors.ssh.hostChanged",
                "the host changed while connecting; connect again"
            ),
            Self::InvalidInput(t) | Self::AuthFailed(t) | Self::PassphraseRefused(t) => t.clone(),
            Self::HostKeyRejected => {
                crate::text!(
                    "errors.ssh.hostKeyRejected",
                    "the host key was not accepted"
                )
            }
            Self::HostKeyChanged => {
                crate::text!("errors.ssh.hostKeyChanged", "the host key has changed")
            }
            Self::HostKeyRevoked => {
                crate::text!("errors.ssh.hostKeyRevoked", "the host key has been revoked")
            }
            Self::SecretRequired => crate::text!(
                "errors.ssh.secretRequired",
                "a password or passphrase is required"
            ),
            Self::InvalidPassphrase => crate::text!(
                "errors.ssh.invalidPassphrase",
                "the passphrase does not unlock the private key"
            ),
            Self::Cancelled => crate::text!("errors.ssh.cancelled", "the test was cancelled"),
            Self::Busy => crate::text!("errors.ssh.busy", "too many connection tests are running"),
            Self::KeychainUnavailable => crate::text!(
                "errors.ssh.keychainUnavailable",
                "the system keychain is not available"
            ),
            Self::Timeout => crate::text!("errors.ssh.timeout", "the connection timed out"),
            Self::Network => crate::text!(
                "errors.ssh.network",
                "could not reach the host or the connection was lost"
            ),
            Self::Io => crate::text!("errors.ssh.io", "could not read or write a local file"),
            Self::UserKnownHostsUnreadable(kind) => {
                let mut t = crate::text!(
                    "errors.ssh.userKnownHostsUnreadable",
                    "Could not read ~/.ssh/known_hosts to verify the host key: {kind}. Fix or move that file, then retry.",
                    kind = io_kind(*kind)
                );
                t.message = self.to_string();
                t
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts_carry_keys_and_stable_params() {
        let t = SshError::UserKnownHostsUnreadable(std::io::ErrorKind::PermissionDenied).text();
        assert_eq!(t.key, Some("errors.ssh.userKnownHostsUnreadable"));
        assert_eq!(t.params["kind"], "permission_denied");
        assert!(t.message.contains("permission denied"));
        assert_eq!(
            SshError::NotFound("host key").text().key,
            Some("errors.ssh.hostKeyNotFound")
        );
        let t = SshError::HostKeyChanged.text();
        assert_eq!(t.key, Some("errors.ssh.hostKeyChanged"));
        assert_eq!(t.message, SshError::HostKeyChanged.to_string());
    }
}
