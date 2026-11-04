//! Watches a copy's directory (so saves that write a temp file and rename it over the copy are
//! seen) and turns bursts of events into one settled save.

use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::time::timeout;

pub const QUIET: Duration = Duration::from_millis(500);

/// Stops watching when dropped, which also ends its debounce task.
pub struct Watch {
    _watcher: RecommendedWatcher,
}

fn relevant(kind: &EventKind) -> bool {
    match kind {
        // Reads (ours included, when hashing the copy) must not look like saves.
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

/// Sends `()` for every change touching `dir/name`.
pub fn watch(dir: &Path, name: &str, tx: mpsc::UnboundedSender<()>) -> notify::Result<Watch> {
    let name = name.to_owned();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else {
            // An overflow or a backend error may have hidden a save.
            let _ = tx.send(());
            return;
        };
        let ours = event.paths.is_empty()
            || event
                .paths
                .iter()
                .any(|p| p.file_name() == Some(OsStr::new(&name)));
        if ours && relevant(&event.kind) {
            let _ = tx.send(());
        }
    })?;
    watcher.watch(dir, RecursiveMode::NonRecursive)?;
    Ok(Watch { _watcher: watcher })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// First change of a burst.
    Seen,
    /// No change for `quiet` after the last one.
    Settled,
}

/// Runs until every sender is gone; a burst cut short that way never settles.
pub async fn debounce(
    mut rx: mpsc::UnboundedReceiver<()>,
    quiet: Duration,
    on: impl Fn(Signal) + Send,
) {
    while rx.recv().await.is_some() {
        on(Signal::Seen);
        loop {
            match timeout(quiet, rx.recv()).await {
                Ok(Some(())) => {}
                Ok(None) => return,
                Err(_) => break,
            }
        }
        on(Signal::Settled);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use super::*;

    fn recorder() -> (Arc<Mutex<Vec<Signal>>>, impl Fn(Signal) + Send) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        (seen, move |sig| s.lock().unwrap().push(sig))
    }

    #[tokio::test]
    async fn a_burst_settles_once_after_the_quiet_time() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (seen, on) = recorder();
        let quiet = Duration::from_millis(80);
        let task = tokio::spawn(debounce(rx, quiet, on));
        let start = Instant::now();
        for _ in 0..5 {
            tx.send(()).unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(*seen.lock().unwrap(), [Signal::Seen, Signal::Settled]);
        assert!(start.elapsed() >= quiet);
        tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(seen.lock().unwrap().len(), 4);
        drop(tx);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn closing_mid_burst_never_settles() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (seen, on) = recorder();
        let task = tokio::spawn(debounce(rx, Duration::from_secs(5), on));
        tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(tx);
        task.await.unwrap();
        assert_eq!(*seen.lock().unwrap(), [Signal::Seen]);
    }

    #[tokio::test]
    async fn saves_by_rename_are_seen_and_other_files_are_not() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.conf"), b"1").unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _w = watch(dir.path(), "a.conf", tx).unwrap();
        std::fs::write(dir.path().join("other"), b"x").unwrap();
        assert!(
            timeout(Duration::from_millis(400), rx.recv())
                .await
                .is_err()
        );
        std::fs::write(dir.path().join("a.conf.tmp"), b"2").unwrap();
        std::fs::rename(dir.path().join("a.conf.tmp"), dir.path().join("a.conf")).unwrap();
        let got = timeout(Duration::from_secs(5), rx.recv()).await;
        assert!(matches!(got, Ok(Some(()))));
    }
}
