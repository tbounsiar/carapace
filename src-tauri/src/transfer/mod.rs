//! Upload and download queue between the local disk and a connection's SFTP channel.

mod job;
mod manager;
mod names;
mod side;
mod types;

pub use manager::{Connections, Finished, RemoteFuture, TransferManager};
pub use types::{
    ConflictPolicy, Decision, Direction, EnqueueRequest, TransferEvent, TransferState, TransferView,
};

#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
mod tests;
