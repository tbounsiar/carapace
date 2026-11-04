use thiserror::Error;

use crate::files::FsError;

/// Failure of an external edit. Messages name remote paths and file names only, never the
/// local copy's location.
#[derive(Debug, Error, PartialEq)]
pub enum EditError {
    #[error(transparent)]
    Fs(FsError),
    #[error("{name} is too large to edit (max 1 GiB)")]
    TooLarge { name: String },
    /// Above the confirm threshold: the caller asks, then calls again with `confirmLarge`.
    #[error("{name} is {size} bytes; confirm to download it")]
    LargeFile { name: String, size: u64 },
    /// The name looks like a key, a password store or a credential file: the caller asks,
    /// then calls again with `confirmSensitive`.
    #[error("{name} may hold secrets; confirm to copy it to this computer")]
    Sensitive { name: String },
    #[error("{name} would be run, not opened, by your system")]
    BlockedType { name: String, ext: String },
    #[error("the editor app was not found: {app}")]
    AppNotFound { app: String },
    #[error("{app} runs or forwards files instead of editing them; choose an editor")]
    AppNotEditor { app: String },
    #[error("the editor app could not be started")]
    AppFailed,
    /// The host id now reaches another server (other host key or endpoint) than the one the
    /// file was opened from.
    #[error("{0} was opened from another server; nothing was sent")]
    HostChanged(String),
    #[error("the host of {0} no longer exists")]
    HostGone(String),
    #[error("{0} is not in conflict")]
    NoConflict(String),
    #[error("{0} is not a regular file")]
    NotRegular(String),
    #[error("the changes to {0} were not uploaded")]
    NotUploaded(String),
    #[error("edited file not found")]
    UnknownId,
    #[error("{0}")]
    InvalidInput(String),
    #[error("the local copy could not be read or written")]
    Local,
}

impl EditError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Fs(e) => e.code(),
            Self::TooLarge { .. } => "too_large",
            Self::LargeFile { .. } => "large_file",
            Self::Sensitive { .. } => "sensitive",
            Self::BlockedType { .. } => "blocked_type",
            Self::AppNotFound { .. } => "app_not_found",
            Self::AppNotEditor { .. } => "app_not_editor",
            Self::AppFailed => "app_failed",
            Self::HostChanged(_) => "host_changed",
            Self::HostGone(_) => "not_found",
            Self::NoConflict(_) => "invalid_input",
            Self::NotRegular(_) => "not_regular_file",
            Self::NotUploaded(_) => "not_uploaded",
            Self::UnknownId => "not_found",
            Self::InvalidInput(_) => "invalid_input",
            Self::Local => "io",
        }
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }
}

impl From<FsError> for EditError {
    fn from(e: FsError) -> Self {
        Self::Fs(e)
    }
}

impl From<std::io::Error> for EditError {
    fn from(_: std::io::Error) -> Self {
        Self::Local
    }
}
