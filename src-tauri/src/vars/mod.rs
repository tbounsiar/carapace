mod resolve;
mod template;

pub use resolve::{Layers, Level, Resolution, ResolveError, ResolvedAuth, SecretRef, resolve_host};
pub use template::{Segment, has_references, is_valid_name, parse, single_reference};
