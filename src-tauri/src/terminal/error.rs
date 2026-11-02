use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum TerminalError {
    #[error("terminal not found")]
    NotFound,
    #[error("the host is not connected")]
    NotConnected,
    #[error("{0}")]
    InvalidInput(String),
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
