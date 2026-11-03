use std::fs;

use super::super::FILE_NAME;
use super::*;
use crate::config::model::AuthMethod;

fn store() -> (tempfile::TempDir, ConfigStore) {
    let dir = tempfile::tempdir().unwrap();
    let s = ConfigStore::new(dir.path().to_path_buf());
    (dir, s)
}

fn input(name: &str) -> HostInput {
    HostInput {
        name: name.into(),
        hostname: "example.com".into(),
        port: "22".into(),
        username: "deploy".into(),
        auth: AuthMethod::Agent,
    }
}

fn invalid<T: std::fmt::Debug>(r: Result<T, ConfigError>) {
    assert!(matches!(r, Err(ConfigError::InvalidInput(_))), "{r:?}");
}

fn not_found<T: std::fmt::Debug>(r: Result<T, ConfigError>, what: &str) {
    match r {
        Err(e @ ConfigError::NotFound(_)) => assert_eq!(e.to_string(), format!("{what} not found")),
        other => panic!("{other:?}"),
    }
}

fn conflict<T: std::fmt::Debug>(r: Result<T, ConfigError>) {
    assert!(matches!(r, Err(ConfigError::Conflict(_))), "{r:?}");
}

fn name_taken<T: std::fmt::Debug>(r: Result<T, ConfigError>, message: &str) {
    match r {
        Err(ConfigError::NameTaken(m)) => assert_eq!(m, message),
        other => panic!("{other:?}"),
    }
}

fn raw(d: &tempfile::TempDir) -> Vec<u8> {
    fs::read(d.path().join(FILE_NAME)).unwrap()
}

/// Payments (dev, prod) with Backend > Api, and Home with Tools.
struct World {
    d: tempfile::TempDir,
    s: ConfigStore,
    pay: String,
    backend: String,
    api: String,
    tools: String,
}

fn world() -> World {
    let (d, s) = store();
    let pay = s.create_project("Payments").unwrap().id;
    let backend = s.create_collection(Some(&pay), None, "Backend").unwrap().id;
    let api = s
        .create_collection(Some(&pay), Some(&backend), "Api")
        .unwrap()
        .id;
    let tools = s.create_collection(None, None, "Tools").unwrap().id;
    World {
        d,
        s,
        pay,
        backend,
        api,
        tools,
    }
}

fn host(w: &World, project: Option<&str>, parent: Option<&str>, name: &str) -> String {
    w.s.create_host(project, parent, &input(name)).unwrap().id
}

