use std::cell::RefCell;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::vars::is_valid_name;

pub const SERVICE: &str = "org.tbounsiar.carapace";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    Password,
    Passphrase,
}

impl SecretKind {
    pub const ALL: [SecretKind; 2] = [SecretKind::Password, SecretKind::Passphrase];

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

/// Canonical form only (lowercase, hyphenated), as the app generates them: on a keychain with
/// case-insensitive names, `ABC...` and `abc...` would otherwise be two ids for one account.
fn is_uuid(id: &str) -> bool {
    uuid::Uuid::try_parse(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

/// The keychain entry of a secret variable. Ids must be UUIDs and names valid variable names,
/// so an account can never be forged with `/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VarKey {
    account: String,
}

impl VarKey {
    fn checked(ids: &[&str], name: &str, account: String) -> Result<Self, SecretError> {
        if !is_valid_name(name) || !ids.iter().all(|id| is_uuid(id)) {
            return Err(SecretError::InvalidScope);
        }
        Ok(Self { account })
    }

    pub fn global(name: &str) -> Result<Self, SecretError> {
        Self::checked(&[], name, format!("var/global/{name}"))
    }

    pub fn project(project_id: &str, name: &str) -> Result<Self, SecretError> {
        Self::checked(
            &[project_id],
            name,
            format!("var/project/{project_id}/{name}"),
        )
    }

    pub fn account(&self) -> &str {
        &self.account
    }

    /// The variable name: the last account segment (names never contain `/`).
    pub fn name(&self) -> &str {
        self.account.rsplit('/').next().unwrap_or_default()
    }
}

/// The keychain entries of secrets remembered from the credential prompt for one host
/// (`conn/{hostId}/none/{kind}`; the `none` segment is kept so existing entries stay valid).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedKey {
    host_id: String,
}

impl SavedKey {
    pub fn new(host_id: &str) -> Result<Self, SecretError> {
        if !is_uuid(host_id) {
            return Err(SecretError::InvalidScope);
        }
        Ok(Self {
            host_id: host_id.into(),
        })
    }

    pub fn account(&self, kind: SecretKind) -> String {
        format!("conn/{}/none/{kind}", self.host_id)
    }
}

/// The keychain entry of a passphrase remembered for a registered key (`key/{keyId}/passphrase`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPassKey {
    account: String,
}

impl KeyPassKey {
    pub fn new(key_id: &str) -> Result<Self, SecretError> {
        if !is_uuid(key_id) {
            return Err(SecretError::InvalidScope);
        }
        Ok(Self {
            account: format!("key/{key_id}/passphrase"),
        })
    }

    pub fn account(&self) -> &str {
        &self.account
    }
}

/// Messages are fixed strings: keychain errors can embed the stored bytes, so they are never forwarded.
#[derive(Debug, Error, PartialEq)]
pub enum SecretError {
    #[error("the system keychain is not available")]
    Unavailable,
    #[error("the secret is too long for the system keychain")]
    TooLong,
    #[error("invalid identifier or variable name")]
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

/// A saved connection secret is only valid for the target it was typed for: `user@host:port`
/// for a password, the resolved key path for a passphrase.
#[derive(Serialize)]
struct SavedOut<'a> {
    target: &'a str,
    secret: &'a str,
}

#[derive(Deserialize)]
struct SavedIn {
    target: String,
    secret: SecretString,
}

/// The buffer is reserved for the worst case (every byte escaped as `\u00XX`) so it never
/// reallocates and leaves a copy of the secret behind; the final copy has the exact length,
/// so the `SecretString` conversion does not reallocate either.
fn encode_saved(target: &str, value: &SecretString) -> Option<SecretString> {
    let secret = value.expose_secret();
    let mut buf = Zeroizing::new(Vec::with_capacity((target.len() + secret.len()) * 6 + 64));
    serde_json::to_writer(&mut *buf, &SavedOut { target, secret }).ok()?;
    let exact: Box<str> = std::str::from_utf8(&buf).ok()?.into();
    Some(SecretString::from(exact))
}

/// Whether `value`, bound to `target`, fits in one keychain entry.
pub fn fits_saved(target: &str, value: &SecretString) -> bool {
    encode_saved(target, value).is_some_and(|e| fits_keychain(&e))
}

thread_local! {
    /// Lifecycle locks held by this thread, by address.
    static HELD: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

/// A held lifecycle lock; a nested `lifecycle()` on the same thread holds nothing more. Not
/// `Send` (it wraps a `MutexGuard`), so it can never be held across an `.await` in a command.
pub struct Lifecycle<'a> {
    guard: Option<MutexGuard<'a, ()>>,
    key: usize,
}

