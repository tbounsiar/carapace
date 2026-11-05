use std::io::{self, ErrorKind};
use std::path::Path;

use thiserror::Error;

use crate::files::FsError;
use crate::text::{Localized, Text};

/// Payloads are paths or fixed text, never key material or file contents.
#[derive(Debug, Error, PartialEq)]
pub enum KeyError {
    #[error("{0}")]
    InvalidInput(Text),
    #[error("{0} already exists")]
    AlreadyExists(String),
    #[error("{0} was not found")]
    NotFound(String),
    #[error("the passphrase does not unlock the private key")]
    InvalidPassphrase,
    #[error("{0} is too large")]
    TooLarge(String),
    #[error("permission denied on {0}")]
    PermissionDenied(String),
    #[error("could not read or write {0}")]
    Io(String),
    #[error("could not read or write the generated key")]
    GenerationFailed,
    #[error("This folder does not exist.")]
    MissingFolder,
    #[error("Carapace cannot write to this folder. Choose another one.")]
    ReadOnlyFolder,
    /// The file name; either the private key or its `.pub` is taken.
    #[error("{0} or {0}.pub already exists in this folder.")]
    Taken(String),
    #[error("The file at this path no longer holds this key. Nothing was deleted.")]
    NotThisKey,
    #[error(transparent)]
    Fs(#[from] FsError),
}

impl KeyError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "invalid_input",
            Self::AlreadyExists(_) => "already_exists",
            Self::NotFound(_) => "not_found",
            Self::InvalidPassphrase => "invalid_passphrase",
            Self::TooLarge(_) => "too_large",
            Self::PermissionDenied(_) => "permission_denied",
            Self::Io(_) | Self::GenerationFailed => "io",
            Self::MissingFolder => "not_found",
            Self::ReadOnlyFolder => "permission_denied",
            Self::Taken(_) => "already_exists",
            Self::NotThisKey => "conflict",
            Self::Fs(e) => e.code(),
        }
    }

    pub fn invalid(msg: impl Into<Text>) -> Self {
        Self::InvalidInput(msg.into())
    }

    pub fn io(e: io::Error, path: &Path) -> Self {
        let p = path.display().to_string();
        match e.kind() {
            ErrorKind::NotFound => Self::NotFound(p),
            ErrorKind::AlreadyExists => Self::AlreadyExists(p),
            ErrorKind::PermissionDenied => Self::PermissionDenied(p),
            _ => Self::Io(p),
        }
    }
}

impl Localized for KeyError {
    fn text(&self) -> Text {
        match self {
            Self::InvalidInput(t) => t.clone(),
            Self::AlreadyExists(path) => {
                crate::text!(
                    "errors.keys.alreadyExists",
                    "{path} already exists",
                    path = path
                )
            }
            Self::NotFound(path) => {
                crate::text!("errors.keys.notFound", "{path} was not found", path = path)
            }
            Self::InvalidPassphrase => crate::text!(
                "errors.keys.invalidPassphrase",
                "the passphrase does not unlock the private key"
            ),
            Self::TooLarge(path) => {
                crate::text!("errors.keys.tooLarge", "{path} is too large", path = path)
            }
            Self::PermissionDenied(path) => crate::text!(
                "errors.keys.permissionDenied",
                "permission denied on {path}",
                path = path
            ),
            Self::Io(path) => {
                crate::text!(
                    "errors.keys.io",
                    "could not read or write {path}",
                    path = path
                )
            }
            Self::GenerationFailed => crate::text!(
                "errors.keys.generationFailed",
                "could not read or write the generated key"
            ),
            Self::MissingFolder => {
                crate::text!("errors.keys.missingFolder", "This folder does not exist.")
            }
            Self::ReadOnlyFolder => crate::text!(
                "errors.keys.readOnlyFolder",
                "Carapace cannot write to this folder. Choose another one."
            ),
            Self::Taken(file_name) => crate::text!(
                "errors.keys.taken",
                "{name} or {name}.pub already exists in this folder.",
                name = file_name
            ),
            Self::NotThisKey => crate::text!(
                "errors.keys.notThisKey",
                "The file at this path no longer holds this key. Nothing was deleted."
            ),
            Self::Fs(e) => e.text(),
        }
    }
}
