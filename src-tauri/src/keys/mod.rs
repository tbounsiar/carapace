//! SSH key files: generation into the app's keys directory, inspection of existing private
//! keys, and deployment of a public key to a remote `authorized_keys`. Independent of the
//! config and the keychain; `commands::keys` orchestrates them.

mod deploy;
mod error;
mod file;

pub use deploy::{Deployed, deploy};
pub use error::KeyError;
pub use file::{
    KeyInfo, KeyType, MAX_KEY_FILE_BYTES, deployable_line, generate, inspect, keys_dir,
    permission_warning, remove_managed, validate_file_name, validate_passphrase,
};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod e2e_tests;
