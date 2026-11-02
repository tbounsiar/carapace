use super::*;
use crate::ssh::test_server::{
    Connected, FLOOD_BYTES, SHELL_EXIT, SHELL_EXIT_CODE, SHELL_FLOOD, TestServer, flood_line,
    manager_for, start_server,
};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) type Events = mpsc::UnboundedReceiver<TerminalEvent>;

pub(super) fn collector() -> (Emit, Events) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(move |e| tx.send(e).is_ok()), rx)
}

struct World {
    server: TestServer,
    ssh: Connected,
    terminals: TerminalManager,
}

async fn world(seed: u8) -> World {
    let server = start_server(seed).await;
    let ssh = manager_for(&server, "h1");
    ssh.connect().await.unwrap();
    World {
        server,
        ssh,
        terminals: TerminalManager::default(),
    }
}

impl World {
    async fn open(&self) -> (String, Events) {
        let (emit, rx) = collector();
        let id = self
            .terminals
            .open(&self.ssh.manager, "h1", 80, 24, emit)
            .await
            .unwrap();
        (id, rx)
    }
}

pub(super) async fn next(rx: &mut Events) -> Option<TerminalEvent> {
    timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("no terminal event within 5 s")
}

pub(super) async fn read_until(rx: &mut Events, needle: &str) -> String {
    let mut out = Vec::new();
    loop {
        match next(rx).await {
            Some(TerminalEvent::Data { data }) => {
                out.extend(data_encoding::BASE64.decode(data.as_bytes()).unwrap());
                let text = String::from_utf8_lossy(&out).into_owned();
                if text.contains(needle) {
                    return text;
                }
            }
            other => panic!("expected output containing {needle:?}, got {other:?}"),
        }
    }
}

/// Skips output, returns the close reason and checks nothing follows it: every emitter is gone.
pub(super) async fn closed(rx: &mut Events) -> CloseReason {
    loop {
        match next(rx).await {
            Some(TerminalEvent::Closed { reason }) => {
                assert_eq!(next(rx).await, None, "event after closed");
                return reason;
            }
            Some(_) => {}
            None => panic!("emitter dropped without a closed event"),
        }
    }
}

#[tokio::test]
async fn open_write_receive_then_close_once() {
    let w = world(40).await;
    let (id, mut rx) = w.open().await;
    assert_eq!(w.terminals.count("h1"), 1);
    w.terminals.write(&id, "hello carapace\n").unwrap();
    read_until(&mut rx, "hello carapace").await;

    w.terminals.close(&id).unwrap();
    assert_eq!(closed(&mut rx).await, CloseReason::Closed);
    assert_eq!(w.terminals.count("h1"), 0);
    assert_eq!(w.terminals.write(&id, "x"), Err(TerminalError::NotFound));
    assert_eq!(w.terminals.close(&id), Err(TerminalError::NotFound));
    assert!(w.ssh.manager.session("h1").await.is_some());
}

#[tokio::test]
async fn size_is_validated_and_resize_reaches_the_server() {
    let w = world(41).await;
    for (cols, rows) in [(0, 24), (80, 0), (1001, 24), (80, 501)] {
        let (emit, _rx) = collector();
        let err = w
            .terminals
            .open(&w.ssh.manager, "h1", cols, rows, emit)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
    }
    let (id, mut rx) = w.open().await;
    for (cols, rows) in [(0, 24), (80, 0), (1001, 24), (80, 501)] {
        assert_eq!(
            w.terminals.resize(&id, cols, rows).unwrap_err().code(),
            "invalid_input"
        );
    }
    w.terminals.resize(&id, 1000, 500).unwrap();
    read_until(&mut rx, "resized 1000x500").await;
    w.terminals.resize(&id, 1, 1).unwrap();
    read_until(&mut rx, "resized 1x1").await;
}

#[tokio::test]
async fn write_is_limited_to_64_kib() {
    let w = world(42).await;
    let (id, mut rx) = w.open().await;
    let over = "a".repeat(MAX_WRITE_BYTES + 1);
    assert_eq!(
        w.terminals.write(&id, &over).unwrap_err().code(),
        "invalid_input"
    );
    let multibyte = "é".repeat(MAX_WRITE_BYTES / 2 + 1);
    assert_eq!(
        w.terminals.write(&id, &multibyte).unwrap_err().code(),
        "invalid_input"
    );
    w.terminals.write(&id, "").unwrap();
    let max = format!("{}\n", "b".repeat(MAX_WRITE_BYTES - 1));
    w.terminals.write(&id, &max).unwrap();
    let text = read_until(&mut rx, "\n").await;
    assert_eq!(text.len(), MAX_WRITE_BYTES);
}

