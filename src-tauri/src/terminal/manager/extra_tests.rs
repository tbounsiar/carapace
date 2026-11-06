use super::tests::{Events, closed, collector, read_until};
use super::*;
use crate::ssh::test_server::{
    Connected, SERVER_PASSWORD, TestServer, ed25519, isolated_manager, manager_for,
    password_manager_for, start_server, trust_also, trust_only,
};
use std::sync::atomic::{AtomicBool, Ordering};

async fn open(
    terminals: &TerminalManager,
    ssh: &Connected,
) -> Result<(String, Events), TerminalError> {
    let (emit, rx) = collector();
    terminals
        .open(&ssh.manager, "h1", 80, 24, emit)
        .await
        .map(|id| (id, rx))
}

async fn until(what: &str, check: impl AsyncFn() -> bool) {
    for _ in 0..250 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn echoes(terminals: &TerminalManager, id: &str, rx: &mut Events, text: &str) {
    terminals.write(id, &format!("{text}\n")).unwrap();
    read_until(rx, text).await;
}

/// A connected key-authenticated host whose server takes two session channels per connection.
async fn limited(seed: u8) -> (TestServer, Connected) {
    let server = start_server(seed).await;
    server.set_max_sessions(2);
    let ssh = manager_for(&server, "h1");
    ssh.connect().await.unwrap();
    (server, ssh)
}

#[tokio::test]
async fn refused_pty_and_refused_shell_have_their_own_codes() {
    let server = start_server(80).await;
    let ssh = manager_for(&server, "h1");
    ssh.connect().await.unwrap();
    let terminals = TerminalManager::default();

    server.refuse_pty(true);
    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err, TerminalError::PtyRefused);
    assert_eq!(err.code(), "pty_refused");

    server.refuse_pty(false);
    server.refuse_shell(true);
    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err.code(), "shell_refused");

    // Neither is retried on another connection.
    assert_eq!(server.open_sessions(), 1);
    assert_eq!(terminals.count("h1"), 0);

    server.refuse_shell(false);
    let (id, mut rx) = open(&terminals, &ssh).await.unwrap();
    echoes(&terminals, &id, &mut rx, "after refusals").await;
}

#[tokio::test]
async fn a_channel_over_the_limit_opens_on_an_extra_connection() {
    let (server, ssh) = limited(81).await;
    let terminals = TerminalManager::default();
    let (a, mut rx_a) = open(&terminals, &ssh).await.unwrap();
    let (_b, _rx_b) = open(&terminals, &ssh).await.unwrap();
    assert_eq!(server.open_sessions(), 1);

    let (c, mut rx_c) = open(&terminals, &ssh).await.unwrap();
    assert_eq!(server.open_sessions(), 2);
    assert_eq!(ssh.manager.extra_count("h1").await, 1);
    assert_eq!(terminals.count("h1"), 3);
    assert_eq!(ssh.manager.list().await.len(), 1, "extras are not listed");
    echoes(&terminals, &c, &mut rx_c, "on the extra").await;
    echoes(&terminals, &a, &mut rx_a, "on the primary").await;

    // The extra has room for a second channel before another connection is needed.
    let (_d, _rx_d) = open(&terminals, &ssh).await.unwrap();
    assert_eq!(server.open_sessions(), 2);

    let (_e, _rx_e) = open(&terminals, &ssh).await.unwrap();
    assert_eq!(server.open_sessions(), 3);
    assert_eq!(ssh.manager.extra_count("h1").await, 2);
}

#[tokio::test]
async fn closing_the_last_terminal_of_an_extra_connection_closes_it() {
    let (server, ssh) = limited(82).await;
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    let (_b, _rx_b) = open(&terminals, &ssh).await.unwrap();
    let (c, mut rx_c) = open(&terminals, &ssh).await.unwrap();
    assert_eq!(server.open_sessions(), 2);

    terminals.close(&c).unwrap();
    assert_eq!(closed(&mut rx_c).await, CloseReason::Closed);
    until("the extra connection to close", async || {
        server.open_sessions() == 1
    })
    .await;
    assert_eq!(ssh.manager.extra_count("h1").await, 0);
    assert!(ssh.manager.session("h1").await.is_some());
}

