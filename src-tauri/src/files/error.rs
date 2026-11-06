use thiserror::Error;

use crate::text::{Localized, Text};

/// File operation failure. Payloads are the user's own paths, never library error text.
#[derive(Debug, Error, PartialEq)]
pub enum FsError {
    #[error("the host is not connected")]
    NotConnected,
    #[error("{0} was not found")]
    NotFound(String),
    /// A failure about something other than a path (a transfer, the queue), with its code.
    #[error("{text}")]
    Other { code: &'static str, text: Text },
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
    InvalidInput(Text),
    #[error("could not access {0}")]
    Io(String),
    #[error("the file transfer channel to the host failed")]
    Network,
    #[error("the server allows no more sessions on this connection")]
    ChannelRefused,
    #[error("the host refused to start its SFTP service")]
    SubsystemRefused,
    #[error("the host did not answer in time while opening the file transfer channel")]
    Timeout,
    #[error("the local copy changed during the upload")]
    SourceChanged,
}

impl FsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConnected => "not_connected",
            Self::NotFound(_) => "not_found",
            Self::Other { code, .. } => code,
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
            Self::ChannelRefused => "channel_refused",
            Self::SubsystemRefused => "subsystem_refused",
            Self::Timeout => "timeout",
            Self::SourceChanged => "io",
        }
    }

    /// A text without a key is shown in English; callers in this crate pass a `text!`.
    pub fn invalid(msg: impl Into<Text>) -> Self {
        Self::InvalidInput(msg.into())
    }
}

impl Localized for FsError {
    fn text(&self) -> Text {
        match self {
            Self::NotConnected => {
                crate::text!("errors.files.notConnected", "the host is not connected")
            }
            Self::NotFound(path) => {
                crate::text!("errors.files.notFound", "{path} was not found", path = path)
            }
            Self::Other { text: t, .. } | Self::InvalidInput(t) => t.clone(),
            Self::PermissionDenied(path) => crate::text!(
                "errors.files.permissionDenied",
                "permission denied on {path}",
                path = path
            ),
            Self::AlreadyExists(path) => crate::text!(
                "errors.files.alreadyExists",
                "{path} already exists",
                path = path
            ),
            Self::NotEmpty(path) => {
                crate::text!("errors.files.notEmpty", "{path} is not empty", path = path)
            }
            Self::TooLarge(path) => crate::text!(
                "errors.files.tooLarge",
                "{path} is too large to process",
                path = path
            ),
            Self::NotText(path) => crate::text!(
                "errors.files.notText",
                "{path} is not a text file (binary content or not UTF-8)",
                path = path
            ),
            Self::Changed(path) => crate::text!(
                "errors.files.changed",
                "{path} changed on the server since it was opened",
                path = path
            ),
            Self::Deleted(path) => crate::text!(
                "errors.files.deleted",
                "{path} no longer exists on the server",
                path = path
            ),
            Self::Retargeted(path) => crate::text!(
                "errors.files.retargeted",
                "{path} now points to another file on the server",
                path = path
            ),
            Self::PartialWrite(path) => crate::text!(
                "errors.files.partialWrite",
                "{path} may be incomplete on the server: the save failed while writing",
                path = path
            ),
            Self::Io(path) => {
                crate::text!("errors.files.io", "could not access {path}", path = path)
            }
            Self::Network => crate::text!(
                "errors.files.network",
                "the file transfer channel to the host failed"
            ),
            Self::ChannelRefused => crate::text!(
                "errors.files.channelRefused",
                "the server allows no more sessions on this connection"
            ),
            Self::SubsystemRefused => crate::text!(
                "errors.files.subsystemRefused",
                "the host refused to start its SFTP service"
            ),
            Self::Timeout => crate::text!(
                "errors.files.timeout",
                "the host did not answer in time while opening the file transfer channel"
            ),
            Self::SourceChanged => crate::text!(
                "errors.files.sourceChanged",
                "the local copy changed during the upload"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflicts_have_distinct_keys_and_the_path_as_param() {
        let p = || "/etc/a".to_string();
        for (err, key) in [
            (FsError::Changed(p()), "errors.files.changed"),
            (FsError::Deleted(p()), "errors.files.deleted"),
            (FsError::Retargeted(p()), "errors.files.retargeted"),
        ] {
            let t = err.text();
            assert_eq!(t.key, Some(key));
            assert_eq!(t.params["path"], "/etc/a");
            assert_eq!(t.message, err.to_string());
        }
    }
}
