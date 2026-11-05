use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use super::error::CommandError;
use crate::analytics::{Analytics, Event};
use crate::ssh::SshManager;
use crate::terminal::{Emit as TerminalEmit, TerminalError, TerminalEvent, TerminalManager};

type Res<T> = Result<T, CommandError>;

fn required(name: &str, value: &str) -> Res<()> {
    if value.trim().is_empty() {
        return Err(TerminalError::InvalidInput(crate::text!(
            "errors.terminal.required",
            "{name} is required",
            name = name
        ))
        .into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_terminal(
    ssh: State<'_, SshManager>,
    terminals: State<'_, TerminalManager>,
    analytics: State<'_, Analytics>,
    connection_id: String,
    cols: u32,
    rows: u32,
    on_event: Channel<TerminalEvent>,
) -> Res<String> {
    let emit = Arc::new(move |event| on_event.send(event).is_ok());
    open_in(
        &ssh,
        &terminals,
        &analytics,
        &connection_id,
        cols,
        rows,
        emit,
    )
    .await
}

pub(super) async fn open_in(
    ssh: &SshManager,
    terminals: &TerminalManager,
    analytics: &Analytics,
    connection_id: &str,
    cols: u32,
    rows: u32,
    emit: TerminalEmit,
) -> Res<String> {
    required("connectionId", connection_id)?;
    let id = terminals.open(ssh, connection_id, cols, rows, emit).await?;
    analytics.record(Event::TerminalOpened);
    Ok(id)
}

// Synchronous commands run on the main thread in arrival order, which keeps keystrokes ordered.
#[tauri::command]
pub fn write_terminal(
    terminals: State<'_, TerminalManager>,
    terminal_id: String,
    data: String,
) -> Res<()> {
    required("terminalId", &terminal_id)?;
    Ok(terminals.write(&terminal_id, &data)?)
}

#[tauri::command]
pub fn resize_terminal(
    terminals: State<'_, TerminalManager>,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Res<()> {
    required("terminalId", &terminal_id)?;
    Ok(terminals.resize(&terminal_id, cols, rows)?)
}

#[tauri::command]
pub fn close_terminal(terminals: State<'_, TerminalManager>, terminal_id: String) -> Res<()> {
    required("terminalId", &terminal_id)?;
    Ok(terminals.close(&terminal_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_ids_are_invalid_input() {
        assert_eq!(
            required("terminalId", " ").unwrap_err().code,
            "invalid_input"
        );
        assert!(required("terminalId", "x").is_ok());
    }
}
