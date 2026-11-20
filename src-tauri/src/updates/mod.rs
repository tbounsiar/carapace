//! In-app updates: what was found, the downloaded package and who is told. Independent of the
//! running app: the plugin's update handle is a type parameter, so tests use a stand-in.

mod error;
mod version;

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::utils::config::BundleType;
use tokio::sync::oneshot;

use crate::config::Settings;
pub use error::{Stage, UpdateError, classify};
pub use version::is_plain_version;

pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const RELEASE_TAG_URL: &str = "https://github.com/tbounsiar/carapace/releases/tag/v";
/// Progress is sent every this many bytes (and at the end), not for every network chunk.
const PROGRESS_STEP: u64 = 256 * 1024;

/// The manifest's release notes are free text from the network and are not part of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateEvent {
    Available { info: UpdateInfo },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallKind {
    InPlace,
    DownloadOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub current: String,
    pub auto_check: bool,
    pub skipped_version: Option<String>,
    pub last_check: Option<String>,
    pub available: Option<UpdateInfo>,
    pub downloaded: bool,
    pub install_kind: InstallKind,
}

/// `false` when the event could not be delivered.
pub type Emit = Arc<dyn Fn(UpdateEvent) -> bool + Send + Sync>;

/// The update preferences as the checks use them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prefs {
    pub auto_check: bool,
    pub skipped: Option<String>,
}

impl Prefs {
    /// A `settings.toml` that cannot be read turns the automatic check off: the user may have
    /// turned it off in that file, and the check tells GitHub the address and the version.
    pub fn of(settings: Option<&Settings>) -> Self {
        match settings {
            Some(s) => Self {
                auto_check: s.updates.auto_check.unwrap_or(true),
                skipped: s.updates.skipped_version.clone(),
            },
            None => Self {
                auto_check: false,
                skipped: None,
            },
        }
    }
}

/// In place only where the plugin replaces the installed app by itself. A `.deb` or `.rpm`
/// install needs root: the plugin tries pkexec, then asks for the user's password in a
/// zenity/kdialog prompt and pipes it to `sudo -S`, then plain `sudo`; that password would pass
/// through a plugin string outside the app's secret handling, so those users get the release
/// page instead. An unbundled or debug build has no installer of its own to replace.
pub fn install_kind(bundle: Option<BundleType>, debug: bool) -> InstallKind {
    match bundle {
        _ if debug => InstallKind::DownloadOnly,
        Some(BundleType::Nsis | BundleType::Msi | BundleType::App | BundleType::AppImage) => {
            InstallKind::InPlace
        }
        _ => InstallKind::DownloadOnly,
    }
}

/// What the app holds that an update would end. Edited files not uploaded refuse it even when
/// the page confirmed: only the page's explicit forced stop may drop them.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenWork {
    pub transfers: bool,
    pub unsaved_editors: bool,
    pub unsynced_edits: bool,
}

pub fn may_apply(confirmed: bool, open: OpenWork) -> Result<(), UpdateError> {
    if open.unsynced_edits {
        return Err(UpdateError::NotUploaded);
    }
    if !confirmed && (open.transfers || open.unsaved_editors) {
        return Err(UpdateError::Unconfirmed);
    }
    Ok(())
}

/// Once the update ran the exit work, any failure leaves an app that must be restarted.
pub fn install_error(e: UpdateError, shutting_down: bool) -> UpdateError {
    if shutting_down {
        UpdateError::RestartRequired
    } else {
        e
    }
}

/// The release page of `version`, built here: never a URL from the manifest.
pub fn release_notes_url(version: &str) -> Result<String, UpdateError> {
    if !is_plain_version(version) {
        return Err(UpdateError::InvalidVersion);
    }
    Ok(format!("{RELEASE_TAG_URL}{version}"))
}

/// Turns network chunks into progress events, at most one per `PROGRESS_STEP`.
#[derive(Debug, Default)]
pub struct Meter {
    downloaded: u64,
    sent: Option<u64>,
}

impl Meter {
    pub fn add(&mut self, chunk: usize, total: Option<u64>) -> Option<Progress> {
        self.downloaded = self.downloaded.saturating_add(chunk as u64);
        let due = match self.sent {
            None => true,
            Some(sent) => self.downloaded - sent >= PROGRESS_STEP || Some(self.downloaded) == total,
        };
        due.then(|| {
            self.sent = Some(self.downloaded);
            Progress {
                downloaded: self.downloaded,
                total,
            }
        })
    }
}

struct Found<T> {
    info: UpdateInfo,
    handle: T,
}

enum Download {
    Idle,
    Running {
        generation: u64,
        cancel: Option<oneshot::Sender<()>>,
    },
    /// Verified by the plugin; for the version found.
    Done(Vec<u8>),
    Installing,
}

struct Inner<T> {
    found: Option<Found<T>>,
    last_check: Option<String>,
    subscriber: Option<Emit>,
    download: Download,
    generation: u64,
}

pub struct Updates<T> {
    current: String,
    kind: InstallKind,
    inner: Mutex<Inner<T>>,
}

/// What `begin_download` asks the caller to do.
pub enum Begin<T> {
    /// Download with `handle`, give up when `cancel` fires, then call `finish_download`.
    Start {
        handle: T,
        generation: u64,
        cancel: oneshot::Receiver<()>,
    },
    /// Already downloaded: this many bytes.
    Done(u64),
}

