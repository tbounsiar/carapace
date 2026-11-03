use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::error::CommandError;
use crate::sftp::SftpManager;
use crate::ssh::SshManager;
use crate::transfer::{
    ConflictPolicy, Connections, Decision, Direction, EnqueueRequest, RemoteFuture, TransferEvent,
    TransferManager, TransferView,
};

type Res<T> = Result<T, CommandError>;

/// Reaches the SSH and SFTP managers from transfer jobs, which outlive any command call.
pub struct AppConnections(pub AppHandle);

impl Connections for AppConnections {
    fn remote<'a>(&'a self, connection_id: &'a str) -> RemoteFuture<'a> {
        Box::pin(async move {
            let ssh = self.0.state::<SshManager>();
            let sftp = self.0.state::<SftpManager>();
            sftp.channel(&ssh, connection_id).await
        })
    }
}

fn required(name: &str, value: &str) -> Res<()> {
    if value.trim().is_empty() {
        return Err(CommandError::new(
            "invalid_input",
            format!("{name} is required"),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn subscribe_transfers(
    transfers: State<'_, TransferManager>,
    on_event: Channel<TransferEvent>,
) -> Vec<TransferView> {
    transfers.subscribe(Arc::new(move |event| on_event.send(event).is_ok()))
}

#[tauri::command]
pub async fn enqueue_transfers(
    transfers: State<'_, TransferManager>,
    connection_id: String,
    direction: Direction,
    sources: Vec<String>,
    target_dir: String,
    conflict: ConflictPolicy,
) -> Res<Vec<String>> {
    required("connectionId", &connection_id)?;
    Ok(transfers
        .enqueue(EnqueueRequest {
            connection_id,
            direction,
            sources,
            target_dir,
            conflict,
        })
        .await?)
}

#[tauri::command]
pub fn cancel_transfer(transfers: State<'_, TransferManager>, job_id: String) -> Res<()> {
    required("jobId", &job_id)?;
    Ok(transfers.cancel(&job_id)?)
}

#[tauri::command]
pub fn answer_conflict(
    transfers: State<'_, TransferManager>,
    job_id: String,
    conflict_id: u64,
    decision: Decision,
    apply_to_all: bool,
) -> Res<()> {
    required("jobId", &job_id)?;
    Ok(transfers.answer(&job_id, conflict_id, decision, apply_to_all)?)
}

#[tauri::command]
pub fn clear_finished_transfers(transfers: State<'_, TransferManager>) {
    transfers.clear_finished();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_ids_are_invalid_input() {
        assert_eq!(required("jobId", " ").unwrap_err().code, "invalid_input");
        assert!(required("jobId", "j").is_ok());
    }
}
