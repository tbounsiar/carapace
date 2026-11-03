//! SSH key files: generation into the app's keys directory or a chosen folder, inspection of existing private
//! keys, and deployment of a public key to a remote `authorized_keys`. Independent of the
//! config and the keychain; `commands::keys` orchestrates them.

mod deploy;
mod error;
mod file;
mod location;
mod pick;

pub use deploy::{Deployed, deploy};
pub use error::KeyError;
pub use file::{
    KeyInfo, KeyType, MAX_KEY_FILE_BYTES, check_pair, deployable_line, generate, inspect, keys_dir,
    permission_warning, remove_pair, validate_file_name, validate_passphrase,
};
pub use location::{KeyLocation, check_location, key_dir};
pub use pick::{PickerGuard, cancel_picker, file_start, folder_start, picked_path};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod e2e_tests;

#[cfg(test)]
mod location_tests;