#[tokio::test]
async fn unknown_terminal_is_not_found() {
    let terminals = TerminalManager::default();
    assert_eq!(terminals.write("nope", "x"), Err(TerminalError::NotFound));
    assert_eq!(
        terminals.resize("nope", 80, 24),
        Err(TerminalError::NotFound)
    );
    assert_eq!(terminals.close("nope"), Err(TerminalError::NotFound));
}

#[tokio::test]
async fn host_without_a_live_session_is_not_connected() {
    let server = start_server(43).await;
    let ssh = manager_for(&server, "h1");
    let terminals = TerminalManager::default();
    let (emit, _rx) = collector();
    let err = terminals
        .open(&ssh.manager, "h1", 80, 24, emit.clone())
        .await
        .unwrap_err();
    assert_eq!(err, TerminalError::NotConnected);

    ssh.connect().await.unwrap();
    ssh.manager.disconnect("h1").await.unwrap();
    let err = terminals
        .open(&ssh.manager, "h1", 80, 24, emit)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "not_connected");
    assert_eq!(terminals.count("h1"), 0);
}

#[tokio::test]
async fn at_most_32_terminals_per_host() {
    let w = world(44).await;
    let mut open = Vec::new();
    for _ in 0..MAX_PER_CONNECTION {
        open.push(w.open().await);
    }
    let (emit, _rx) = collector();
    let err = w
        .terminals
        .open(&w.ssh.manager, "h1", 80, 24, emit)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(lock(&w.terminals.registry).opening.is_empty());

    let (id, mut rx) = open.pop().unwrap();
    w.terminals.close(&id).unwrap();
    assert_eq!(closed(&mut rx).await, CloseReason::Closed);
    let (_id, _rx) = w.open().await;
    assert_eq!(w.terminals.count("h1"), MAX_PER_CONNECTION);
}

#[tokio::test]
async fn disconnect_closes_every_terminal_of_the_host_once() {
    let w = world(45).await;
    let mut open = Vec::new();
    for _ in 0..3 {
        open.push(w.open().await);
    }
    w.ssh.manager.disconnect("h1").await.unwrap();
    for (id, mut rx) in open {
        assert_eq!(closed(&mut rx).await, CloseReason::Closed);
        assert_eq!(w.terminals.write(&id, "x"), Err(TerminalError::NotFound));
    }
    assert_eq!(w.terminals.count("h1"), 0);
}

#[tokio::test]
async fn dropped_connection_closes_terminals_as_connection_lost() {
    let w = world(46).await;
    let (_a, mut rx_a) = w.open().await;
    let (_b, mut rx_b) = w.open().await;
    w.server.drop_clients().await;
    assert_eq!(closed(&mut rx_a).await, CloseReason::ConnectionLost);
    assert_eq!(closed(&mut rx_b).await, CloseReason::ConnectionLost);
    assert_eq!(w.terminals.count("h1"), 0);
    assert!(w.ssh.manager.session("h1").await.is_none());
    assert!(w.ssh.manager.list().await.is_empty());
}

#[tokio::test]
async fn remote_exit_reports_the_code_then_closes() {
    let w = world(47).await;
    let (id, mut rx) = w.open().await;
    w.terminals
        .write(&id, std::str::from_utf8(SHELL_EXIT).unwrap())
        .unwrap();
    loop {
        match next(&mut rx).await {
            Some(TerminalEvent::Exit { code }) => {
                assert_eq!(code, Some(SHELL_EXIT_CODE));
                break;
            }
            Some(TerminalEvent::Data { .. }) => {}
            other => panic!("expected exit, got {other:?}"),
        }
    }
    assert_eq!(closed(&mut rx).await, CloseReason::Exited);
    assert_eq!(w.terminals.count("h1"), 0);
    assert!(w.ssh.manager.session("h1").await.is_some());
}

