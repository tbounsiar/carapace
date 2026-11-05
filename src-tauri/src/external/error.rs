use thiserror::Error;

use crate::files::FsError;
use crate::text::{Localized, Text};

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
    InvalidInput(Text),
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

    pub fn invalid(msg: impl Into<Text>) -> Self {
        Self::InvalidInput(msg.into())
    }
}

impl Localized for EditError {
    fn text(&self) -> Text {
        match self {
            Self::Fs(e) => e.text(),
            Self::TooLarge { name } => crate::text!(
                "errors.external.tooLarge",
                "{name} is too large to edit (max 1 GiB)",
                name = name
            ),
            Self::LargeFile { name, size } => crate::text!(
                "errors.external.largeFile",
                "{name} is {size} bytes; confirm to download it",
                name = name,
                size = *size
            ),
            Self::Sensitive { name } => crate::text!(
                "errors.external.sensitive",
                "{name} may hold secrets; confirm to copy it to this computer",
                name = name
            ),
            Self::BlockedType { name, ext } => {
                let mut t = crate::text!(
                    "errors.external.blockedType",
                    "{name} would be run, not opened, by your system",
                    name = name
                );
                t.params.insert("ext".into(), crate::text::param(ext));
                t
            }
            Self::AppNotFound { app } => crate::text!(
                "errors.external.appNotFound",
                "the editor app was not found: {app}",
                app = app
            ),
            Self::AppNotEditor { app } => crate::text!(
                "errors.external.appNotEditor",
                "{app} runs or forwards files instead of editing them; choose an editor",
                app = app
            ),
            Self::AppFailed => crate::text!(
                "errors.external.appFailed",
                "the editor app could not be started"
            ),
            Self::HostChanged(path) => crate::text!(
                "errors.external.hostChanged",
                "{path} was opened from another server; nothing was sent",
                path = path
            ),
            Self::HostGone(path) => crate::text!(
                "errors.external.hostGone",
                "the host of {path} no longer exists",
                path = path
            ),
            Self::NoConflict(path) => crate::text!(
                "errors.external.noConflict",
                "{path} is not in conflict",
                path = path
            ),
            Self::NotRegular(path) => crate::text!(
                "errors.external.notRegular",
                "{path} is not a regular file",
                path = path
            ),
            Self::NotUploaded(path) => crate::text!(
                "errors.external.notUploaded",
                "the changes to {path} were not uploaded",
                path = path
            ),
            Self::UnknownId => crate::text!("errors.external.unknownId", "edited file not found"),
            Self::InvalidInput(t) => t.clone(),
            Self::Local => crate::text!(
                "errors.external.local",
                "the local copy could not be read or written"
            ),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts_send_the_values_the_interface_needs() {
        let t = EditError::LargeFile {
            name: "a.log".into(),
            size: 123_456_789,
        }
        .text();
        assert_eq!(t.key, Some("errors.external.largeFile"));
        assert_eq!(t.params["size"], 123_456_789);
        assert_eq!(t.params["name"], "a.log");
        let t = EditError::AppNotFound {
            app: "code.exe".into(),
        }
        .text();
        assert_eq!(t.key, Some("errors.external.appNotFound"));
        assert_eq!(t.params["app"], "code.exe");
        let t = EditError::BlockedType {
            name: "a.exe".into(),
            ext: "exe".into(),
        }
        .text();
        assert_eq!(t.params["ext"], "exe");
        assert_eq!(t.message, "a.exe would be run, not opened, by your system");
        let err = EditError::Fs(FsError::Deleted("/etc/a".into()));
        let view = serde_json::to_value(crate::external::state::ErrorView::of(&err)).unwrap();
        assert_eq!(view["code"], "conflict");
        assert_eq!(view["key"], "errors.files.deleted");
        assert_eq!(view["params"]["path"], "/etc/a");
        assert_eq!(view["message"], "/etc/a no longer exists on the server");
    }
}
