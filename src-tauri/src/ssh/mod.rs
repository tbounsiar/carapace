mod error;
mod known_hosts;
mod manager;

pub use error::SshError;
pub use manager::{ConnectEvent, ConnectionInfo, Credential, SshManager};