#[tokio::test]
async fn disconnect_closes_the_extra_connections_and_their_terminals() {
    let (server, ssh) = limited(83).await;
    let terminals = TerminalManager::default();
    let mut open_ones = Vec::new();
    for _ in 0..5 {
        open_ones.push(open(&terminals, &ssh).await.unwrap());
    }
    assert_eq!(server.open_sessions(), 3);

    ssh.manager.disconnect("h1").await.unwrap();
    for (_, mut rx) in open_ones {
        assert_eq!(closed(&mut rx).await, CloseReason::Closed);
    }
    until("every connection to close", async || {
        server.open_sessions() == 0
    })
    .await;
    assert_eq!(terminals.count("h1"), 0);
}

#[tokio::test]
async fn a_lost_primary_ends_the_terminals_of_its_extras_as_lost() {
    let (server, ssh) = limited(84).await;
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    let (_b, _rx_b) = open(&terminals, &ssh).await.unwrap();
    let (_c, mut rx_c) = open(&terminals, &ssh).await.unwrap();
    server.drop_clients().await;
    assert_eq!(closed(&mut rx_c).await, CloseReason::ConnectionLost);
    until("every connection to close", async || {
        server.open_sessions() == 0
    })
    .await;
}

#[tokio::test]
async fn a_saved_password_opens_an_extra_connection() {
    let server = start_server(85).await;
    server.set_max_sessions(1);
    let ssh = password_manager_for(&server, "h1");
    ssh.save_password(SERVER_PASSWORD);
    ssh.connect().await.unwrap();
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    let (b, mut rx_b) = open(&terminals, &ssh).await.unwrap();
    assert_eq!(server.open_sessions(), 2);
    echoes(&terminals, &b, &mut rx_b, "saved password extra").await;
}

#[tokio::test]
async fn a_typed_secret_that_was_saved_opens_an_extra_connection() {
    let server = start_server(86).await;
    server.set_max_sessions(1);
    let ssh = password_manager_for(&server, "h1");
    ssh.connect_typed(SERVER_PASSWORD, true).await.unwrap();
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    open(&terminals, &ssh).await.unwrap();
    assert_eq!(server.open_sessions(), 2);
}

#[tokio::test]
async fn a_typed_unsaved_secret_gets_no_extra_connection() {
    let server = start_server(87).await;
    server.set_max_sessions(1);
    let ssh = password_manager_for(&server, "h1");
    ssh.connect_typed(SERVER_PASSWORD, false).await.unwrap();
    let terminals = TerminalManager::default();
    let (a, mut rx_a) = open(&terminals, &ssh).await.unwrap();

    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err, TerminalError::ChannelRefused);
    assert_eq!(err.code(), "channel_refused");
    assert_eq!(server.open_sessions(), 1);
    assert_eq!(terminals.count("h1"), 1);
    echoes(&terminals, &a, &mut rx_a, "still usable").await;
}

#[tokio::test]
async fn a_changed_host_key_fails_the_extra_connection_closed() {
    let (server, ssh) = limited(88).await;
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    let (_b, _rx_b) = open(&terminals, &ssh).await.unwrap();
    // Another key for this host is trusted now; the extra connection sees the server's key as
    // changed and must not prompt or accept it.
    trust_only(&ssh, &server, &ed25519(200));

    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err.code(), "host_key_changed");
    until("the refused extra connection to close", async || {
        server.open_sessions() == 1
    })
    .await;
    assert_eq!(ssh.manager.extra_count("h1").await, 0);
}