#[test]
fn events_serialize_as_contract() {
    let v = serde_json::to_value(TerminalEvent::Data {
        data: "aGk=".into(),
    })
    .unwrap();
    assert_eq!(v, serde_json::json!({ "kind": "data", "data": "aGk=" }));
    let v = serde_json::to_value(TerminalEvent::Exit { code: None }).unwrap();
    assert_eq!(v, serde_json::json!({ "kind": "exit", "code": null }));
    for (reason, name) in [
        (CloseReason::Exited, "exited"),
        (CloseReason::Closed, "closed"),
        (CloseReason::ConnectionLost, "connectionLost"),
    ] {
        let v = serde_json::to_value(TerminalEvent::Closed { reason }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "closed", "reason": name }));
    }
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..250 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn failed_emit_closes_the_terminal_and_its_channel() {
    let w = world(48).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let emit: Emit = Arc::new(move |e| {
        let _ = tx.send(e);
        false
    });
    let id = w
        .terminals
        .open(&w.ssh.manager, "h1", 80, 24, emit)
        .await
        .unwrap();
    w.terminals
        .write(
            &id,
            "anyone there?
",
        )
        .unwrap();
    assert_eq!(closed(&mut rx).await, CloseReason::Closed);
    assert_eq!(w.terminals.count("h1"), 0);
    eventually("the remote channel to close", || {
        w.server.closed_channels() == 1
    })
    .await;
    assert!(w.ssh.manager.session("h1").await.is_some());
}

#[tokio::test]
async fn close_all_closes_every_terminal_and_channel() {
    let w = world(49).await;
    let (_a, mut rx_a) = w.open().await;
    let (_b, mut rx_b) = w.open().await;
    w.terminals.close_all();
    assert_eq!(w.terminals.count("h1"), 0);
    assert_eq!(closed(&mut rx_a).await, CloseReason::Closed);
    assert_eq!(closed(&mut rx_b).await, CloseReason::Closed);
    eventually("both remote channels to close", || {
        w.server.closed_channels() == 2
    })
    .await;
}

#[tokio::test]
async fn full_input_budget_is_busy_and_recovers() {
    let w = world(50).await;
    let (id, mut rx) = w.open().await;
    let budget = lock(&w.terminals.registry).terminals[&id]
        .input_budget
        .clone();
    let held = budget
        .clone()
        .acquire_many_owned(INPUT_BUDGET as u32)
        .await
        .unwrap();
    assert_eq!(w.terminals.write(&id, "x"), Err(TerminalError::Busy));
    assert_eq!(w.terminals.resize(&id, 80, 24), Err(TerminalError::Busy));
    drop(held);
    w.terminals
        .write(
            &id, "back
",
        )
        .unwrap();
    read_until(&mut rx, "back").await;
    eventually("queued input to be released", || {
        budget.available_permits() == INPUT_BUDGET
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn output_is_bounded_while_the_receiver_is_slow_and_stays_in_order() {
    let w = world(51).await;
    let gate = Arc::new(AtomicBool::new(false));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let open = gate.clone();
    let emit: Emit = Arc::new(move |e| {
        while !open.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
        }
        tx.send(e).is_ok()
    });
    let id = w
        .terminals
        .open(&w.ssh.manager, "h1", 80, 24, emit)
        .await
        .unwrap();
    w.terminals
        .write(&id, std::str::from_utf8(SHELL_FLOOD).unwrap())
        .unwrap();
    eventually("the flood to start", || w.server.flood_sent() > 0).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let stalled = w.server.flood_sent();
    assert!(stalled < FLOOD_BYTES, "server sent everything: {stalled}");
    assert!(w.terminals.queued_output(&id).unwrap() <= OUTPUT_BUDGET);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(w.server.flood_sent(), stalled, "server kept sending");

    gate.store(true, Ordering::SeqCst);
    let mut received = Vec::new();
    while received.len() < FLOOD_BYTES {
        match next(&mut rx).await {
            Some(TerminalEvent::Data { data }) => {
                let bytes = data_encoding::BASE64.decode(data.as_bytes()).unwrap();
                assert!(bytes.len() <= MAX_CHUNK);
                received.extend(bytes);
            }
            other => panic!("expected flood output, got {other:?}"),
        }
    }
    let line = flood_line(0).len();
    let whole = received.len() / line * line;
    for (i, chunk) in received[..whole].chunks(line).enumerate() {
        assert_eq!(chunk, flood_line(i).as_bytes(), "line {i} out of order");
    }
}
