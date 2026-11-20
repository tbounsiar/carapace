use thiserror::Error;

use crate::text::{Localized, Text};

/// Never carries what the plugin or the network said: its errors embed URLs, paths and parts of
/// the server's answer.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum UpdateError {
    #[error("could not reach the update server")]
    Network,
    #[error("no usable update information was found")]
    Unavailable,
    #[error("the update signature was refused; nothing was installed")]
    Signature,
    #[error("the update could not be installed")]
    InstallFailed,
    #[error("no update has been downloaded")]
    NothingDownloaded,
    #[error("no update is available")]
    NoUpdate,
    #[error("an update is already being downloaded or installed")]
    Busy,
    #[error("the download was cancelled")]
    Cancelled,
    #[error("on this system, updates are installed from the release page")]
    Unsupported,
    #[error("some edited files have changes that are not uploaded")]
    NotUploaded,
    #[error("the version is not valid")]
    InvalidVersion,
    #[error("the browser could not be opened")]
    Browser,
    /// The page did not confirm while transfers run or editors have unsaved changes.
    #[error("transfers are running or editors have unsaved changes")]
    Unconfirmed,
    /// The update began closing the app, then its installer did not start.
    #[error("restart Carapace to finish or retry the update")]
    RestartRequired,
}

impl UpdateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Unavailable => "update_unavailable",
            Self::Signature => "signature_invalid",
            Self::InstallFailed => "install_failed",
            Self::NothingDownloaded => "nothing_downloaded",
            Self::NoUpdate => "not_found",
            Self::Busy => "busy",
            Self::Cancelled => "cancelled",
            Self::Unsupported => "unsupported",
            Self::NotUploaded => "not_uploaded",
            Self::InvalidVersion => "invalid_input",
            Self::Browser => "io",
            Self::Unconfirmed => "busy",
            Self::RestartRequired => "restart_required",
        }
    }
}

impl Localized for UpdateError {
    fn text(&self) -> Text {
        match self {
            Self::Network => crate::text!(
                "errors.updates.network",
                "could not reach the update server"
            ),
            Self::Unavailable => crate::text!(
                "errors.updates.unavailable",
                "no usable update information was found"
            ),
            Self::Signature => crate::text!(
                "errors.updates.signature",
                "the update signature was refused; nothing was installed"
            ),
            Self::InstallFailed => crate::text!(
                "errors.updates.installFailed",
                "the update could not be installed"
            ),
            Self::NothingDownloaded => crate::text!(
                "errors.updates.nothingDownloaded",
                "no update has been downloaded"
            ),
            Self::NoUpdate => crate::text!("errors.updates.noUpdate", "no update is available"),
            Self::Busy => crate::text!(
                "errors.updates.busy",
                "an update is already being downloaded or installed"
            ),
            Self::Cancelled => {
                crate::text!("errors.updates.cancelled", "the download was cancelled")
            }
            Self::Unsupported => crate::text!(
                "errors.updates.unsupported",
                "on this system, updates are installed from the release page"
            ),
            Self::NotUploaded => crate::text!(
                "errors.updates.notUploaded",
                "some edited files have changes that are not uploaded"
            ),
            Self::InvalidVersion => {
                crate::text!("errors.updates.invalidVersion", "the version is not valid")
            }
            Self::Browser => crate::text!(
                "errors.updates.browserFailed",
                "the browser could not be opened"
            ),
            Self::Unconfirmed => crate::text!(
                "errors.updates.unconfirmed",
                "transfers are running or editors have unsaved changes"
            ),
            Self::RestartRequired => crate::text!(
                "errors.updates.restartRequired",
                "restart Carapace to finish or retry the update"
            ),
        }
    }
}

/// Which step failed: the same plugin error means different things in each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Check,
    Download,
    Install,
}

/// Signature and signed-version failures are always `Signature`, whatever the step, so a
/// tampered or mis-signed release is never reported as a network hiccup.
pub fn classify(e: &tauri_plugin_updater::Error, stage: Stage) -> UpdateError {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => UpdateError::Signature,
        _ if stage == Stage::Install => UpdateError::InstallFailed,
        E::Reqwest(r) if r.is_decode() => UpdateError::Unavailable,
        E::Reqwest(_) | E::Io(_) => UpdateError::Network,
        _ => UpdateError::Unavailable,
    }
}
