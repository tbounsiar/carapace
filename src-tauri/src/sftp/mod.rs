mod manager;
mod path;
mod text;

pub use manager::{Remote, RemoteMeta, Saved, SftpManager, TextFile, WriteText};
pub use path::{file_name, join, normalize};
pub use text::Eol;
