//! Quit guard: while the page has unsaved editors, closing the main window (or quitting the
//! app) asks the page instead. The webview gets no window permission; Rust intercepts the close.
//! A page that does not answer cannot keep the app open: a second request while one is pending
//! asks the user directly with a native dialog.

use std::sync::{Arc, Mutex};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppEvent {
    QuitRequested,
}

/// `false` when the event could not be delivered.
pub type AppEmit = Arc<dyn Fn(AppEvent) -> bool + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Close or quit as usual.
    Proceed,
    /// The page was asked; keep the window open.
    Asked,
    /// Keep it open and show the native "quit anyway" dialog.
    Confirm,
    /// The native dialog is already showing; keep the window open.
    Wait,
}

#[derive(Default)]
struct Inner {
    active: bool,
    quitting: bool,
    /// The page was asked and has not answered (`set_quit_guard` or `quit_app`).
    pending: bool,
    confirming: bool,
    subscriber: Option<AppEmit>,
}

#[derive(Default)]
pub struct QuitGuard(Mutex<Inner>);

impl QuitGuard {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Also the page's answer to a quit request it declined.
    pub fn set_active(&self, active: bool) {
        let mut inner = self.lock();
        inner.active = active;
        inner.pending = false;
    }

    pub fn subscribe(&self, emit: AppEmit) {
        self.lock().subscriber = Some(emit);
    }

    /// For a close request on the main window or a quit request of the app. `unsynced`: some
    /// edited file has changes not uploaded, which guards like an unsaved editor.
    pub fn intercept(&self, unsynced: bool) -> Decision {
        let mut inner = self.lock();
        if inner.quitting || !(inner.active || unsynced) {
            return Decision::Proceed;
        }
        if inner.confirming {
            return Decision::Wait;
        }
        if inner.pending {
            inner.confirming = true;
            return Decision::Confirm;
        }
        match &inner.subscriber {
            Some(emit) if emit(AppEvent::QuitRequested) => {
                inner.pending = true;
                Decision::Asked
            }
            _ => {
                inner.subscriber = None;
                Decision::Proceed
            }
        }
    }

    /// Answer of the native dialog; `true` quits.
    pub fn confirmed(&self, quit: bool) {
        let mut inner = self.lock();
        inner.confirming = false;
        inner.pending = false;
        if quit {
            inner.quitting = true;
        }
    }

    /// The next close goes through whatever the guard says.
    pub fn allow_quit(&self) {
        let mut inner = self.lock();
        inner.quitting = true;
        inner.pending = false;
    }

    /// A new page starts with no editors and no subscription.
    pub fn reset(&self) {
        let mut inner = self.lock();
        inner.active = false;
        inner.pending = false;
        inner.subscriber = None;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn counting(delivered: bool) -> (AppEmit, Arc<AtomicUsize>) {
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let emit: AppEmit = Arc::new(move |e| {
            assert_eq!(e, AppEvent::QuitRequested);
            c.fetch_add(1, Ordering::SeqCst);
            delivered
        });
        (emit, count)
    }

    fn guarded() -> (QuitGuard, Arc<AtomicUsize>) {
        let guard = QuitGuard::default();
        let (emit, count) = counting(true);
        guard.subscribe(emit);
        guard.set_active(true);
        (guard, count)
    }

    #[test]
    fn inactive_guard_lets_the_window_close() {
        let guard = QuitGuard::default();
        let (emit, count) = counting(true);
        guard.subscribe(emit);
        assert_eq!(guard.intercept(false), Decision::Proceed);
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn active_guard_asks_the_page_and_an_answer_rearms_it() {
        let (guard, count) = guarded();
        assert_eq!(guard.intercept(false), Decision::Asked);
        // The page declined (Cancel) and says so.
        guard.set_active(true);
        assert_eq!(guard.intercept(false), Decision::Asked);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        guard.set_active(false);
        assert_eq!(guard.intercept(false), Decision::Proceed);
    }

    #[test]
    fn an_unanswered_request_falls_back_to_the_native_dialog() {
        let (guard, count) = guarded();
        assert_eq!(guard.intercept(false), Decision::Asked);
        assert_eq!(guard.intercept(false), Decision::Confirm);
        assert_eq!(guard.intercept(false), Decision::Wait);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        guard.confirmed(false);
        assert_eq!(guard.intercept(false), Decision::Asked);
        assert_eq!(guard.intercept(false), Decision::Confirm);
        guard.confirmed(true);
        assert_eq!(guard.intercept(false), Decision::Proceed);
    }

    #[test]
    fn quit_app_bypasses_the_guard() {
        let (guard, count) = guarded();
        assert_eq!(guard.intercept(false), Decision::Asked);
        guard.allow_quit();
        assert_eq!(guard.intercept(false), Decision::Proceed);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn unreachable_or_missing_page_never_blocks_the_close() {
        let guard = QuitGuard::default();
        guard.set_active(true);
        assert_eq!(guard.intercept(false), Decision::Proceed);
        let (emit, count) = counting(false);
        guard.subscribe(emit);
        assert_eq!(guard.intercept(false), Decision::Proceed);
        assert_eq!(guard.intercept(false), Decision::Proceed);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn unsynced_edited_files_guard_like_an_unsaved_editor() {
        let guard = QuitGuard::default();
        let (emit, count) = counting(true);
        guard.subscribe(emit);
        assert_eq!(guard.intercept(false), Decision::Proceed);
        assert_eq!(guard.intercept(true), Decision::Asked);
        assert_eq!(guard.intercept(true), Decision::Confirm);
        guard.confirmed(false);
        guard.allow_quit();
        assert_eq!(guard.intercept(true), Decision::Proceed);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn reset_clears_the_guard_and_the_subscription() {
        let (guard, count) = guarded();
        assert_eq!(guard.intercept(false), Decision::Asked);
        guard.reset();
        assert_eq!(guard.intercept(false), Decision::Proceed);
        guard.set_active(true);
        assert_eq!(guard.intercept(false), Decision::Proceed);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