#[tokio::test]
async fn a_host_changed_since_the_connect_gets_no_extra_connection_and_no_traffic() {
    let server = start_server(89).await;
    server.set_max_sessions(1);
    let mut ssh = password_manager_for(&server, "h1");
    ssh.save_password(SERVER_PASSWORD);
    let current = Arc::new(AtomicBool::new(true));
    let flag = current.clone();
    let manager = std::mem::replace(&mut ssh.manager, isolated_manager(ssh._dir.path()));
    ssh.manager = manager.with_current(Arc::new(move |_| flag.load(Ordering::SeqCst)));
    ssh.connect().await.unwrap();
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    let accepted = server.accepted();

    // The host was edited (variables, hostname) while its primary connection stayed up.
    current.store(false, Ordering::SeqCst);
    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err.code(), "not_found");
    assert_eq!(
        server.accepted(),
        accepted,
        "no connection to the old endpoint"
    );

    // The stale target is forgotten: later refusals do not try again.
    current.store(true, Ordering::SeqCst);
    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err.code(), "channel_refused");
    assert_eq!(server.accepted(), accepted);
}

#[tokio::test]
async fn an_extra_reaching_a_server_with_another_trusted_key_fails_closed() {
    let (server, ssh) = limited(91).await;
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    let (_b, _rx_b) = open(&terminals, &ssh).await.unwrap();
    // Both keys are trusted for host:port, as with several servers behind one name.
    let other = ed25519(201);
    trust_also(&ssh, &server, &other);
    server.set_host_key(other);

    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err.code(), "host_key_changed");
    assert_eq!(ssh.manager.extra_count("h1").await, 0);
    until("the refused extra connection to close", async || {
        server.open_sessions() == 1
    })
    .await;
}

#[tokio::test]
async fn only_a_max_sessions_refusal_opens_an_extra_connection() {
    let (server, ssh) = limited(92).await;
    server.refuse_as_shortage(true);
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    let (_b, _rx_b) = open(&terminals, &ssh).await.unwrap();
    let accepted = server.accepted();

    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err.code(), "channel_refused");
    assert_eq!(server.accepted(), accepted);
}

#[tokio::test]
async fn extra_connections_are_capped_per_connection() {
    let server = start_server(93).await;
    server.set_max_sessions(1);
    let ssh = manager_for(&server, "h1");
    ssh.connect().await.unwrap();
    let terminals = TerminalManager::default();
    let mut open_ones = Vec::new();
    for _ in 0..=crate::ssh::MAX_EXTRAS {
        open_ones.push(open(&terminals, &ssh).await.unwrap());
    }
    assert_eq!(ssh.manager.extra_count("h1").await, crate::ssh::MAX_EXTRAS);
    let accepted = server.accepted();

    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err.code(), "channel_refused");
    assert_eq!(server.accepted(), accepted);
    assert_eq!(server.open_sessions(), crate::ssh::MAX_EXTRAS + 1);
}

#[tokio::test]
async fn a_lease_dropped_outside_the_runtime_still_closes_the_extra_connection() {
    let (server, ssh) = limited(94).await;
    let (_a, _) = ssh.manager.open_channel("h1").await.unwrap();
    let (_b, _) = ssh.manager.open_channel("h1").await.unwrap();
    let (c, session) = ssh.manager.open_channel("h1").await.unwrap();
    assert!(session.lease.is_some());
    assert_eq!(server.open_sessions(), 2);
    drop(c);
    std::thread::spawn(move || drop(session)).join().unwrap();
    until("the extra connection to close", async || {
        server.open_sessions() == 1
    })
    .await;
}

#[tokio::test]
async fn an_unknown_host_key_fails_the_extra_connection_without_a_prompt() {
    let (server, ssh) = limited(90).await;
    let terminals = TerminalManager::default();
    let (_a, _rx_a) = open(&terminals, &ssh).await.unwrap();
    let (_b, _rx_b) = open(&terminals, &ssh).await.unwrap();
    std::fs::remove_file(ssh._dir.path().join("known_hosts")).unwrap();

    let err = open(&terminals, &ssh).await.unwrap_err();
    assert_eq!(err.code(), "host_key_rejected");
    assert_eq!(ssh.manager.extra_count("h1").await, 0);
    until("the refused extra connection to close", async || {
        server.open_sessions() == 1
    })
    .await;
}
