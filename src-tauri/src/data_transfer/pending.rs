use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use uuid::Uuid;

use super::backup::Backup;
use super::format::DataFile;
use crate::config::Revision;

pub const TTL: Duration = Duration::from_secs(15 * 60);

/// What an undo needs: the backup and the file the import wrote.
#[derive(Debug, Clone)]
pub struct AppliedState {
    pub backup: Backup,
    pub revision: Revision,
}

/// One parsed file waiting for apply, then for undo. Holds no secret: a file that carried one
/// was refused.
#[derive(Debug, Clone)]
pub struct Pending {
    pub id: String,
    pub file_name: String,
    pub file: Arc<DataFile>,
    pub revision: Revision,
    pub applied: Option<AppliedState>,
    touched: Instant,
}

#[derive(Debug)]
pub struct PendingImports {
    slot: Mutex<Option<Pending>>,
    ttl: Duration,
}

impl Default for PendingImports {
    fn default() -> Self {
        Self::with_ttl(TTL)
    }
}

impl PendingImports {
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            slot: Mutex::new(None),
            ttl,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Pending>> {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|p| p.touched.elapsed() > self.ttl)
        {
            *slot = None;
        }
        slot
    }

    /// Replaces any earlier pending import.
    pub fn start(&self, file_name: String, file: DataFile, revision: Revision) -> String {
        let id = Uuid::new_v4().to_string();
        *self.lock() = Some(Pending {
            id: id.clone(),
            file_name,
            file: Arc::new(file),
            revision,
            applied: None,
            touched: Instant::now(),
        });
        id
    }

    pub fn get(&self, id: &str) -> Option<Pending> {
        self.lock().as_ref().filter(|p| p.id == id).cloned()
    }

    /// Runs `f` on the pending import `id`; false when it is unknown or expired.
    pub fn update(&self, id: &str, f: impl FnOnce(&mut Pending)) -> bool {
        let mut slot = self.lock();
        match slot.as_mut().filter(|p| p.id == id) {
            Some(p) => {
                f(p);
                p.touched = Instant::now();
                true
            }
            None => false,
        }
    }

    pub fn cancel(&self, id: &str) {
        let mut slot = self.lock();
        if slot.as_ref().is_some_and(|p| p.id == id) {
            *slot = None;
        }
    }

    pub fn clear(&self) {
        *self.lock() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_transfer::format::{FORMAT, FileScope, VERSION};

    fn file() -> DataFile {
        DataFile {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: None,
            app_version: None,
            scope: FileScope::All,
            variables: Vec::new(),
            projects: Vec::new(),
            nodes: Vec::new(),
            keys: Vec::new(),
        }
    }

    #[test]
    fn one_pending_import_at_a_time_that_expires() {
        let p = PendingImports::default();
        let a = p.start("a.json".into(), file(), Revision::of(None));
        let b = p.start("b.json".into(), file(), Revision::of(None));
        assert!(p.get(&a).is_none());
        assert_eq!(p.get(&b).unwrap().file_name, "b.json");
        p.cancel(&a);
        assert!(p.get(&b).is_some());
        p.cancel("unknown");
        p.cancel(&b);
        assert!(p.get(&b).is_none());
        assert!(!p.update(&b, |_| {}));

        let short = PendingImports::with_ttl(Duration::from_millis(1));
        let c = short.start("c.json".into(), file(), Revision::of(None));
        std::thread::sleep(Duration::from_millis(20));
        assert!(short.get(&c).is_none());
    }
}