impl<T: Clone> Updates<T> {
    pub fn new(current: impl Into<String>, kind: InstallKind) -> Self {
        Self {
            current: current.into(),
            kind,
            inner: Mutex::new(Inner {
                found: None,
                last_check: None,
                subscriber: None,
                download: Download::Idle,
                generation: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<T>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn state(&self, prefs: &Prefs) -> UpdateState {
        let inner = self.lock();
        UpdateState {
            current: self.current.clone(),
            auto_check: prefs.auto_check,
            skipped_version: prefs.skipped.clone(),
            last_check: inner.last_check.clone(),
            available: inner.found.as_ref().map(|f| f.info.clone()),
            downloaded: matches!(inner.download, Download::Done(_)),
            install_kind: self.kind,
        }
    }

    /// Records a successful check made at `now`. While a download or an install runs, the
    /// update it works on stays; otherwise the result replaces what was found, and a package
    /// downloaded for another version is dropped.
    pub fn checked(&self, result: Option<(UpdateInfo, T)>, now: String) -> Option<UpdateInfo> {
        let mut inner = self.lock();
        inner.last_check = Some(now);
        let info = result.as_ref().map(|(info, _)| info.clone());
        if matches!(
            inner.download,
            Download::Running { .. } | Download::Installing
        ) {
            return info;
        }
        let same = match (&inner.found, &result) {
            (Some(old), Some((new, _))) => old.info.version == new.version,
            _ => false,
        };
        if !same {
            inner.download = Download::Idle;
        }
        inner.found = result.map(|(info, handle)| Found { info, handle });
        info
    }

    /// Tells the subscriber about the update found, unless it is the version the user skipped.
    pub fn notify(&self, skipped: Option<&str>) {
        let mut inner = self.lock();
        Self::announce(&mut inner, skipped);
    }

    fn announce(inner: &mut Inner<T>, skipped: Option<&str>) {
        let Some(found) = &inner.found else {
            return;
        };
        if skipped == Some(found.info.version.as_str()) {
            return;
        }
        let event = UpdateEvent::Available {
            info: found.info.clone(),
        };
        if let Some(emit) = &inner.subscriber
            && !emit(event)
        {
            inner.subscriber = None;
        }
    }

    /// A page that subscribes after the automatic check still hears about its result.
    pub fn subscribe(&self, emit: Emit, skipped: Option<&str>) {
        let mut inner = self.lock();
        inner.subscriber = Some(emit);
        Self::announce(&mut inner, skipped);
    }

    pub fn unsubscribe(&self) {
        self.lock().subscriber = None;
    }

    pub fn begin_download(&self) -> Result<Begin<T>, UpdateError> {
        if self.kind == InstallKind::DownloadOnly {
            return Err(UpdateError::Unsupported);
        }
        let mut inner = self.lock();
        match &inner.download {
            Download::Running { .. } | Download::Installing => return Err(UpdateError::Busy),
            Download::Done(bytes) => return Ok(Begin::Done(bytes.len() as u64)),
            Download::Idle => {}
        }
        let handle = match &inner.found {
            Some(found) => found.handle.clone(),
            None => return Err(UpdateError::NoUpdate),
        };
        inner.generation += 1;
        let generation = inner.generation;
        let (tx, rx) = oneshot::channel();
        inner.download = Download::Running {
            generation,
            cancel: Some(tx),
        };
        Ok(Begin::Start {
            handle,
            generation,
            cancel: rx,
        })
    }

    /// The bytes of a cancelled or superseded download are dropped.
    pub fn finish_download(
        &self,
        generation: u64,
        result: Result<Vec<u8>, UpdateError>,
    ) -> Result<(), UpdateError> {
        let mut inner = self.lock();
        let current = matches!(
            inner.download,
            Download::Running { generation: g, .. } if g == generation
        );
        if !current {
            return Err(UpdateError::Cancelled);
        }
        match result {
            Ok(bytes) => {
                inner.download = Download::Done(bytes);
                Ok(())
            }
            Err(e) => {
                inner.download = Download::Idle;
                Err(e)
            }
        }
    }

    /// `false` when no download was running.
    pub fn cancel_download(&self) -> bool {
        let mut inner = self.lock();
        let Download::Running { cancel, .. } = &mut inner.download else {
            return false;
        };
        if let Some(tx) = cancel.take() {
            let _ = tx.send(());
        }
        inner.download = Download::Idle;
        true
    }

    /// Hands out the package to install; `install_failed` gives it back.
    pub fn begin_install(&self) -> Result<(T, Vec<u8>), UpdateError> {
        if self.kind == InstallKind::DownloadOnly {
            return Err(UpdateError::Unsupported);
        }
        let mut inner = self.lock();
        let handle = inner.found.as_ref().map(|f| f.handle.clone());
        match (
            handle,
            std::mem::replace(&mut inner.download, Download::Installing),
        ) {
            (Some(handle), Download::Done(bytes)) => Ok((handle, bytes)),
            (_, other) => {
                let busy = matches!(other, Download::Running { .. } | Download::Installing);
                inner.download = match other {
                    Download::Done(_) => Download::Idle,
                    other => other,
                };
                Err(if busy {
                    UpdateError::Busy
                } else {
                    UpdateError::NothingDownloaded
                })
            }
        }
    }

    pub fn install_failed(&self, bytes: Option<Vec<u8>>) {
        let mut inner = self.lock();
        inner.download = bytes.map_or(Download::Idle, Download::Done);
    }
}

#[cfg(test)]
mod tests;
