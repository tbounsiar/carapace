use std::io::{self, ErrorKind};
use std::path::Path;

use thiserror::Error;

use crate::files::FsError;

/// Payloads are paths or fixed text, never key material or file contents.
#[derive(Debug, Error, PartialEq)]
pub enum KeyError {
    #[error("{0}")]
    InvalidInput(String),
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
            Self::Io(_) => "io",
            Self::MissingFolder => "not_found",
            Self::ReadOnlyFolder => "permission_denied",
            Self::Taken(_) => "already_exists",
            Self::NotThisKey => "conflict",
            Self::Fs(e) => e.code(),
        }
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
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
