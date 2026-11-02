//! Types and rules shared by the remote (`sftp`) and local (`localfs`) file modules.

mod entry;
mod error;
mod name;

pub use entry::{EntryKind, FileEntry, Listing, mode_string};
pub use error::FsError;
pub use name::name;

/// Largest directory listing returned, and largest directory a recursive delete reads.
pub const MAX_ENTRIES: usize = 50_000;
/// Deepest directory level a recursive delete descends to.
pub const MAX_DEPTH: usize = 64;
pub const MAX_PATH_BYTES: usize = 4096;
