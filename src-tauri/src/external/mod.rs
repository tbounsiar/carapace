//! Remote files opened in an external editor: an owner-only local copy per file, watched, and
//! uploaded on each save through the remote editor's atomic, version-checked write.

mod disk;
mod error;
mod launch;
mod manager;
mod rules;
mod state;
mod watch;

pub use error::EditError;
pub use launch::{Opener, OsLauncher, check_app};
pub use manager::{Choice, EditEvent, ExternalEdits, OpenRequest};
pub use state::EditedFile;

#[cfg(test)]
mod e2e_tests;
