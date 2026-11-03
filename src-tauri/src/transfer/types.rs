use serde::{Deserialize, Serialize};

use crate::files::FsError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    Ask,
    Overwrite,
    Skip,
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Overwrite,
    Skip,
    Rename,
}

impl From<Decision> for ConflictPolicy {
    fn from(d: Decision) -> Self {
        match d {
            Decision::Overwrite => Self::Overwrite,
            Decision::Skip => Self::Skip,
            Decision::Rename => Self::Rename,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Queued,
    Running,
    WaitingConflict,
    Done,
    Failed,
    Cancelled,
}

impl TransferState {
    pub fn finished(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TransferError {
    pub code: &'static str,
    pub message: String,
}

impl From<&FsError> for TransferError {
    fn from(e: &FsError) -> Self {
        Self {
            code: e.code(),
            message: e.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferView {
    pub id: String,
    pub connection_id: String,
    pub direction: Direction,
    pub source: String,
    pub target_dir: String,
    pub name: String,
    pub state: TransferState,
    pub total_bytes: Option<u64>,
    pub done_bytes: u64,
    pub total_files: Option<u64>,
    pub done_files: u64,
    pub skipped: u64,
    pub error: Option<TransferError>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransferEvent {
    Updated {
        transfer: TransferView,
    },
    Conflict {
        job_id: String,
        /// Sequence number of the conflict within its job; the answer must carry it.
        conflict_id: u64,
        /// Destination path.
        path: String,
        existing_size: Option<u64>,
        existing_modified: Option<i64>,
        incoming_size: Option<u64>,
        incoming_modified: Option<i64>,
    },
    Removed {
        job_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnqueueRequest {
    pub connection_id: String,
    pub direction: Direction,
    pub sources: Vec<String>,
    pub target_dir: String,
    pub conflict: ConflictPolicy,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case() {
        let view = TransferView {
            id: "j".into(),
            connection_id: "h".into(),
            direction: Direction::Upload,
            source: "/a".into(),
            target_dir: "/b".into(),
            name: "a".into(),
            state: TransferState::WaitingConflict,
            total_bytes: None,
            done_bytes: 1,
            total_files: Some(2),
            done_files: 0,
            skipped: 0,
            error: Some(TransferError::from(&FsError::NotConnected)),
        };
        let json = serde_json::to_value(TransferEvent::Updated { transfer: view }).unwrap();
        assert_eq!(json["kind"], "updated");
        let t = &json["transfer"];
        assert_eq!(t["connectionId"], "h");
        assert_eq!(t["direction"], "upload");
        assert_eq!(t["state"], "waitingConflict");
        assert!(t["totalBytes"].is_null());
        assert_eq!(t["totalFiles"], 2);
        assert_eq!(t["error"]["code"], "not_connected");
        let conflict = serde_json::to_value(TransferEvent::Conflict {
            job_id: "j".into(),
            conflict_id: 7,
            path: "/b/a".into(),
            existing_size: Some(1),
            existing_modified: None,
            incoming_size: Some(2),
            incoming_modified: Some(3),
        })
        .unwrap();
        assert_eq!(conflict["kind"], "conflict");
        assert_eq!(conflict["jobId"], "j");
        assert_eq!(conflict["conflictId"], 7);
        assert_eq!(conflict["existingSize"], 1);
        assert_eq!(conflict["incomingModified"], 3);
        let removed = serde_json::to_value(TransferEvent::Removed {
            job_ids: vec!["j".into()],
        })
        .unwrap();
        assert_eq!(removed["jobIds"][0], "j");
        let p: ConflictPolicy = serde_json::from_str("\"rename\"").unwrap();
        assert_eq!(p, ConflictPolicy::Rename);
        let d: Direction = serde_json::from_str("\"download\"").unwrap();
        assert_eq!(d, Direction::Download);
    }
}
