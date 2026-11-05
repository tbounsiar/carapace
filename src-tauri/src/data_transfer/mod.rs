//! Export of the user's data to a `carapace-data` file and import of one (matching, three
//! strategies, backup, undo). Independent of Tauri and of the keychain: the command layer
//! passes keychain lookups in and runs the keychain deletes the plan lists.

pub mod backup;
pub mod export;
pub mod format;
pub mod pending;
pub mod plan;

use std::collections::HashSet;
use std::path::Path;
use std::time::SystemTime;

use crate::config::{ConfigError, ConfigFile, ConfigStore, Revision};
use crate::keys::{self, KeyError};
use crate::text::Text;
use backup::Backup;
use format::{DataFile, FileKey};
use plan::{Context, KeyProbe, KeychainWork, Outcome, Strategy, VarAccount};

#[cfg(all(feature = "e2e-pickers", not(debug_assertions)))]
compile_error!("the e2e-pickers feature is for debug end-to-end builds only");

/// A UTC calendar time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

impl Stamp {
    pub fn of(t: SystemTime) -> Self {
        let secs = t
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()) as i64;
        let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
        // Days to civil date (H. Hinnant's algorithm).
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let year = yoe + era * 400 + i64::from(month <= 2);
        Self {
            year,
            month,
            day,
            hour: (rest / 3600) as u32,
            minute: (rest % 3600 / 60) as u32,
            second: (rest % 60) as u32,
        }
    }

    pub fn rfc3339(&self) -> String {
        format!(
            "{}T{:02}:{:02}:{:02}Z",
            self.date(),
            self.hour,
            self.minute,
            self.second
        )
    }

    pub fn date(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    pub fn compact(&self) -> String {
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}

/// Inspects the key file of every entry as `import_key` does (bounded read, OpenSSH only,
/// Ed25519 or RSA >= 2048, no passphrase needed). A file path is attacker-chosen: only paths
/// under the home directory or equal to a registered key path are touched, and only when
/// every link on the way stays local (no outbound authentication). Blocking.
pub fn probe_keys(keys: &[FileKey], registered: &[String], home: Option<&Path>) -> Vec<KeyProbe> {
    keys.iter()
        .map(|k| {
            if !may_probe(&k.path, registered, home) {
                return KeyProbe::Refused;
            }
            match keys::inspect(&k.path, None) {
                Ok((path, info)) => match path.to_str() {
                    Some(p) if info.algorithm == k.algorithm => KeyProbe::Found(p.to_owned(), info),
                    Some(_) => KeyProbe::Mismatch,
                    None => KeyProbe::Missing,
                },
                Err(KeyError::InvalidInput(_) | KeyError::TooLarge(_)) => KeyProbe::Mismatch,
                Err(_) => KeyProbe::Missing,
            }
        })
        .collect()
}

fn may_probe(raw: &str, registered: &[String], home: Option<&Path>) -> bool {
    let Some(path) = crate::fsutil::expand_local(raw) else {
        return false;
    };
    let known = path
        .to_str()
        .is_some_and(|p| registered.iter().any(|r| crate::config::same_path(r, p)));
    (known || home.is_some_and(|h| export::under(&path, h)))
        && crate::fsutil::links_stay_local(&path)
}

pub struct Inputs<'a> {
    pub file: &'a DataFile,
    pub keys: &'a [KeyProbe],
    pub connected: &'a HashSet<String>,
    pub has_value: &'a dyn Fn(&VarAccount) -> bool,
}

impl Inputs<'_> {
    fn context<'a>(&'a self, local: &'a ConfigFile) -> Context<'a> {
        Context {
            local,
            file: self.file,
            keys: self.keys,
            connected: self.connected,
            has_value: self.has_value,
        }
    }
}

/// The three plans against `local`.
pub fn preview(local: &ConfigFile, inputs: &Inputs<'_>) -> [Outcome; 3] {
    let ctx = inputs.context(local);
    Strategy::ALL.map(|s| plan::plan(&ctx, s))
}

#[derive(Debug)]
pub struct Applied {
    pub outcome: Outcome,
    pub backup: Backup,
    pub revision: Revision,
}

#[derive(Debug)]
pub enum ApplyError {
    /// The plan on the current data has blocking reasons; nothing was written.
    Blocked(Text),
    Data(ConfigError),
}

impl From<ConfigError> for ApplyError {
    fn from(e: ConfigError) -> Self {
        Self::Data(e)
    }
}

/// Writes the import in one store transaction, only while `data.json` is still at `expected`:
/// the plan is computed again on the current data, refused when blocked, then the backup is
/// written (failure: `Io`, nothing changed), then `keychain` runs the deletes (failure: nothing
/// written), then the file is saved.
pub fn apply(
    store: &ConfigStore,
    inputs: &Inputs<'_>,
    expected: &Revision,
    strategy: Strategy,
    now: SystemTime,
    keychain: impl FnOnce(&KeychainWork) -> Result<(), ConfigError>,
) -> Result<Applied, ApplyError> {
    let home = store.dir().to_path_buf();
    let mut blocked = None;
    let done = store.replace_data(
        expected,
        |current| {
            let out = plan::plan(&inputs.context(current), strategy);
            if !out.plan.blocking.is_empty() {
                blocked = Some(crate::text!(
                    "errors.dataTransfer.importBlocked",
                    "This import cannot be done with {strategy}: {reasons}.",
                    strategy = strategy,
                    reasons = format::TextList {
                        items: out.plan.blocking,
                        separator: "; ",
                    }
                ));
                // Any error stops the transaction; `blocked` replaces it below.
                return Err(ConfigError::Changed);
            }
            Ok((out.result.clone(), out))
        },
        |raw, out| {
            let backup = backup::write(&home, raw, now).map_err(|_| {
                log::warn!("could not write the data backup; nothing was imported");
                ConfigError::Io
            })?;
            keychain(&out.keychain)?;
            Ok(backup)
        },
    );
    if let Some(reason) = blocked {
        return Err(ApplyError::Blocked(reason));
    }
    let done = done?;
    Ok(Applied {
        outcome: done.output,
        backup: done.before,
        revision: done.revision,
    })
}

/// Whether `target` (a file to write) is inside the app home, which holds `data.json`,
/// `settings.toml`, `known_hosts`, `keys/` and the backups.
pub fn inside_home(target_dir: &Path, home: &Path) -> bool {
    let canon = |p: &Path| crate::fsutil::canonical(p).unwrap_or_else(|_| p.to_path_buf());
    let (dir, home) = (canon(target_dir), canon(home));
    let (Some(d), Some(h)) = (dir.to_str(), home.to_str()) else {
        return true;
    };
    let (d, h) = if cfg!(windows) {
        (
            d.to_lowercase().replace('/', "\\"),
            h.to_lowercase().replace('/', "\\"),
        )
    } else {
        (d.to_owned(), h.to_owned())
    };
    let h = h.trim_end_matches(['/', '\\']);
    d == h
        || d.strip_prefix(h)
            .is_some_and(|r| r.starts_with(['/', '\\']))
}

#[cfg(test)]
mod tests;
