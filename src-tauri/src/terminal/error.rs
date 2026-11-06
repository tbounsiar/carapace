use thiserror::Error;

use crate::ssh::{ChannelError, SshError};
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
    #[error("the server allows no more sessions on this connection")]
    ChannelRefused,
    #[error("the host refused to allocate a terminal (pty)")]
    PtyRefused,
    #[error("the host refused to start a shell")]
    ShellRefused,
    #[error("the host did not answer in time while opening the terminal")]
    Timeout,
    /// The extra connection the terminal needed could not be made.
    #[error("{0}")]
    Connect(SshError),
}

impl TerminalError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::NotConnected => "not_connected",
            Self::InvalidInput(_) => "invalid_input",
            Self::Network => "network",
            Self::Busy => "busy",
            Self::ChannelRefused => "channel_refused",
            Self::PtyRefused => "pty_refused",
            Self::ShellRefused => "shell_refused",
            Self::Timeout => "timeout",
            Self::Connect(e) => e.code(),
        }
    }
}

impl From<ChannelError> for TerminalError {
    fn from(e: ChannelError) -> Self {
        match e {
            ChannelError::NotConnected => Self::NotConnected,
            ChannelError::Refused => Self::ChannelRefused,
            ChannelError::Timeout => Self::Timeout,
            ChannelError::Network => Self::Network,
            ChannelError::Connect(e) => Self::Connect(e),
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
            Self::ChannelRefused => crate::text!(
                "errors.terminal.channelRefused",
                "the server allows no more sessions on this connection"
            ),
            Self::PtyRefused => crate::text!(
                "errors.terminal.ptyRefused",
                "the host refused to allocate a terminal (pty)"
            ),
            Self::ShellRefused => crate::text!(
                "errors.terminal.shellRefused",
                "the host refused to start a shell"
            ),
            Self::Timeout => crate::text!(
                "errors.terminal.timeout",
                "the host did not answer in time while opening the terminal"
            ),
            Self::Connect(e) => e.text(),
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

    #[test]
    fn channel_errors_keep_distinct_codes() {
        let cases = [
            (ChannelError::NotConnected, "not_connected"),
            (ChannelError::Refused, "channel_refused"),
            (ChannelError::Timeout, "timeout"),
            (ChannelError::Network, "network"),
            (
                ChannelError::Connect(SshError::AuthFailed("x".into())),
                "auth_failed",
            ),
            (
                ChannelError::Connect(SshError::HostKeyChanged),
                "host_key_changed",
            ),
        ];
        for (e, code) in cases {
            assert_eq!(TerminalError::from(e).code(), code);
        }
        let t = TerminalError::Connect(SshError::HostKeyChanged).text();
        assert_eq!(t.key, Some("errors.ssh.hostKeyChanged"));
    }
}
