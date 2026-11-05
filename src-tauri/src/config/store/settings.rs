use std::fs;
use std::io::{ErrorKind, Read};

use toml_edit::DocumentMut;

use super::{ConfigError, ConfigStore, SETTINGS_NAME};
use crate::config::model::{AnalyticsSettings, Category, CategoryChoice, ExternalEditor};
use crate::config::settings::{self, Settings, SettingsPatch};

const SETTINGS_TMP: &str = "settings.toml.tmp";
/// Far above anything the app writes; a larger file is not ours.
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;

enum SettingsFile {
    Missing,
    Valid(Settings, Box<DocumentMut>),
    /// Not UTF-8, not TOML, nested too deep, or too large. Only partly read when too large, so
    /// it is moved aside whole, never copied.
    Corrupt,
}

/// What a change does with a corrupt file.
#[derive(Clone, Copy, PartialEq, Eq)]
enum OnCorrupt {
    /// Rename it to `settings.toml.bak` and start from the defaults: an explicit user change.
    BackUp,
    /// Fail with `Corrupt` and write nothing.
    Refuse,
}

impl ConfigStore {
    fn read_settings(&self) -> Result<SettingsFile, ConfigError> {
        let file = match fs::File::open(self.dir.join(SETTINGS_NAME)) {
            Ok(f) => f,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(SettingsFile::Missing),
            Err(_) => return Err(ConfigError::Io),
        };
        let mut raw = Vec::new();
        file.take(MAX_SETTINGS_BYTES + 1)
            .read_to_end(&mut raw)
            .map_err(|_| ConfigError::Io)?;
        if raw.len() as u64 > MAX_SETTINGS_BYTES {
            return Ok(SettingsFile::Corrupt);
        }
        let doc = std::str::from_utf8(&raw)
            .ok()
            .and_then(|text| settings::parse_document(text).ok());
        Ok(match doc {
            Some(doc) => SettingsFile::Valid(settings::read(&doc), Box::new(doc)),
            None => SettingsFile::Corrupt,
        })
    }

    pub(super) fn save_settings(&self, s: &Settings) -> Result<(), ConfigError> {
        let text = settings::to_toml(s);
        self.write_atomic(SETTINGS_NAME, SETTINGS_TMP, text.as_bytes())
    }

    /// The preferences of a `config.json` not split yet are in that file: split it first, so
    /// they are never read as defaults (which would ask the analytics questions again) and a
    /// change is never written where the split would then keep it over the old values.
    fn settings_ready(&self) -> Result<(), ConfigError> {
        if self.split_pending()? {
            self.load()?;
        }
        Ok(())
    }

    /// A corrupt file is `Corrupt`; a missing one is all defaults.
    pub fn settings(&self) -> Result<Settings, ConfigError> {
        let _guard = self.guard()?;
        self.settings_ready()?;
        match self.read_settings()? {
            SettingsFile::Missing => Ok(Settings::default()),
            SettingsFile::Valid(s, _) => Ok(s),
            SettingsFile::Corrupt => Err(ConfigError::Corrupt),
        }
    }

    pub fn analytics(&self) -> Result<Option<AnalyticsSettings>, ConfigError> {
        self.settings().map(|s| s.analytics)
    }

    pub fn external_editor(&self) -> Result<Option<ExternalEditor>, ConfigError> {
        self.settings().map(|s| s.external_editor)
    }

    /// Read-modify-write of `settings.toml` under the store lock; `f` reports whether it changed
    /// anything, and the file is rewritten only then, with only the changed values edited in the
    /// existing document.
    fn change_settings<T>(
        &self,
        on_corrupt: OnCorrupt,
        f: impl FnOnce(&mut Settings) -> (T, bool),
    ) -> Result<T, ConfigError> {
        let _guard = self.guard()?;
        self.settings_ready()?;
        let (before, mut doc, corrupt) = match self.read_settings()? {
            SettingsFile::Missing => (Settings::default(), Box::default(), false),
            SettingsFile::Valid(s, doc) => (s, doc, false),
            SettingsFile::Corrupt if on_corrupt == OnCorrupt::Refuse => {
                return Err(ConfigError::Corrupt);
            }
            SettingsFile::Corrupt => (Settings::default(), Box::default(), true),
        };
        let mut current = before.clone();
        let (out, changed) = f(&mut current);
        if !changed {
            return Ok(out);
        }
        settings::write(&mut doc, &before, &current);
        let text = doc.to_string();
        // The new file is complete before the corrupt one is moved aside, so a failure leaves
        // the corrupt file in place (still reported, still unread) rather than no file at all.
        self.write_atomic_then(SETTINGS_NAME, SETTINGS_TMP, text.as_bytes(), || {
            if corrupt {
                self.move_aside(SETTINGS_NAME, SETTINGS_NAME)?;
                log::warn!("settings.toml was unreadable; kept as a backup and replaced");
            }
            Ok(())
        })?;
        Ok(out)
    }

    /// Applies these categories on top of what the file holds and returns the result; other
    /// categories keep their stored answer. A file that cannot be read is an error and nothing
    /// is written: its answers are unknown, so it is not replaced by an analytics change.
    pub fn update_analytics(
        &self,
        changes: &[(Category, CategoryChoice)],
    ) -> Result<AnalyticsSettings, ConfigError> {
        self.change_settings(OnCorrupt::Refuse, |s| {
            let old = s.analytics.unwrap_or_default();
            let mut value = old;
            for &(category, choice) in changes {
                value.categories.set(category, choice);
            }
            let changed = value != old;
            if changed {
                s.analytics = Some(value);
            }
            (value, changed)
        })
    }

    /// Rewrites the file only when the value changes.
    pub fn set_external_editor(&self, value: ExternalEditor) -> Result<(), ConfigError> {
        self.change_settings(OnCorrupt::BackUp, |s| {
            let changed = s.external_editor.as_ref() != Some(&value);
            s.external_editor = Some(value);
            ((), changed)
        })
    }

    /// The patch is validated by the caller.
    pub fn update_settings(&self, patch: &SettingsPatch) -> Result<Settings, ConfigError> {
        self.change_settings(OnCorrupt::BackUp, |s| {
            let before = s.clone();
            s.apply(patch);
            let changed = *s != before;
            (s.clone(), changed)
        })
    }

    /// Once only: the values the file does not hold yet, then `legacy_imported` is set and later
    /// calls change nothing. Not a user change, so a corrupt file is refused.
    pub fn import_legacy_settings(&self, values: &SettingsPatch) -> Result<Settings, ConfigError> {
        self.change_settings(OnCorrupt::Refuse, |s| {
            if s.legacy_imported {
                return (s.clone(), false);
            }
            s.fill(values);
            s.legacy_imported = true;
            (s.clone(), true)
        })
    }
}

#[cfg(test)]
mod tests;