impl Drop for Lifecycle<'_> {
    fn drop(&mut self) {
        if self.guard.is_some() {
            HELD.with(|h| h.borrow_mut().retain(|k| *k != self.key));
        }
    }
}

#[derive(Clone)]
pub struct SecretStore {
    backend: Arc<dyn SecretBackend>,
    lifecycle: Arc<Mutex<()>>,
}

impl SecretStore {
    pub fn new(backend: Arc<dyn SecretBackend>) -> Self {
        Self {
            backend,
            lifecycle: Arc::default(),
        }
    }

    /// Held across a config change and the keychain writes or deletes that follow it, and
    /// across the remember step of a connect (check the target, then save). Without it a
    /// delete running in between could leave an entry nothing references any more.
    /// Lock order: this lock first, then the config store's; the store takes it itself before
    /// its own lock (see `commands::secrets::Migration`), hence reentrant on one thread.
    pub fn lifecycle(&self) -> Lifecycle<'_> {
        let key = Arc::as_ptr(&self.lifecycle) as usize;
        if HELD.with(|h| h.borrow().contains(&key)) {
            return Lifecycle { guard: None, key };
        }
        let guard = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        HELD.with(|h| h.borrow_mut().push(key));
        Lifecycle {
            guard: Some(guard),
            key,
        }
    }

    /// Deletes both secrets of a host from the iteration-2 layout
    /// (`{projectId}/{environmentId}/{hostId}/{kind}`); non-canonical ids are skipped.
    pub fn delete_legacy(
        &self,
        project_id: &str,
        environment_id: &str,
        host_id: &str,
    ) -> Result<(), SecretError> {
        if ![project_id, environment_id, host_id]
            .iter()
            .all(|id| is_uuid(id))
        {
            return Err(SecretError::InvalidScope);
        }
        for kind in SecretKind::ALL {
            self.backend
                .delete(&format!("{project_id}/{environment_id}/{host_id}/{kind}"))?;
        }
        Ok(())
    }

    /// Deletes what a removed environment left in the keychain: its secret variables
    /// (`var/env/{environmentId}/{name}`) and the saved secrets of `host_ids` for it
    /// (`conn/{hostId}/{environmentId}/{kind}`). A non-canonical environment id is refused;
    /// invalid names and host ids are skipped. Keeps going after a failure and reports it.
    pub fn delete_legacy_environment(
        &self,
        environment_id: &str,
        secret_variables: &[String],
        host_ids: &[String],
    ) -> Result<(), SecretError> {
        if !is_uuid(environment_id) {
            return Err(SecretError::InvalidScope);
        }
        let variables = secret_variables
            .iter()
            .filter(|n| is_valid_name(n))
            .map(|n| format!("var/env/{environment_id}/{n}"));
        let saved = host_ids.iter().filter(|h| is_uuid(h)).flat_map(|h| {
            SecretKind::ALL
                .into_iter()
                .map(move |kind| format!("conn/{h}/{environment_id}/{kind}"))
        });
        let mut result = Ok(());
        for account in variables.chain(saved) {
            if let Err(e) = self.backend.delete(&account) {
                result = Err(e);
            }
        }
        result
    }

    /// Reads a secret variable of a removed environment, to move it into its project.
    pub fn get_legacy_env_var(
        &self,
        environment_id: &str,
        name: &str,
    ) -> Result<Option<SecretString>, SecretError> {
        if !is_uuid(environment_id) || !is_valid_name(name) {
            return Err(SecretError::InvalidScope);
        }
        self.backend
            .get(&format!("var/env/{environment_id}/{name}"))
    }

    pub fn keychain() -> Self {
        Self::new(Arc::new(keychain::KeychainBackend))
    }

    pub fn get_var(&self, key: &VarKey) -> Result<Option<SecretString>, SecretError> {
        self.backend.get(key.account())
    }

    pub fn has_var(&self, key: &VarKey) -> Result<bool, SecretError> {
        Ok(self.get_var(key)?.is_some())
    }

    pub fn set_var(&self, key: &VarKey, value: &SecretString) -> Result<(), SecretError> {
        if !fits_keychain(value) {
            return Err(SecretError::TooLong);
        }
        self.backend.set(key.account(), value)
    }

    pub fn delete_var(&self, key: &VarKey) -> Result<(), SecretError> {
        self.backend.delete(key.account())
    }

    pub fn get_key_passphrase(
        &self,
        key: &KeyPassKey,
    ) -> Result<Option<SecretString>, SecretError> {
        self.backend.get(key.account())
    }

    /// keyring has no existence check that skips the value, so it is read into a
    /// `SecretString` and zeroized right away.
    pub fn has_key_passphrase(&self, key: &KeyPassKey) -> Result<bool, SecretError> {
        Ok(self.get_key_passphrase(key)?.is_some())
    }

    pub fn set_key_passphrase(
        &self,
        key: &KeyPassKey,
        value: &SecretString,
    ) -> Result<(), SecretError> {
        if !fits_keychain(value) {
            return Err(SecretError::TooLong);
        }
        self.backend.set(key.account(), value)
    }

    pub fn delete_key_passphrase(&self, key: &KeyPassKey) -> Result<(), SecretError> {
        self.backend.delete(key.account())
    }

    fn read_saved(&self, key: &SavedKey, kind: SecretKind) -> Result<Option<SavedIn>, SecretError> {
        let account = key.account(kind);
        let Some(raw) = self.backend.get(&account)? else {
            return Ok(None);
        };
        match serde_json::from_str::<SavedIn>(raw.expose_secret()) {
            Ok(saved) => Ok(Some(saved)),
            Err(_) => {
                self.backend.delete(&account)?;
                Ok(None)
            }
        }
    }

    /// An entry bound to another target (the host or its variables changed since it was
    /// saved) counts as absent and is deleted.
    pub fn get_saved(
        &self,
        key: &SavedKey,
        kind: SecretKind,
        target: &str,
    ) -> Result<Option<SecretString>, SecretError> {
        match self.read_saved(key, kind)? {
            Some(saved) if saved.target == target => Ok(Some(saved.secret)),
            Some(_) => {
                self.backend.delete(&key.account(kind))?;
                Ok(None)
            }
            None => Ok(None),
        }
    }

    /// Like `get_saved` but never deletes: a mismatched or unparseable entry reads as absent
    /// and stays, so testing an edited, unsaved form cannot drop the host's saved secret.
    pub fn peek_saved(
        &self,
        key: &SavedKey,
        kind: SecretKind,
        target: &str,
    ) -> Result<Option<SecretString>, SecretError> {
        let Some(raw) = self.backend.get(&key.account(kind))? else {
            return Ok(None);
        };
        Ok(serde_json::from_str::<SavedIn>(raw.expose_secret())
            .ok()
            .filter(|saved| saved.target == target)
            .map(|saved| saved.secret))
    }

    pub fn set_saved(
        &self,
        key: &SavedKey,
        kind: SecretKind,
        target: &str,
        value: &SecretString,
    ) -> Result<(), SecretError> {
        let encoded = encode_saved(target, value).ok_or(SecretError::TooLong)?;
        if !fits_keychain(&encoded) {
            return Err(SecretError::TooLong);
        }
        self.backend.set(&key.account(kind), &encoded)
    }

    /// Whether an entry exists; the value is read (keyring has no existence check) and
    /// dropped at once.
    pub fn has_saved(&self, key: &SavedKey, kind: SecretKind) -> Result<bool, SecretError> {
        Ok(self.backend.get(&key.account(kind))?.is_some())
    }

    pub fn delete_saved(&self, key: &SavedKey, kind: SecretKind) -> Result<(), SecretError> {
        self.backend.delete(&key.account(kind))
    }

    /// Drops a saved secret the server or the key file rejected, unless it was replaced
    /// meanwhile (another connect may have saved a working one).
    pub fn forget_saved_if_unchanged(
        &self,
        key: &SavedKey,
        kind: SecretKind,
        target: &str,
        rejected: &SecretString,
    ) -> Result<(), SecretError> {
        let unchanged = matches!(
            self.read_saved(key, kind)?,
            Some(s) if s.target == target && s.secret.expose_secret() == rejected.expose_secret()
        );
        if unchanged {
            self.delete_saved(key, kind)?;
        }
        Ok(())
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
        ops: Mutex<Vec<String>>,
        fail_ops: Mutex<Vec<String>>,
        case_insensitive: AtomicBool,
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

        pub fn raw(&self, account: &str) -> Option<String> {
            self.entries
                .lock()
                .unwrap()
                .get(&self.key(account))
                .map(|v| v.expose_secret().to_owned())
        }

        /// Every backend call so far, as `get|set|delete {account}`.
        pub fn ops(&self) -> Vec<String> {
            self.ops.lock().unwrap().clone()
        }

        /// Accounts compare case-insensitively, like Windows credential target names.
        pub fn set_case_insensitive(&self, on: bool) {
            self.case_insensitive.store(on, Ordering::SeqCst);
        }

        /// Makes exactly these calls (`get|set|delete {account}`) fail as unavailable.
        pub fn fail_on(&self, ops: &[String]) {
            *self.fail_ops.lock().unwrap() = ops.to_vec();
        }

        fn key(&self, account: &str) -> String {
            if self.case_insensitive.load(Ordering::SeqCst) {
                account.to_lowercase()
            } else {
                account.to_owned()
            }
        }

        fn record(&self, op: &str, account: &str) -> Result<String, SecretError> {
            let call = format!("{op} {account}");
            self.ops.lock().unwrap().push(call.clone());
            if self.fail_ops.lock().unwrap().contains(&call) {
                return Err(SecretError::Unavailable);
            }
            Ok(self.key(account))
        }

        pub fn put_raw(&self, account: &str, value: &str) {
            self.entries
                .lock()
                .unwrap()
                .insert(self.key(account), SecretString::from(value));
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
            let account = self.record("get", account)?;
            Ok(self
                .entries()?
                .get(&account)
                .map(|v| SecretString::from(v.expose_secret())))
        }

        fn set(&self, account: &str, value: &SecretString) -> Result<(), SecretError> {
            let account = self.record("set", account)?;
            self.entries()?
                .insert(account, SecretString::from(value.expose_secret()));
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), SecretError> {
            let account = self.record("delete", account)?;
            self.entries()?.remove(&account);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "00000000-0000-4000-8000-000000000001";
    const E: &str = "00000000-0000-4000-8000-000000000002";
    const H: &str = "00000000-0000-4000-8000-00000000000a";

    fn s(v: &str) -> SecretString {
        SecretString::from(v)
    }

    fn expose(v: Option<SecretString>) -> Option<String> {
        v.map(|v| v.expose_secret().to_owned())
    }

    #[test]
    fn variable_accounts() {
        assert_eq!(VarKey::global("pw").unwrap().account(), "var/global/pw");
        assert_eq!(
            VarKey::project(P, "pw").unwrap().account(),
            format!("var/project/{P}/pw")
        );
        assert_eq!(
            VarKey::global("a.b-c").unwrap().account(),
            "var/global/a.b-c"
        );
    }

    #[test]
    fn variable_keys_reject_bad_ids_and_names() {
        for bad in ["", "a/b", "9x", "a b", "../x"] {
            assert_eq!(VarKey::global(bad), Err(SecretError::InvalidScope), "{bad}");
        }
        assert_eq!(VarKey::project("p", "x"), Err(SecretError::InvalidScope));
        assert_eq!(
            VarKey::project(&format!("{P}/x"), "x"),
            Err(SecretError::InvalidScope)
        );
        assert_eq!(SecretError::InvalidScope.code(), "invalid_input");
    }

    #[test]
    fn saved_accounts() {
        assert_eq!(
            SavedKey::new(H).unwrap().account(SecretKind::Password),
            format!("conn/{H}/none/password")
        );
        assert_eq!(
            SavedKey::new(H).unwrap().account(SecretKind::Passphrase),
            format!("conn/{H}/none/passphrase")
        );
        assert_eq!(SavedKey::new("h"), Err(SecretError::InvalidScope));
        assert_eq!(SavedKey::new("none"), Err(SecretError::InvalidScope));
    }

    #[test]
    fn variable_round_trip_and_limit() {
        let (store, mem) = MemoryBackend::store();
        let k = VarKey::global("pw").unwrap();
        assert!(!store.has_var(&k).unwrap());
        store.set_var(&k, &s("hunter2")).unwrap();
        assert!(store.has_var(&k).unwrap());
        assert_eq!(
            expose(store.get_var(&k).unwrap()).as_deref(),
            Some("hunter2")
        );
        assert_eq!(mem.raw("var/global/pw").as_deref(), Some("hunter2"));
        store
            .set_var(&k, &s(&"a".repeat(MAX_SECRET_UTF16_UNITS)))
            .unwrap();
        assert_eq!(
            store.set_var(&k, &s(&"a".repeat(MAX_SECRET_UTF16_UNITS + 1))),
            Err(SecretError::TooLong)
        );
        let astral = "😀".repeat(MAX_SECRET_UTF16_UNITS / 2 + 1);
        assert!(!fits_keychain(&s(&astral)));
        store.delete_var(&k).unwrap();
        store.delete_var(&k).unwrap();
        assert!(mem.accounts().is_empty());
    }

    #[test]
    fn saved_secret_is_bound_to_its_target() {
        let (store, mem) = MemoryBackend::store();
        let k = SavedKey::new(H).unwrap();
        let pw = SecretKind::Password;
        store.set_saved(&k, pw, "me@a:22", &s("hunter2")).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&mem.raw(&k.account(pw)).unwrap()).unwrap();
        assert_eq!(
            raw,
            serde_json::json!({"target":"me@a:22","secret":"hunter2"})
        );
        assert_eq!(
            expose(store.get_saved(&k, pw, "me@a:22").unwrap()).as_deref(),
            Some("hunter2")
        );
        assert!(
            store
                .get_saved(&k, SecretKind::Passphrase, "me@a:22")
                .unwrap()
                .is_none()
        );
        assert!(store.get_saved(&k, pw, "me@b:22").unwrap().is_none());
        assert!(mem.accounts().is_empty());
    }

    #[test]
    fn saved_secret_with_escaped_characters_round_trips() {
        let (store, _) = MemoryBackend::store();
        let k = SavedKey::new(H).unwrap();
        let tricky = "\"\\\u{1}\u{1f}\n\té😀";
        let target = "me@\"h\":22";
        store
            .set_saved(&k, SecretKind::Password, target, &s(tricky))
            .unwrap();
        assert_eq!(
            expose(store.get_saved(&k, SecretKind::Password, target).unwrap()).as_deref(),
            Some(tricky)
        );
        let worst = "\u{1}".repeat(200);
        let encoded = encode_saved(&worst, &s(&worst)).unwrap();
        assert_eq!(encoded.expose_secret().len(), 2 * 200 * 6 + 25);
    }

    #[test]
    fn malformed_saved_entry_is_absent_and_deleted() {
        let (store, mem) = MemoryBackend::store();
        let k = SavedKey::new(H).unwrap();
        mem.put_raw(&k.account(SecretKind::Password), "plain old secret");
        assert!(
            store
                .get_saved(&k, SecretKind::Password, "t")
                .unwrap()
                .is_none()
        );
        assert!(mem.accounts().is_empty());
    }

    #[test]
    fn saved_size_counts_the_encoding() {
        let (store, mem) = MemoryBackend::store();
        let k = SavedKey::new(H).unwrap();
        let quotes = s(&"\"".repeat(700));
        assert!(fits_keychain(&quotes));
        assert!(!fits_saved("t", &quotes));
        assert_eq!(
            store.set_saved(&k, SecretKind::Password, "t", &quotes),
            Err(SecretError::TooLong)
        );
        assert!(fits_saved("t", &s("short")));
        assert!(!fits_saved(&"k".repeat(1300), &s("short")));
        assert!(mem.accounts().is_empty());
    }

    #[test]
    fn forget_saved_only_if_unchanged() {
        let (store, _) = MemoryBackend::store();
        let k = SavedKey::new(H).unwrap();
        let pw = SecretKind::Password;
        store.set_saved(&k, pw, "t", &s("new")).unwrap();
        store
            .forget_saved_if_unchanged(&k, pw, "t", &s("old"))
            .unwrap();
        assert!(store.get_saved(&k, pw, "t").unwrap().is_some());
        store
            .forget_saved_if_unchanged(&k, pw, "t", &s("new"))
            .unwrap();
        assert!(store.get_saved(&k, pw, "t").unwrap().is_none());
    }

    #[test]
    fn unavailable_backend_reports_a_safe_error() {
        let (store, mem) = MemoryBackend::store();
        mem.set_failing(true);
        let k = VarKey::global("pw").unwrap();
        let err = store.has_var(&k).unwrap_err();
        assert_eq!(err, SecretError::Unavailable);
        assert_eq!(err.code(), "keychain_unavailable");
        let saved = SavedKey::new(H).unwrap();
        assert_eq!(
            store.set_saved(&saved, SecretKind::Password, "t", &s("x")),
            Err(SecretError::Unavailable)
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
        assert!(!format!("{:?}", s("hunter2")).contains("hunter2"));
    }

    #[test]
    fn only_canonical_uuids_are_accepted() {
        assert_eq!(
            SavedKey::new(&H.to_uppercase()),
            Err(SecretError::InvalidScope)
        );
        assert_eq!(
            VarKey::project("00000000000040008000000000000001", "x"),
            Err(SecretError::InvalidScope)
        );
        assert_eq!(
            VarKey::project(&format!("{{{P}}}"), "x"),
            Err(SecretError::InvalidScope)
        );
        assert_eq!(
            VarKey::project(&format!("urn:uuid:{P}"), "x"),
            Err(SecretError::InvalidScope)
        );
        assert!(VarKey::project(P, "x").is_ok());
    }

    #[test]
    fn legacy_accounts_are_deleted() {
        let (store, mem) = MemoryBackend::store();
        for kind in ["password", "passphrase"] {
            mem.put_raw(&format!("{P}/{E}/{H}/{kind}"), "old");
        }
        mem.put_raw("var/global/keep", "x");
        store.delete_legacy(P, E, H).unwrap();
        assert_eq!(mem.accounts(), vec!["var/global/keep".to_string()]);
        assert_eq!(
            store.delete_legacy("p", E, H),
            Err(SecretError::InvalidScope)
        );
    }

    #[test]
    fn legacy_environment_accounts_are_deleted() {
        let (store, mem) = MemoryBackend::store();
        let other = "00000000-0000-4000-8000-0000000000e9";
        let keep = [
            format!("conn/{H}/none/password"),
            format!("var/env/{other}/pw"),
            format!("conn/{H}/{other}/password"),
            format!("var/project/{P}/pw"),
        ];
        let gone = [
            format!("var/env/{E}/pw"),
            format!("var/env/{E}/a.b"),
            format!("conn/{H}/{E}/password"),
            format!("conn/{H}/{E}/passphrase"),
        ];
        for a in keep.iter().chain(&gone) {
            mem.put_raw(a, "x");
        }
        store
            .delete_legacy_environment(
                E,
                &["pw".into(), "a.b".into(), "../x".into()],
                &[H.into(), "h/../x".into()],
            )
            .unwrap();
        let mut left = mem.accounts();
        left.sort();
        let mut expected = keep.to_vec();
        expected.sort();
        assert_eq!(left, expected);
        assert_eq!(
            store.delete_legacy_environment("none", &["pw".into()], &[H.into()]),
            Err(SecretError::InvalidScope)
        );
        assert_eq!(
            store.delete_legacy_environment("0000000A-0000-4000-8000-000000000002", &[], &[]),
            Err(SecretError::InvalidScope)
        );
        mem.set_failing(true);
        assert_eq!(
            store.delete_legacy_environment(E, &["pw".into()], &[]),
            Err(SecretError::Unavailable)
        );
    }

    #[test]
    fn legacy_environment_variables_are_read_by_checked_account() {
        let (store, mem) = MemoryBackend::store();
        mem.put_raw(&format!("var/env/{E}/pw"), "v");
        assert_eq!(
            expose(store.get_legacy_env_var(E, "pw").unwrap()).as_deref(),
            Some("v")
        );
        assert!(store.get_legacy_env_var(E, "nope").unwrap().is_none());
        for (env, name) in [
            ("none", "pw"),
            (E, "../pw"),
            ("0000000A-0000-4000-8000-000000000002", "pw"),
        ] {
            assert_eq!(
                store.get_legacy_env_var(env, name).err(),
                Some(SecretError::InvalidScope)
            );
        }
    }

    #[test]
    fn key_passphrase_round_trip() {
        let (store, mem) = MemoryBackend::store();
        let k = KeyPassKey::new(H).unwrap();
        assert_eq!(k.account(), format!("key/{H}/passphrase"));
        assert!(!store.has_key_passphrase(&k).unwrap());
        store.set_key_passphrase(&k, &s("pp")).unwrap();
        assert_eq!(
            expose(store.get_key_passphrase(&k).unwrap()).as_deref(),
            Some("pp")
        );
        assert_eq!(
            store.set_key_passphrase(&k, &s(&"a".repeat(MAX_SECRET_UTF16_UNITS + 1))),
            Err(SecretError::TooLong)
        );
        store.delete_key_passphrase(&k).unwrap();
        assert!(mem.accounts().is_empty());
        assert_eq!(KeyPassKey::new("k/x"), Err(SecretError::InvalidScope));
        assert_eq!(
            KeyPassKey::new(&H.to_uppercase()),
            Err(SecretError::InvalidScope)
        );
    }

    #[test]
    fn project_ids_are_distinct_accounts() {
        let a = VarKey::project(P, "x").unwrap();
        let b = VarKey::project(E, "x").unwrap();
        assert_ne!(a.account(), b.account());
    }
}
