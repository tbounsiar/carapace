use std::fmt;
use std::sync::Arc;

use secrecy::{ExposeSecret, SecretString};
use thiserror::Error;

pub const SERVICE: &str = "org.tbounsiar.carapace";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    Password,
    Passphrase,
}

impl SecretKind {
    pub const ALL: [SecretKind; 2] = [SecretKind::Password, SecretKind::Passphrase];

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "password" => Some(Self::Password),
            "passphrase" => Some(Self::Passphrase),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Passphrase => "passphrase",
        }
    }
}

impl fmt::Display for SecretKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The Windows Credential Manager stores values as UTF-16 in a blob of at most 2560 bytes.
pub const MAX_SECRET_UTF16_UNITS: usize = 1280;

pub fn fits_keychain(value: &SecretString) -> bool {
    value.expose_secret().encode_utf16().count() <= MAX_SECRET_UTF16_UNITS
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretScope {
    project_id: String,
    environment_id: String,
    host_id: String,
}

impl SecretScope {
    /// IDs must be UUIDs so an account name can never be forged with `/` or other separators.
    pub fn new(project_id: &str, environment_id: &str, host_id: &str) -> Result<Self, SecretError> {
        for id in [project_id, environment_id, host_id] {
            if uuid::Uuid::try_parse(id).is_err() {
                return Err(SecretError::InvalidScope);
            }
        }
        Ok(Self {
            project_id: project_id.into(),
            environment_id: environment_id.into(),
            host_id: host_id.into(),
        })
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn account(&self, kind: SecretKind) -> String {
        format!(
            "{}/{}/{}/{}",
            self.project_id, self.environment_id, self.host_id, kind
        )
    }
}

/// Messages are fixed strings: keychain errors can embed the stored bytes, so they are never forwarded.
#[derive(Debug, Error, PartialEq)]
pub enum SecretError {
    #[error("the system keychain is not available")]
    Unavailable,
    #[error("the secret is too long for the system keychain")]
    TooLong,
    #[error("invalid project, environment or host identifier")]
    InvalidScope,
}

impl SecretError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable => "keychain_unavailable",
            Self::TooLong | Self::InvalidScope => "invalid_input",
        }
    }
}

pub trait SecretBackend: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<SecretString>, SecretError>;
    fn set(&self, account: &str, value: &SecretString) -> Result<(), SecretError>;
    /// Deleting a missing entry succeeds.
    fn delete(&self, account: &str) -> Result<(), SecretError>;
}

#[derive(Clone)]
pub struct SecretStore {
    backend: Arc<dyn SecretBackend>,
}

impl SecretStore {
    pub fn new(backend: Arc<dyn SecretBackend>) -> Self {
        Self { backend }
    }

    pub fn keychain() -> Self {
        Self::new(Arc::new(keychain::KeychainBackend))
    }

    pub fn get(
        &self,
        scope: &SecretScope,
        kind: SecretKind,
    ) -> Result<Option<SecretString>, SecretError> {
        self.backend.get(&scope.account(kind))
    }

    pub fn set(
        &self,
        scope: &SecretScope,
        kind: SecretKind,
        value: &SecretString,
    ) -> Result<(), SecretError> {
        if !fits_keychain(value) {
            return Err(SecretError::TooLong);
        }
        self.backend.set(&scope.account(kind), value)
    }

    pub fn delete(&self, scope: &SecretScope, kind: SecretKind) -> Result<(), SecretError> {
        self.backend.delete(&scope.account(kind))
    }

    pub fn has(&self, scope: &SecretScope, kind: SecretKind) -> Result<bool, SecretError> {
        Ok(self.get(scope, kind)?.is_some())
    }
}

mod keychain {
    use keyring::{Entry, Error};
    use secrecy::{ExposeSecret, SecretString};

    use super::{SERVICE, SecretBackend, SecretError};

    pub struct KeychainBackend;

    // The keyring error is dropped on purpose: `BadEncoding` carries the stored bytes.
    pub(super) fn map(e: Error) -> SecretError {
        match e {
            Error::TooLong(..) => SecretError::TooLong,
            _ => SecretError::Unavailable,
        }
    }

    fn entry(account: &str) -> Result<Entry, SecretError> {
        Entry::new(SERVICE, account).map_err(map)
    }

    impl SecretBackend for KeychainBackend {
        fn get(&self, account: &str) -> Result<Option<SecretString>, SecretError> {
            match entry(account)?.get_password() {
                Ok(value) => Ok(Some(SecretString::from(value))),
                Err(Error::NoEntry) => Ok(None),
                Err(e) => Err(map(e)),
            }
        }

        fn set(&self, account: &str, value: &SecretString) -> Result<(), SecretError> {
            entry(account)?
                .set_password(value.expose_secret())
                .map_err(map)
        }

        fn delete(&self, account: &str) -> Result<(), SecretError> {
            match entry(account)?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(e) => Err(map(e)),
            }
        }
    }
}

#[cfg(test)]
pub use memory::MemoryBackend;

