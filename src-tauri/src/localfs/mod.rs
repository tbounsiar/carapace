//! Local filesystem operations for the explorer, so the webview never touches the disk itself.

mod no_replace;
mod ops;
mod path;

pub use ops::{delete, home, list, mkdir, rename};
