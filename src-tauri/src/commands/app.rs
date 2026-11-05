use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::error::CommandError;
use crate::external::ExternalEdits;
use crate::native_text::{self, NativeText};
use crate::quit::{AppEvent, Decision, QuitGuard};

/// While active, closing the main window sends `quitRequested` instead of closing. Setting it
/// (to either value) also answers a pending request the page declined.
#[tauri::command]
pub fn set_quit_guard(guard: State<'_, QuitGuard>, active: bool) {
    guard.set_active(active);
}

#[tauri::command]
pub fn subscribe_app_events(guard: State<'_, QuitGuard>, on_event: Channel<AppEvent>) {
    guard.subscribe(Arc::new(move |event| on_event.send(event).is_ok()));
}

/// Closes the main window whatever the guard says; the app exits as on any last window close.
#[tauri::command]
pub async fn quit_app(app: AppHandle, guard: State<'_, QuitGuard>) -> Result<(), CommandError> {
    guard.allow_quit();
    quit_now(&app);
    Ok(())
}

fn quit_now(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) if window.close().is_ok() => {}
        _ => app.exit(0),
    }
}

/// Applies the guard to a close or quit request; `true` keeps the app open.
pub fn on_quit_request(app: &AppHandle) -> bool {
    let Some(guard) = app.try_state::<QuitGuard>() else {
        return false;
    };
    let unsynced = app
        .try_state::<ExternalEdits>()
        .is_some_and(|e| e.has_unsynced());
    match guard.intercept(unsynced) {
        Decision::Proceed => false,
        Decision::Asked | Decision::Wait => true,
        Decision::Confirm => {
            confirm(app.clone());
            true
        }
    }
}

/// Flashes the taskbar entry (or bounces the dock icon) when the main window is not focused.
pub fn attention(app: AppHandle) -> Arc<dyn Fn() + Send + Sync> {
    Arc::new(move || {
        if let Some(window) = app.get_webview_window("main")
            && !window.is_focused().unwrap_or(true)
        {
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    })
}

/// The page did not answer: the user decides in a native dialog parented to the main window.
fn confirm(app: AppHandle) {
    let handle = app.clone();
    let text = |t| native_text::get(t);
    let (title, message, yes, no) = (
        text(NativeText::QuitTitle),
        text(NativeText::QuitMessage),
        text(NativeText::QuitConfirm),
        text(NativeText::QuitCancel),
    );
    let shown = app.run_on_main_thread(move || {
        let mut dialog = rfd::AsyncMessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title(title)
            .set_description(message)
            .set_buttons(rfd::MessageButtons::OkCancelCustom(yes.into(), no.into()));
        if let Some(window) = handle.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let answer = dialog.show();
        std::thread::spawn(move || {
            let quit = confirmed(tauri::async_runtime::block_on(answer), yes);
            handle.state::<QuitGuard>().confirmed(quit);
            if quit {
                quit_now(&handle);
            }
        });
    });
    if shown.is_err() {
        app.state::<QuitGuard>().confirmed(false);
    }
}

/// Custom buttons answer with their label; a backend that falls back to standard buttons
/// answers `Ok`.
fn confirmed(answer: rfd::MessageDialogResult, quit_label: &str) -> bool {
    match answer {
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes => true,
        rfd::MessageDialogResult::Custom(label) => label == quit_label,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_quit_button_confirms() {
        use rfd::MessageDialogResult as R;
        assert!(confirmed(R::Custom("Quitter".into()), "Quitter"));
        assert!(confirmed(R::Ok, "Quit"));
        assert!(!confirmed(R::Custom("Annuler".into()), "Quitter"));
        assert!(!confirmed(R::Cancel, "Quit"));
        assert!(!confirmed(R::No, "Quit"));
    }
}
