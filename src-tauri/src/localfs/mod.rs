//! Local filesystem operations for the explorer, so the webview never touches the disk itself.

mod no_replace;
mod ops;
mod path;

pub(crate) use no_replace::rename as rename_no_replace;
pub use ops::{delete, home, list, mkdir, rename};
pub(crate) use ops::{fail, is_link, remove_link};
pub(crate) use path::{display, name, resolve};
