use thiserror::Error;

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
    #[error("{0}")]
    Unsupported(String),
    #[error("the connection timed out")]
    Timeout,
    #[error("could not reach the host or the connection was lost")]
    Network,
    #[error("could not read or write a local file")]
    Io,
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
            Self::Unsupported(_) => "unsupported",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Io => "io",
        }
    }
}
