mod resolve;
mod template;

pub use resolve::{
    Layers, Level, Resolution, ResolveError, ResolvedAuth, ResolvedHost, SecretRef, resolve_host,
};
pub use template::{
    MAX_NAME_CHARS, Segment, has_references, is_valid_name, parse, single_reference,
};
