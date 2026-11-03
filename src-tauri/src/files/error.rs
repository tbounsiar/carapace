use thiserror::Error;

/// File operation failure. Payloads are the user's own paths, never library error text.
#[derive(Debug, Error, PartialEq)]
pub enum FsError {
    #[error("the host is not connected")]
    NotConnected,
    #[error("{0} was not found")]
    NotFound(String),
    #[error("permission denied on {0}")]
    PermissionDenied(String),
    #[error("{0} already exists")]
    AlreadyExists(String),
    #[error("{0} is not empty")]
    NotEmpty(String),
    #[error("{0} is too large to process")]
    TooLarge(String),
    #[error("{0} is not a text file (binary content or not UTF-8)")]
    NotText(String),
    #[error("{0} changed on the server since it was opened")]
    Changed(String),
    #[error("{0} no longer exists on the server")]
    Deleted(String),
    #[error("{0} now points to another file on the server")]
    Retargeted(String),
    #[error("{0} may be incomplete on the server: the save failed while writing")]
    PartialWrite(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("could not access {0}")]
    Io(String),
    #[error("the file transfer channel to the host failed")]
    Network,
}

impl FsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConnected => "not_connected",
            Self::NotFound(_) => "not_found",
            Self::PermissionDenied(_) => "permission_denied",
            Self::AlreadyExists(_) => "already_exists",
            Self::NotEmpty(_) => "not_empty",
            Self::TooLarge(_) => "too_large",
            Self::NotText(_) => "not_text",
            Self::Changed(_) | Self::Deleted(_) | Self::Retargeted(_) => "conflict",
            Self::PartialWrite(_) => "partial_write",
            Self::InvalidInput(_) => "invalid_input",
            Self::Io(_) => "io",
            Self::Network => "network",
        }
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }
}
