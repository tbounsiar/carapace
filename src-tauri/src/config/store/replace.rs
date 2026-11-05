use sha2::{Digest, Sha256};

use super::super::model::ConfigFile;
use super::super::validate;
use super::{ConfigError, ConfigStore, FILE_NAME, Probe, TMP_NAME, VERSION};

/// Identity of the bytes of `data.json` (SHA-256; an absent file has its own value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision([u8; 32]);

impl Revision {
    pub fn of(bytes: Option<&[u8]>) -> Self {
        let mut h = Sha256::new();
        match bytes {
            Some(b) => {
                h.update([1u8]);
                h.update(b);
            }
            None => h.update([0u8]),
        }
        Self(h.finalize().into())
    }
}

/// What replacing the data wrote: the closure outputs and the revision of the new file.
#[derive(Debug)]
pub struct Replaced<T, B> {
    pub output: T,
    pub before: B,
    pub revision: Revision,
}

impl ConfigStore {
    /// Must be called with the lock held, after `load` (which may rewrite the file).
    fn current(&self) -> Result<(Option<Vec<u8>>, Revision), ConfigError> {
        let raw = self.read_capped(FILE_NAME)?;
        let revision = Revision::of(raw.as_deref());
        Ok((raw, revision))
    }

    /// The data and the revision of the file it was read from.
    pub fn snapshot_revision(&self) -> Result<(ConfigFile, Revision), ConfigError> {
        let _guard = self.guard()?;
        let cfg = self.load()?;
        let (_, revision) = self.current()?;
        Ok((cfg, revision))
    }

    /// Replaces the whole data in one write, only while `data.json` is still at `expected`
    /// (else `Changed`). `build` computes the new data from the current one; it is checked
    /// with the structural invariants, then `before_save` gets the current file's bytes (the
    /// default document when there is no file yet) and runs before anything is written: its
    /// error leaves the file as it was.
    pub fn replace_data<T, B>(
        &self,
        expected: &Revision,
        build: impl FnOnce(&ConfigFile) -> Result<(ConfigFile, T), ConfigError>,
        before_save: impl FnOnce(&[u8], &T) -> Result<B, ConfigError>,
    ) -> Result<Replaced<T, B>, ConfigError> {
        let _guard = self.guard()?;
        let cfg = self.load()?;
        let (raw, revision) = self.current()?;
        if &revision != expected {
            return Err(ConfigError::Changed);
        }
        let (mut new, output) = build(&cfg)?;
        new.version = VERSION;
        validate::structure(&new).map_err(ConfigError::InvalidInput)?;
        let raw = match raw {
            Some(r) => r,
            None => serde_json::to_vec_pretty(&cfg).map_err(|_| ConfigError::Io)?,
        };
        let before = before_save(&raw, &output)?;
        let json = serde_json::to_vec_pretty(&new).map_err(|_| ConfigError::Io)?;
        self.write_atomic(FILE_NAME, TMP_NAME, &json)?;
        Ok(Replaced {
            output,
            before,
            revision: Revision::of(Some(&json)),
        })
    }

    /// Writes `bytes` (an earlier `data.json`) back, only while the file is still at
    /// `expected` (else `Changed`). The bytes must be a valid data file (else `Corrupt`).
    /// `before_save` gets the current and the restored data before anything is written.
    /// Returns both.
    pub fn restore_data(
        &self,
        expected: &Revision,
        bytes: &[u8],
        before_save: impl FnOnce(&ConfigFile, &ConfigFile),
    ) -> Result<(ConfigFile, ConfigFile), ConfigError> {
        let _guard = self.guard()?;
        let cfg = self.load()?;
        let (_, revision) = self.current()?;
        if &revision != expected {
            return Err(ConfigError::Changed);
        }
        let probe: Probe = serde_json::from_slice(bytes).map_err(|_| ConfigError::Corrupt)?;
        if probe.version != VERSION || probe.has_environments() {
            return Err(ConfigError::Corrupt);
        }
        let restored: ConfigFile =
            serde_json::from_slice(bytes).map_err(|_| ConfigError::Corrupt)?;
        validate::structure(&restored).map_err(|_| ConfigError::Corrupt)?;
        before_save(&cfg, &restored);
        self.write_atomic(FILE_NAME, TMP_NAME, bytes)?;
        Ok((cfg, restored))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::model::{AuthMethod, HostInput};

    fn host(name: &str) -> HostInput {
        HostInput {
            name: name.into(),
            hostname: "h".into(),
            port: "22".into(),
            username: "u".into(),
            auth: AuthMethod::Agent,
        }
    }

    #[test]
    fn replace_checks_the_revision_and_runs_before_save_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let (_, empty) = store.snapshot_revision().unwrap();
        assert_eq!(empty, Revision::of(None));
        store.create_project("A").unwrap();
        let err = store
            .replace_data(&empty, |c| Ok((c.clone(), ())), |_, _| Ok(()))
            .unwrap_err();
        assert!(matches!(err, ConfigError::Changed));

        let (cfg, rev) = store.snapshot_revision().unwrap();
        let before = std::fs::read(dir.path().join(FILE_NAME)).unwrap();
        let failed = store.replace_data(
            &rev,
            |_| Ok((ConfigFile::default(), ())),
            |_, _| Err::<(), _>(ConfigError::Keychain),
        );
        assert!(matches!(failed, Err(ConfigError::Keychain)));
        assert_eq!(std::fs::read(dir.path().join(FILE_NAME)).unwrap(), before);

        let done = store
            .replace_data(
                &rev,
                |_| Ok((ConfigFile::default(), 7)),
                |raw, out| {
                    assert_eq!(*out, 7);
                    Ok(raw.to_vec())
                },
            )
            .unwrap();
        assert_eq!(done.before, before);
        assert!(store.snapshot().unwrap().projects.is_empty());
        assert_eq!(store.snapshot_revision().unwrap().1, done.revision);
        assert_eq!(cfg.projects.len(), 1);
    }

    #[test]
    fn replace_refuses_a_broken_structure() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let (_, rev) = store.snapshot_revision().unwrap();
        let err = store
            .replace_data(
                &rev,
                |c| {
                    let mut c = c.clone();
                    c.projects.push(crate::config::Project {
                        id: "NOT-AN-ID".into(),
                        name: "x".into(),
                        variables: Vec::new(),
                    });
                    Ok((c, ()))
                },
                |_, _| Ok(()),
            )
            .unwrap_err();
        assert!(matches!(err, ConfigError::InvalidInput(_)));
        assert!(!dir.path().join(FILE_NAME).exists());
    }

    #[test]
    fn restore_writes_the_bytes_back_while_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        store.create_host(None, None, &host("a")).unwrap();
        let old = std::fs::read(dir.path().join(FILE_NAME)).unwrap();
        store.create_host(None, None, &host("b")).unwrap();
        let (_, rev) = store.snapshot_revision().unwrap();

        assert!(matches!(
            store.restore_data(&rev, b"{\"version\":2}", |_, _| {}),
            Err(ConfigError::Corrupt)
        ));
        let mut seen = 0;
        let (cur, restored) = store
            .restore_data(&rev, &old, |a, b| {
                seen = a.nodes.len() * 10 + b.nodes.len();
            })
            .unwrap();
        assert_eq!(seen, 21);
        assert_eq!((cur.nodes.len(), restored.nodes.len()), (2, 1));
        assert_eq!(std::fs::read(dir.path().join(FILE_NAME)).unwrap(), old);
        assert!(matches!(
            store.restore_data(&rev, &old, |_, _| {}),
            Err(ConfigError::Changed)
        ));
    }
}
