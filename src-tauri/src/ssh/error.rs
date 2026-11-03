use thiserror::Error;

use crate::secrets::SecretError;

#[derive(Debug, Error, PartialEq)]
pub enum SshError {
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    InvalidInput(String),
    #[error("the host key was not accepted")]
    HostKeyRejected,
    #[error("the host key has changed")]
    HostKeyChanged,
    #[error("the host key has been revoked")]
    HostKeyRevoked,
    #[error("{0}")]
    AuthFailed(String),
    #[error("a password or passphrase is required")]
    SecretRequired,
    #[error("the passphrase does not unlock the private key")]
    InvalidPassphrase,
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
            Self::NotFound(_) => "not_found",
            Self::InvalidInput(_) => "invalid_input",
            Self::HostKeyRejected => "host_key_rejected",
            Self::HostKeyChanged => "host_key_changed",
            Self::HostKeyRevoked => "host_key_revoked",
            Self::AuthFailed(_) => "auth_failed",
            Self::SecretRequired => "secret_required",
            Self::InvalidPassphrase => "invalid_passphrase",
            Self::KeychainUnavailable => "keychain_unavailable",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Io | Self::UserKnownHostsUnreadable(_) => "io",
        }
    }
}

impl From<SecretError> for SshError {
    fn from(e: SecretError) -> Self {
        match e {
            SecretError::Unavailable => Self::KeychainUnavailable,
            SecretError::TooLong | SecretError::InvalidScope => Self::InvalidInput(e.to_string()),
        }
    }
}
