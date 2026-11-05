use thiserror::Error;

use crate::text::{Localized, Text};

#[derive(Debug, Error, PartialEq)]
pub enum TerminalError {
    #[error("terminal not found")]
    NotFound,
    #[error("the host is not connected")]
    NotConnected,
    #[error("{0}")]
    InvalidInput(Text),
    #[error("could not open a shell on the host")]
    Network,
    #[error("the terminal is not accepting input right now")]
    Busy,
}

impl TerminalError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::NotConnected => "not_connected",
            Self::InvalidInput(_) => "invalid_input",
            Self::Network => "network",
            Self::Busy => "busy",
        }
    }
}

impl Localized for TerminalError {
    fn text(&self) -> Text {
        match self {
            Self::NotFound => crate::text!("errors.terminal.notFound", "terminal not found"),
            Self::NotConnected => {
                crate::text!("errors.terminal.notConnected", "the host is not connected")
            }
            Self::InvalidInput(t) => t.clone(),
            Self::Network => {
                crate::text!(
                    "errors.terminal.network",
                    "could not open a shell on the host"
                )
            }
            Self::Busy => crate::text!(
                "errors.terminal.busy",
                "the terminal is not accepting input right now"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_number_params() {
        let t = crate::terminal::manager::check_size(0, 1)
            .unwrap_err()
            .text();
        assert_eq!(t.key, Some("errors.terminal.size"));
        assert!(t.params["cols"].is_u64() && t.params["rows"].is_u64());
    }
}