#[cfg(test)]
mod memory {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};

    use secrecy::{ExposeSecret, SecretString};

    use super::{SecretBackend, SecretError, SecretStore};

    #[derive(Default)]
    pub struct MemoryBackend {
        entries: Mutex<HashMap<String, SecretString>>,
        failing: AtomicBool,
    }

    impl MemoryBackend {
        pub fn store() -> (SecretStore, Arc<MemoryBackend>) {
            let backend = Arc::new(MemoryBackend::default());
            (SecretStore::new(backend.clone()), backend)
        }

        pub fn set_failing(&self, failing: bool) {
            self.failing.store(failing, Ordering::SeqCst);
        }

        pub fn accounts(&self) -> Vec<String> {
            let mut out: Vec<String> = self.entries.lock().unwrap().keys().cloned().collect();
            out.sort();
            out
        }

        fn entries(&self) -> Result<MutexGuard<'_, HashMap<String, SecretString>>, SecretError> {
            if self.failing.load(Ordering::SeqCst) {
                return Err(SecretError::Unavailable);
            }
            self.entries.lock().map_err(|_| SecretError::Unavailable)
        }
    }

    impl SecretBackend for MemoryBackend {
        fn get(&self, account: &str) -> Result<Option<SecretString>, SecretError> {
            Ok(self
                .entries()?
                .get(account)
                .map(|v| SecretString::from(v.expose_secret())))
        }

        fn set(&self, account: &str, value: &SecretString) -> Result<(), SecretError> {
            self.entries()?
                .insert(account.into(), SecretString::from(value.expose_secret()));
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), SecretError> {
            self.entries()?.remove(account);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "00000000-0000-4000-8000-000000000001";
    const E: &str = "00000000-0000-4000-8000-000000000002";
    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";

    fn scope(h: &str) -> SecretScope {
        SecretScope::new(P, E, h).unwrap()
    }

    fn read(store: &SecretStore, s: &SecretScope, kind: SecretKind) -> String {
        store
            .get(s, kind)
            .unwrap()
            .unwrap()
            .expose_secret()
            .to_owned()
    }

    #[test]
    fn account_is_scoped_by_project_environment_host_and_kind() {
        let s = scope(A);
        assert_eq!(
            s.account(SecretKind::Password),
            format!("{P}/{E}/{A}/password")
        );
        assert_eq!(
            s.account(SecretKind::Passphrase),
            format!("{P}/{E}/{A}/passphrase")
        );
        assert_ne!(
            SecretScope::new(B, E, A)
                .unwrap()
                .account(SecretKind::Password),
            s.account(SecretKind::Password)
        );
    }

    #[test]
    fn scope_rejects_ids_that_are_not_uuids() {
        for (p, e, h) in [
            ("p", E, A),
            (P, "a/b", A),
            (P, E, ""),
            (P, E, "00000000-0000-4000-8000-00000000000a/password"),
        ] {
            assert_eq!(SecretScope::new(p, e, h), Err(SecretError::InvalidScope));
        }
        assert_eq!(SecretError::InvalidScope.code(), "invalid_input");
    }

    #[test]
    fn set_refuses_values_over_the_windows_limit_without_touching_the_backend() {
        let (store, mem) = MemoryBackend::store();
        let max = "a".repeat(MAX_SECRET_UTF16_UNITS);
        store
            .set(&scope(A), SecretKind::Password, &SecretString::from(max))
            .unwrap();
        let over = "a".repeat(MAX_SECRET_UTF16_UNITS + 1);
        assert_eq!(
            store.set(&scope(B), SecretKind::Password, &SecretString::from(over)),
            Err(SecretError::TooLong)
        );
        let astral = "😀".repeat(MAX_SECRET_UTF16_UNITS / 2 + 1);
        assert!(!fits_keychain(&SecretString::from(astral)));
        assert_eq!(mem.accounts().len(), 1);
    }

    #[test]
    fn kind_parses_only_known_names() {
        assert_eq!(SecretKind::parse("password"), Some(SecretKind::Password));
        assert_eq!(
            SecretKind::parse("passphrase"),
            Some(SecretKind::Passphrase)
        );
        assert_eq!(SecretKind::parse("Password"), None);
        assert_eq!(SecretKind::parse(""), None);
    }

    #[test]
    fn set_get_has_delete_round_trip() {
        let (store, _) = MemoryBackend::store();
        let a = scope(A);
        assert!(!store.has(&a, SecretKind::Password).unwrap());
        store
            .set(&a, SecretKind::Password, &SecretString::from("pw"))
            .unwrap();
        assert!(store.has(&a, SecretKind::Password).unwrap());
        assert!(!store.has(&a, SecretKind::Passphrase).unwrap());
        assert!(!store.has(&scope(B), SecretKind::Password).unwrap());
        assert_eq!(read(&store, &a, SecretKind::Password), "pw");
        store
            .set(&a, SecretKind::Password, &SecretString::from("pw2"))
            .unwrap();
        assert_eq!(read(&store, &a, SecretKind::Password), "pw2");
        store.delete(&a, SecretKind::Password).unwrap();
        assert!(!store.has(&a, SecretKind::Password).unwrap());
        store.delete(&a, SecretKind::Password).unwrap();
    }

    #[test]
    fn unavailable_backend_reports_a_safe_error() {
        let (store, mem) = MemoryBackend::store();
        mem.set_failing(true);
        let err = store.has(&scope(A), SecretKind::Password).unwrap_err();
        assert_eq!(err, SecretError::Unavailable);
        assert_eq!(err.code(), "keychain_unavailable");
        assert_eq!(
            store
                .set(&scope(A), SecretKind::Password, &SecretString::from("x"))
                .unwrap_err(),
            SecretError::Unavailable
        );
    }

    #[test]
    fn keychain_errors_never_carry_their_payload() {
        let mapped = keychain::map(keyring::Error::BadEncoding(b"hunter2".to_vec()));
        assert_eq!(mapped, SecretError::Unavailable);
        assert!(!mapped.to_string().contains("hunter2"));
        assert!(!format!("{mapped:?}").contains("hunter2"));
        assert_eq!(
            keychain::map(keyring::Error::TooLong("password".into(), 2560)),
            SecretError::TooLong
        );
    }

    #[test]
    fn secret_debug_is_redacted() {
        let s = SecretString::from("hunter2");
        assert!(!format!("{s:?}").contains("hunter2"));
    }
}
