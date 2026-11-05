use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::error::CommandError;
use crate::analytics::{Analytics, Event, Files, Outcome, TransferDirection};
use crate::sftp::SftpManager;
use crate::ssh::SshManager;
use crate::transfer::{
    ConflictPolicy, Connections, Decision, Direction, EnqueueRequest, Finished, RemoteFuture,
    TransferEvent, TransferManager, TransferState, TransferView,
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

/// `transfer_finished` for a job that just ended.
pub fn finished_event(view: &TransferView) -> Option<Event> {
    let outcome = match view.state {
        TransferState::Done => Outcome::Done,
        TransferState::Failed => Outcome::Failed,
        TransferState::Cancelled => Outcome::Cancelled,
        _ => return None,
    };
    Some(Event::TransferFinished {
        direction: match view.direction {
            Direction::Upload => TransferDirection::Upload,
            Direction::Download => TransferDirection::Download,
        },
        outcome,
        files: Files::of(view.total_files.unwrap_or(view.done_files)),
    })
}

pub fn observer(analytics: Analytics) -> Finished {
    Arc::new(move |view| {
        if let Some(event) = finished_event(view) {
            analytics.record(event);
        }
    })
}

fn required(name: &str, value: &str) -> Res<()> {
    if value.trim().is_empty() {
        return Err(CommandError::new(
            "invalid_input",
            crate::text!(
                "errors.transfer.required",
                "{name} is required",
                name = name
            ),
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

    fn view(state: TransferState, total: Option<u64>, done: u64) -> TransferView {
        TransferView {
            id: "j".into(),
            connection_id: "c".into(),
            direction: Direction::Download,
            source: "/srv/secret/file".into(),
            target_dir: "C:/Users/me".into(),
            name: "file".into(),
            state,
            total_bytes: Some(123),
            done_bytes: 0,
            total_files: total,
            done_files: done,
            skipped: 0,
            error: None,
        }
    }

    #[test]
    fn finished_jobs_map_to_buckets_and_nothing_else() {
        let props = |v| serde_json::to_value(finished_event(&v).unwrap().props()).unwrap();
        assert_eq!(
            props(view(TransferState::Failed, Some(40), 3)),
            serde_json::json!({"direction": "download", "outcome": "failed", "files": "11-100"})
        );
        assert_eq!(props(view(TransferState::Cancelled, None, 0))["files"], "1");
        assert_eq!(props(view(TransferState::Done, None, 7))["files"], "2-10");
        for s in [
            TransferState::Queued,
            TransferState::Running,
            TransferState::WaitingConflict,
        ] {
            assert_eq!(finished_event(&view(s, None, 0)), None);
        }
    }

    #[test]
    fn blank_ids_are_invalid_input() {
        assert_eq!(required("jobId", " ").unwrap_err().code, "invalid_input");
        assert!(required("jobId", "j").is_ok());
    }
}
