use std::time::Duration;

use tokio::sync::mpsc;

use super::*;
use crate::ssh::test_server::{manager_for, start_server};

fn channel() -> (EndEmit, mpsc::UnboundedReceiver<ConnectionEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(move |e| tx.send(e).is_ok()), rx)
}

async fn next(rx: &mut mpsc::UnboundedReceiver<ConnectionEvent>) -> ConnectionEvent {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("no connection event")
        .expect("channel closed")
}

fn ended(id: &str, reason: EndReason) -> ConnectionEvent {
    ConnectionEvent::ConnectionEnded {
        connection_id: id.into(),
        reason,
    }
}

#[tokio::test]
async fn user_disconnect_and_server_drop_have_distinct_reasons() {
    let server = start_server(130).await;
    let c = manager_for(&server, "h1");
    let (emit, mut rx) = channel();
    assert!(c.manager.subscribe_ends(emit).is_empty());

    c.connect().await.unwrap();
    c.manager.disconnect("h1").await.unwrap();
    assert_eq!(next(&mut rx).await, ended("h1", EndReason::User));

    c.connect().await.unwrap();
    // The test server can drop only connections that opened a channel.
    let session = c.manager.session("h1").await.unwrap();
    let _channel = session.handle.channel_open_session().await.unwrap();
    server.drop_clients().await;
    assert_eq!(next(&mut rx).await, ended("h1", EndReason::Lost));
    let (emit, _rx2) = channel();
    assert_eq!(
        c.manager.subscribe_ends(emit),
        vec![ConnectionEnd {
            connection_id: "h1".into(),
            reason: EndReason::Lost
        }]
    );
}

#[tokio::test]
async fn reconnecting_clears_the_reason_and_late_subscribers_get_it() {
    let server = start_server(131).await;
    let c = manager_for(&server, "h1");
    c.connect().await.unwrap();
    c.manager.disconnect("h1").await.unwrap();
    let mut snapshot = Vec::new();
    for _ in 0..100 {
        let (emit, _rx) = channel();
        snapshot = c.manager.subscribe_ends(emit);
        if !snapshot.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        snapshot,
        vec![ConnectionEnd {
            connection_id: "h1".into(),
            reason: EndReason::User
        }]
    );
    c.connect().await.unwrap();
    let (emit, mut rx) = channel();
    assert!(c.manager.subscribe_ends(emit).is_empty());
    c.manager.unsubscribe_ends();
    c.manager.disconnect("h1").await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(rx.try_recv().is_err());
}

#[test]
fn events_serialize_as_the_frontend_expects() {
    let json = serde_json::to_value(ended("h1", EndReason::Lost)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "kind": "connectionEnded", "connectionId": "h1", "reason": "lost" })
    );
    let end = ConnectionEnd {
        connection_id: "h2".into(),
        reason: EndReason::User,
    };
    assert_eq!(
        serde_json::to_value(end).unwrap(),
        serde_json::json!({ "connectionId": "h2", "reason": "user" })
    );
}

#[test]
fn a_failed_delivery_drops_the_subscriber() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let _g = rt.enter();
    let ends = Ends::default();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c = calls.clone();
    ends.subscribe(Arc::new(move |_| {
        c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        false
    }));
    ends.lock().live.insert("a".into(), 1);
    ends.finished("a", 1, EndReason::Lost);
    ends.lock().live.insert("b".into(), 2);
    ends.finished("b", 2, EndReason::Lost);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    // A watcher of an older connection with the same id reports nothing.
    ends.lock().live.insert("a".into(), 3);
    ends.finished("a", 1, EndReason::User);
    assert!(ends.lock().live.contains_key("a"));
    assert_eq!(ends.lock().ended.get("a"), Some(&EndReason::Lost));
}
