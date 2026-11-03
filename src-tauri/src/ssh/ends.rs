//! Why each connection ended, for the frontend: a live event to the subscribed page, and the
//! last reason per connection id until it connects again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::watch;

use super::SessionEnd;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    /// Disconnected from the app (disconnect, host deleted or moved to another scope).
    User,
    /// Closed by the server or the network.
    Lost,
}

impl From<SessionEnd> for EndReason {
    fn from(end: SessionEnd) -> Self {
        match end {
            SessionEnd::Disconnected => Self::User,
            SessionEnd::Lost => Self::Lost,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEnd {
    pub connection_id: String,
    pub reason: EndReason,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionEvent {
    ConnectionEnded {
        connection_id: String,
        reason: EndReason,
    },
}

/// `false` when the event could not be delivered; the subscriber is dropped then.
pub type EndEmit = Arc<dyn Fn(ConnectionEvent) -> bool + Send + Sync>;

#[derive(Default)]
struct Inner {
    /// Live connection id -> serial of its connection, so the watcher of an older connection
    /// with the same id never reports over a newer one.
    live: HashMap<String, u64>,
    ended: HashMap<String, EndReason>,
    subscriber: Option<EndEmit>,
    next: u64,
}

#[derive(Default, Clone)]
pub struct Ends(Arc<Mutex<Inner>>);

impl Ends {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a new live connection and reports its end once its signal is set.
    pub fn watch(&self, connection_id: &str, mut ended: watch::Receiver<Option<SessionEnd>>) {
        let serial = {
            let mut inner = self.lock();
            inner.next += 1;
            let serial = inner.next;
            inner.live.insert(connection_id.to_owned(), serial);
            inner.ended.remove(connection_id);
            serial
        };
        let ends = self.clone();
        let id = connection_id.to_owned();
        tokio::spawn(async move {
            // A dropped sender means the connection is gone without a stated reason.
            let end = match ended.wait_for(|e| e.is_some()).await {
                Ok(e) => e.unwrap_or(SessionEnd::Lost),
                Err(_) => SessionEnd::Lost,
            };
            ends.finished(&id, serial, end.into());
        });
    }

    fn finished(&self, connection_id: &str, serial: u64, reason: EndReason) {
        let mut inner = self.lock();
        if inner.live.get(connection_id) != Some(&serial) {
            return;
        }
        inner.live.remove(connection_id);
        inner.ended.insert(connection_id.to_owned(), reason);
        let event = ConnectionEvent::ConnectionEnded {
            connection_id: connection_id.to_owned(),
            reason,
        };
        if let Some(emit) = &inner.subscriber
            && !emit(event)
        {
            inner.subscriber = None;
        }
    }

    /// Replaces the subscriber; returns the ends known so far, under the same lock, so no end
    /// is missed or reported twice.
    pub fn subscribe(&self, emit: EndEmit) -> Vec<ConnectionEnd> {
        let mut inner = self.lock();
        inner.subscriber = Some(emit);
        let mut out: Vec<ConnectionEnd> = inner
            .ended
            .iter()
            .map(|(id, reason)| ConnectionEnd {
                connection_id: id.clone(),
                reason: *reason,
            })
            .collect();
        out.sort_by(|a, b| a.connection_id.cmp(&b.connection_id));
        out
    }

    pub fn unsubscribe(&self) {
        self.lock().subscriber = None;
    }
}

#[cfg(test)]
mod tests;