#[test]
fn collections_live_in_home_projects_and_collections() {
    let w = world();
    let cfg = w.s.snapshot().unwrap();
    let api = cfg.node(&w.api).unwrap();
    assert_eq!(api.project_id(), Some(w.pay.as_str()));
    assert_eq!(api.parent_id(), Some(w.backend.as_str()));
    let tools = cfg.node(&w.tools).unwrap();
    assert_eq!((tools.project_id(), tools.parent_id()), (None, None));
    let json: serde_json::Value = serde_json::from_slice(&raw(&w.d)).unwrap();
    let tools = json["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == w.tools)
        .unwrap();
    assert_eq!(
        *tools,
        serde_json::json!({"kind":"collection","id":w.tools,"name":"Tools","projectId":null,"parentId":null})
    );
}

#[test]
fn collection_names_are_unique_among_siblings_only() {
    let w = world();
    conflict(w.s.create_collection(Some(&w.pay), None, "BACKEND"));
    conflict(w.s.create_collection(Some(&w.pay), Some(&w.backend), " api "));
    assert!(w.s.create_collection(None, None, "Backend").is_ok());
    assert!(
        w.s.create_collection(Some(&w.pay), Some(&w.api), "Backend")
            .is_ok()
    );
    host(&w, Some(&w.pay), None, "Shared");
    assert!(w.s.create_collection(Some(&w.pay), None, "Shared").is_ok());
    invalid(w.s.create_collection(None, None, " "));
    invalid(w.s.create_collection(None, None, &"a".repeat(101)));
}

#[test]
fn collection_location_is_checked() {
    let w = world();
    not_found(w.s.create_collection(Some("nope"), None, "x"), "project");
    not_found(w.s.create_collection(None, Some("nope"), "x"), "collection");
    let h = host(&w, None, None, "web");
    invalid(w.s.create_collection(None, Some(&h), "x"));
    invalid(w.s.create_collection(None, Some(&w.backend), "x"));
    invalid(w.s.create_collection(Some(&w.pay), Some(&w.tools), "x"));
    invalid(w.s.create_host(None, Some(&w.backend), &input("x")));
    invalid(w.s.create_host(None, Some(&h), &input("x")));
    not_found(
        w.s.create_host(None, Some("nope"), &input("x")),
        "collection",
    );
}

#[test]
fn collections_nest_32_deep_at_most() {
    let (_d, s) = store();
    let mut parent: Option<String> = None;
    for i in 0..MAX_DEPTH {
        parent = Some(
            s.create_collection(None, parent.as_deref(), &format!("c{i}"))
                .unwrap()
                .id,
        );
    }
    invalid(s.create_collection(None, parent.as_deref(), "deep"));
    assert!(s.create_host(None, parent.as_deref(), &input("h")).is_ok());

    // A two-level subtree fits under level 30 (c29) but not under level 31 (c30).
    let top = s.create_collection(None, None, "top").unwrap().id;
    s.create_collection(None, Some(&top), "child").unwrap();
    let level = |name: &str| {
        let cfg = s.snapshot().unwrap();
        cfg.nodes
            .iter()
            .find(|n| n.name() == name)
            .unwrap()
            .id()
            .to_string()
    };
    invalid(s.plan_move(&top, None, Some(&level("c30"))));
    assert!(s.move_node(&top, None, Some(&level("c29")), |_| {}).is_ok());
}

#[test]
fn node_count_is_limited() {
    let (d, s) = store();
    let nodes: Vec<serde_json::Value> = (0..MAX_NODES)
        .map(|i| {
            serde_json::json!({"kind":"collection","id":uuid::Uuid::new_v4().to_string(),
                "name":format!("c{i}"),"projectId":null,"parentId":null})
        })
        .collect();
    fs::write(
        d.path().join(FILE_NAME),
        serde_json::to_vec(&serde_json::json!({"version":3,"nodes":nodes})).unwrap(),
    )
    .unwrap();
    invalid(s.create_collection(None, None, "one more"));
    invalid(s.create_host(None, None, &input("one more")));
}

#[test]
fn host_names_are_unique_in_the_whole_scope() {
    let w = world();
    host(&w, Some(&w.pay), Some(&w.api), "ui");
    conflict(w.s.create_host(Some(&w.pay), None, &input("UI")));
    conflict(w.s.create_host(Some(&w.pay), Some(&w.backend), &input("ui")));
    let home = host(&w, None, Some(&w.tools), "ui");
    conflict(w.s.create_host(None, None, &input("Ui")));
    let other = host(&w, None, None, "db");
    conflict(w.s.update_host(&other, &input("UI")));
    let same = w.s.update_host(&home, &input("UI")).unwrap();
    assert_eq!(same.name, "UI");
    assert_eq!(same.parent_id.as_deref(), Some(w.tools.as_str()));
    assert!(same.project_id.is_none());
    not_found(w.s.update_host("nope", &input("x")), "host");
    not_found(w.s.update_host(&w.tools, &input("x")), "host");
}

#[test]
fn rename_collection_rules() {
    let w = world();
    let before = raw(&w.d);
    let same = w.s.rename_collection(&w.backend, " Backend ").unwrap();
    assert_eq!(same.name, "Backend");
    assert_eq!(raw(&w.d), before, "same name rewrites nothing");
    w.s.create_collection(Some(&w.pay), None, "Frontend")
        .unwrap();
    conflict(w.s.rename_collection(&w.backend, "frontend"));
    assert_eq!(
        w.s.rename_collection(&w.backend, "BACKEND").unwrap().name,
        "BACKEND"
    );
    let h = host(&w, None, None, "web");
    not_found(w.s.rename_collection(&h, "x"), "collection");
    not_found(w.s.rename_collection("nope", "x"), "collection");
    invalid(w.s.rename_collection(&w.backend, ""));
}

#[test]
fn delete_collection_is_recursive() {
    let w = world();
    let h1 = host(&w, Some(&w.pay), Some(&w.backend), "a");
    let h2 = host(&w, Some(&w.pay), Some(&w.api), "b");
    let kept = host(&w, Some(&w.pay), None, "c");
    let removed = w.s.delete_collection(&w.backend).unwrap();
    let mut cids: Vec<_> = removed.collections.iter().map(|c| c.id.clone()).collect();
    cids.sort();
    let mut expected = vec![w.backend.clone(), w.api.clone()];
    expected.sort();
    assert_eq!(cids, expected);
    let mut hids: Vec<_> = removed.hosts.iter().map(|h| h.id.clone()).collect();
    hids.sort();
    let mut expected = vec![h1, h2];
    expected.sort();
    assert_eq!(hids, expected);
    let cfg = w.s.snapshot().unwrap();
    let left: Vec<_> = cfg.nodes.iter().map(|n| n.id().to_string()).collect();
    assert_eq!(left, vec![w.tools.clone(), kept]);
    not_found(w.s.delete_collection(&w.backend), "collection");
}

#[test]
fn host_and_project_deletes_report_what_left() {
    let w = world();
    let nested = host(&w, Some(&w.pay), Some(&w.api), "a");
    let root = host(&w, Some(&w.pay), None, "b");
    let home = host(&w, None, Some(&w.tools), "c");
    assert_eq!(w.s.delete_host(&home).unwrap().id, home);
    not_found(w.s.delete_host(&home), "host");
    not_found(w.s.delete_host(&w.tools), "host");
    assert_eq!(w.s.delete_host(&root).unwrap().id, root);
    let (p, hosts) = w.s.delete_project(&w.pay).unwrap();
    assert_eq!(p.id, w.pay);
    assert_eq!(
        hosts.iter().map(|h| h.id.clone()).collect::<Vec<_>>(),
        vec![nested]
    );
    let cfg = w.s.snapshot().unwrap();
    assert_eq!(cfg.nodes.len(), 1);
    assert_eq!(cfg.nodes[0].id(), w.tools);
}

#[test]
fn move_within_a_scope() {
    let w = world();
    let h = host(&w, Some(&w.pay), None, "ui");
    let m =
        w.s.move_node(&h, Some(&w.pay), Some(&w.api), |_| {})
            .unwrap();
    assert!(!m.scope_changed);
    assert_eq!(m.nodes.len(), 1);
    assert_eq!(m.nodes[0].parent_id(), Some(w.api.as_str()));
    assert_eq!(
        w.s.snapshot()
            .unwrap()
            .host(&h)
            .unwrap()
            .parent_id
            .as_deref(),
        Some(w.api.as_str())
    );

    let before = raw(&w.d);
    let mut called = false;
    let same =
        w.s.move_node(&h, Some(&w.pay), Some(&w.api), |_| called = true)
            .unwrap();
    assert!(!called && !same.scope_changed);
    assert_eq!(raw(&w.d), before);

    let m = w.s.move_node(&w.api, Some(&w.pay), None, |_| {}).unwrap();
    assert_eq!(m.nodes.len(), 2);
    assert_eq!(m.nodes[0].id(), w.api);
    assert_eq!(m.nodes[1].id(), h);
    assert_eq!(m.nodes[1].parent_id(), Some(w.api.as_str()));
}

#[test]
fn move_rejects_cycles_and_bad_targets() {
    let w = world();
    let h = host(&w, Some(&w.pay), None, "ui");
    for target in [&w.backend, &w.api] {
        let r = w.s.plan_move(&w.backend, Some(&w.pay), Some(target));
        invalid(r);
    }
    invalid(w.s.plan_move(&w.backend, Some(&w.pay), Some(&h)));
    invalid(w.s.plan_move(&h, None, Some(&w.backend)));
    invalid(w.s.plan_move(&h, Some(&w.pay), Some(&w.tools)));
    not_found(w.s.plan_move("nope", None, None), "node");
    not_found(w.s.plan_move(&h, Some("nope"), None), "project");
    not_found(w.s.plan_move(&h, None, Some("nope")), "collection");
}

#[test]
fn move_conflicts_name_the_item_and_the_target() {
    let w = world();
    host(&w, Some(&w.pay), Some(&w.api), "ui");
    let home_ui = host(&w, None, Some(&w.tools), "UI");
    name_taken(
        w.s.plan_move(&home_ui, Some(&w.pay), None),
        "a host named \"UI\" already exists in Payments",
    );
    let pay_db = host(&w, Some(&w.pay), None, "db");
    host(&w, None, None, "DB");
    name_taken(
        w.s.plan_move(&pay_db, None, Some(&w.tools)),
        "a host named \"db\" already exists in Home",
    );
    name_taken(
        w.s.plan_move(&w.backend, None, None),
        "a host named \"ui\" already exists in Home",
    );
    let other =
        w.s.create_collection(Some(&w.pay), Some(&w.api), "Tools")
            .unwrap();
    name_taken(
        w.s.plan_move(&other.id, None, None),
        "a collection named \"Tools\" already exists in Home",
    );
    w.s.create_collection(Some(&w.pay), Some(&w.backend), "tools")
        .unwrap();
    name_taken(
        w.s.plan_move(&other.id, Some(&w.pay), Some(&w.backend)),
        "a collection named \"Tools\" already exists in Backend",
    );
}

#[test]
fn cross_scope_move_takes_the_subtree() {
    let w = world();
    let a = host(&w, Some(&w.pay), Some(&w.backend), "a");
    let b = host(&w, Some(&w.pay), Some(&w.api), "b");
    let before = raw(&w.d);
    let planned = w.s.plan_move(&w.backend, None, Some(&w.tools)).unwrap();
    assert_eq!(raw(&w.d), before, "planning writes nothing");
    let mut seen = None;
    let m =
        w.s.move_node(&w.backend, None, Some(&w.tools), |m| seen = Some(m.clone()))
            .unwrap();
    assert_eq!(seen.as_ref(), Some(&m));
    assert_eq!(planned, m);
    assert!(m.scope_changed);
    let mut ids = m.host_ids();
    ids.sort();
    let mut expected = vec![a.clone(), b.clone()];
    expected.sort();
    assert_eq!(ids, expected);
    let cfg = w.s.snapshot().unwrap();
    for id in [&w.backend, &w.api, &a, &b] {
        assert_eq!(cfg.node(id).unwrap().project_id(), None, "{id}");
    }
    assert_eq!(
        cfg.node(&w.backend).unwrap().parent_id(),
        Some(w.tools.as_str())
    );
    assert_eq!(
        cfg.node(&w.api).unwrap().parent_id(),
        Some(w.backend.as_str())
    );
    assert_eq!(
        cfg.host(&b).unwrap().parent_id.as_deref(),
        Some(w.api.as_str())
    );

    let back = w.s.move_node(&a, Some(&w.pay), None, |_| {}).unwrap();
    assert!(back.scope_changed);
}

#[test]
fn failed_move_does_not_call_back_or_write() {
    let w = world();
    let before = raw(&w.d);
    let mut called = false;
    invalid(w.s.move_node(&w.backend, Some(&w.pay), Some(&w.api), |_| called = true));
    assert!(!called);
    assert_eq!(raw(&w.d), before);
}
