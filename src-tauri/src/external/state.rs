//! States of an edited file and the transitions between them, without I/O.

use serde::Serialize;

use crate::files::FsError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Downloading and launching the editor.
    Opening,
    /// The local copy equals the last downloaded or uploaded version.
    Synced,
    Uploading,
    /// The server copy changed since the last sync; saves are held until the user decides.
    Conflict,
    Failed,
    /// Local changes not uploaded and the host is not connected.
    Waiting,
    /// The host is not connected, no local change.
    Disconnected,
    /// Found at startup with changes never uploaded.
    Recovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictKind {
    /// Modified on the server, or the link now points elsewhere.
    Changed,
    Deleted,
}

/// What asked for an upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// A debounced save in the editor.
    Save,
    /// The host connected again.
    Drain,
    /// Upload now, Retry, Upload (recovered).
    Explicit,
    /// Overwrite the server without the version check.
    Force,
}

impl State {
    /// Listed by the quit and stop checks.
    pub fn not_uploaded(self) -> bool {
        matches!(
            self,
            Self::Uploading | Self::Conflict | Self::Failed | Self::Waiting | Self::Recovered
        )
    }

    pub fn needs_attention(self) -> bool {
        matches!(
            self,
            Self::Conflict | Self::Failed | Self::Waiting | Self::Recovered
        )
    }

    /// Entering one of these asks for the window's attention when it is not focused.
    pub fn wants_attention(self) -> bool {
        matches!(self, Self::Conflict | Self::Failed | Self::Recovered)
    }
}

pub fn may_upload(state: State, trigger: Trigger) -> bool {
    match trigger {
        Trigger::Save => !matches!(state, State::Opening | State::Conflict),
        Trigger::Drain => state == State::Waiting,
        Trigger::Explicit | Trigger::Force => state != State::Opening,
    }
}

pub fn host_down(state: State) -> State {
    match state {
        State::Synced => State::Disconnected,
        State::Failed => State::Waiting,
        s => s,
    }
}

pub fn host_up(state: State) -> State {
    match state {
        State::Disconnected => State::Synced,
        s => s,
    }
}

/// The local copy equals the last synced content: nothing to upload. A conflict stays held.
pub fn unchanged(state: State, connected: bool) -> State {
    match state {
        State::Conflict => State::Conflict,
        _ if connected => State::Synced,
        _ => State::Disconnected,
    }
}

/// There are changes to upload but the host is not connected.
pub fn unreachable(state: State) -> State {
    match state {
        State::Conflict | State::Recovered => state,
        _ => State::Waiting,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    Conflict(ConflictKind),
    Waiting,
    Failed,
}

/// Outcome of a failed upload; `connected` is whether the session is still live.
pub fn failure(err: &FsError, connected: bool) -> Failure {
    match err {
        FsError::Changed(_) | FsError::Retargeted(_) => Failure::Conflict(ConflictKind::Changed),
        FsError::Deleted(_) => Failure::Conflict(ConflictKind::Deleted),
        FsError::NotConnected => Failure::Waiting,
        FsError::Network if !connected => Failure::Waiting,
        _ => Failure::Failed,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ErrorView {
    pub code: &'static str,
    pub message: String,
}

/// What the frontend sees of an edited file: never the local path or the content.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditedFile {
    pub id: String,
    pub host_id: String,
    pub remote_path: String,
    /// The remote file name.
    pub name: String,
    pub state: State,
    pub conflict: Option<ConflictKind>,
    /// Reason of `failed`.
    pub error: Option<ErrorView>,
    /// Unix milliseconds.
    pub opened_at: u64,
    /// Last download or upload.
    pub last_synced_at: Option<u64>,
    pub last_uploaded_at: Option<u64>,
    /// Last change of a recovered copy.
    pub recovered_at: Option<u64>,
    pub size: u64,
    pub not_uploaded: bool,
    pub needs_attention: bool,
    /// Saves in the editor are seen (false for a recovered copy not reopened yet).
    pub watched: bool,
    /// False for a recovered copy whose host no longer exists: only show and discard.
    pub can_upload: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [State; 8] = [
        State::Opening,
        State::Synced,
        State::Uploading,
        State::Conflict,
        State::Failed,
        State::Waiting,
        State::Disconnected,
        State::Recovered,
    ];

    #[test]
    fn groups_match_the_spec() {
        let not_uploaded: Vec<_> = ALL.into_iter().filter(|s| s.not_uploaded()).collect();
        assert_eq!(
            not_uploaded,
            [
                State::Uploading,
                State::Conflict,
                State::Failed,
                State::Waiting,
                State::Recovered
            ]
        );
        let attention: Vec<_> = ALL.into_iter().filter(|s| s.needs_attention()).collect();
        assert_eq!(
            attention,
            [
                State::Conflict,
                State::Failed,
                State::Waiting,
                State::Recovered
            ]
        );
        let alerts: Vec<_> = ALL.into_iter().filter(|s| s.wants_attention()).collect();
        assert_eq!(alerts, [State::Conflict, State::Failed, State::Recovered]);
        assert_eq!(
            serde_json::to_value(ALL).unwrap(),
            serde_json::json!([
                "opening",
                "synced",
                "uploading",
                "conflict",
                "failed",
                "waiting",
                "disconnected",
                "recovered"
            ])
        );
    }

    #[test]
    fn saves_are_held_in_conflict_and_drains_take_waiting_files_only() {
        for s in ALL {
            assert_eq!(
                may_upload(s, Trigger::Save),
                !matches!(s, State::Opening | State::Conflict),
                "{s:?}"
            );
            assert_eq!(may_upload(s, Trigger::Drain), s == State::Waiting, "{s:?}");
            assert_eq!(may_upload(s, Trigger::Explicit), s != State::Opening);
            assert_eq!(may_upload(s, Trigger::Force), s != State::Opening);
        }
    }

    #[test]
    fn connection_changes() {
        assert_eq!(host_down(State::Synced), State::Disconnected);
        assert_eq!(host_down(State::Failed), State::Waiting);
        for s in [
            State::Conflict,
            State::Waiting,
            State::Recovered,
            State::Uploading,
            State::Opening,
        ] {
            assert_eq!(host_down(s), s);
        }
        assert_eq!(host_up(State::Disconnected), State::Synced);
        assert_eq!(host_up(State::Waiting), State::Waiting);
        assert_eq!(unchanged(State::Waiting, true), State::Synced);
        assert_eq!(unchanged(State::Failed, false), State::Disconnected);
        assert_eq!(unchanged(State::Conflict, true), State::Conflict);
        assert_eq!(unreachable(State::Synced), State::Waiting);
        assert_eq!(unreachable(State::Recovered), State::Recovered);
        assert_eq!(unreachable(State::Conflict), State::Conflict);
    }

    #[test]
    fn upload_failures_map_to_states() {
        let p = || "/etc/a".to_string();
        assert_eq!(
            failure(&FsError::Changed(p()), true),
            Failure::Conflict(ConflictKind::Changed)
        );
        assert_eq!(
            failure(&FsError::Retargeted(p()), true),
            Failure::Conflict(ConflictKind::Changed)
        );
        assert_eq!(
            failure(&FsError::Deleted(p()), true),
            Failure::Conflict(ConflictKind::Deleted)
        );
        assert_eq!(failure(&FsError::NotConnected, true), Failure::Waiting);
        assert_eq!(failure(&FsError::Network, false), Failure::Waiting);
        assert_eq!(failure(&FsError::Network, true), Failure::Failed);
        assert_eq!(
            failure(&FsError::PermissionDenied(p()), true),
            Failure::Failed
        );
    }
}
