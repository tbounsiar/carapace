use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::error::CommandError;
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
    match guard.intercept() {
        Decision::Proceed => false,
        Decision::Asked | Decision::Wait => true,
        Decision::Confirm => {
            confirm(app.clone());
            true
        }
    }
}

/// The page did not answer: the user decides in a native dialog parented to the main window.
fn confirm(app: AppHandle) {
    let handle = app.clone();
    let shown = app.run_on_main_thread(move || {
        let mut dialog = rfd::AsyncMessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title("Quit Carapace")
            .set_description("Quit anyway? Unsaved changes will be lost.")
            .set_buttons(rfd::MessageButtons::YesNo);
        if let Some(window) = handle.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let answer = dialog.show();
        std::thread::spawn(move || {
            let quit = tauri::async_runtime::block_on(answer) == rfd::MessageDialogResult::Yes;
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
