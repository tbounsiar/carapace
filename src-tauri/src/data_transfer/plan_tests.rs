use super::*;
use crate::config::model::{Collection, KeyAlgorithm};
use crate::data_transfer::format::{FORMAT, FileKey, FileProject, VERSION};

pub(crate) fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

pub(crate) fn host(n: u32, name: &str, project: Option<u32>, parent: Option<u32>) -> Node {
    Node::Host(Host {
        id: id(n),
        name: name.into(),
        project_id: project.map(id),
        parent_id: parent.map(id),
        hostname: "h".into(),
        port: "22".into(),
        username: "u".into(),
        auth: AuthMethod::Agent,
    })
}

pub(crate) fn coll(n: u32, name: &str, project: Option<u32>, parent: Option<u32>) -> Node {
    Node::Collection(Collection {
        id: id(n),
        name: name.into(),
        project_id: project.map(id),
        parent_id: parent.map(id),
    })
}

fn with_hostname(mut n: Node, hostname: &str) -> Node {
    if let Node::Host(h) = &mut n {
        h.hostname = hostname.into();
    }
    n
}

fn with_password(mut n: Node, reference: &str) -> Node {
    if let Node::Host(h) = &mut n {
        h.auth = AuthMethod::Password {
            password: Some(reference.into()),
        };
    }
    n
}

pub(crate) fn plain(name: &str, value: &str) -> Variable {
    Variable {
        name: name.into(),
        kind: VariableKind::Plain,
        value: Some(value.into()),
    }
}

pub(crate) fn secret(name: &str) -> Variable {
    Variable {
        name: name.into(),
        kind: VariableKind::Secret,
        value: None,
    }
}

pub(crate) fn project(n: u32, name: &str, vars: Vec<Variable>) -> Project {
    Project {
        id: id(n),
        name: name.into(),
        variables: vars,
    }
}

fn fproject(p: &Project) -> FileProject {
    FileProject {
        id: p.id.clone(),
        name: p.name.clone(),
        variables: format::from_variables(&p.variables),
    }
}

pub(crate) fn local(vars: Vec<Variable>, projects: Vec<Project>, nodes: Vec<Node>) -> ConfigFile {
    ConfigFile {
        variables: vars,
        projects,
        nodes,
        ..ConfigFile::default()
    }
}

pub(crate) fn file(scope: FileScope, cfg: &ConfigFile, keys: Vec<FileKey>) -> DataFile {
    DataFile {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: None,
        app_version: None,
        scope,
        variables: format::from_variables(&cfg.variables),
        projects: cfg.projects.iter().map(fproject).collect(),
        nodes: cfg.nodes.clone(),
        keys,
    }
}

fn run_with(
    local: &ConfigFile,
    file: &DataFile,
    keys: &[KeyProbe],
    connected: &[u32],
    has_value: bool,
    strategy: Strategy,
) -> Outcome {
    let connected: HashSet<String> = connected.iter().map(|n| id(*n)).collect();
    let lookup = move |_: &VarAccount| has_value;
    let ctx = Context {
        local,
        file,
        keys,
        connected: &connected,
        has_value: &lookup,
    };
    plan(&ctx, strategy)
}

fn run(local: &ConfigFile, file: &DataFile, strategy: Strategy) -> Outcome {
    let keys = vec![KeyProbe::Missing; file.keys.len()];
    let out = run_with(local, file, &keys, &[], true, strategy);
    assert!(out.plan.blocking.is_empty(), "{:?}", out.plan.blocking);
    validate::structure(&out.result).unwrap();
    out
}

fn row(out: &Outcome, kind: ItemKind) -> Row {
    *out.plan.rows.iter().find(|r| r.kind == kind).unwrap()
}

fn names(cfg: &ConfigFile) -> Vec<String> {
    let mut v: Vec<String> = cfg.nodes.iter().map(|n| n.name().to_owned()).collect();
    v.sort();
    v
}

fn node<'a>(cfg: &'a ConfigFile, name: &str) -> &'a Node {
    cfg.nodes.iter().find(|n| n.name() == name).unwrap()
}

fn h(cfg: &ConfigFile, name: &str) -> Host {
    node(cfg, name).as_host().unwrap().clone()
}

fn r(
    kind: ItemKind,
    added: usize,
    updated: usize,
    unchanged: usize,
    copied: usize,
    removed: usize,
    skipped: usize,
) -> Row {
    Row {
        kind,
        added,
        updated,
        unchanged,
        copied,
        removed,
        skipped,
    }
}

#[test]
fn merge_updates_a_host_matched_by_id_and_adds_new_ones() {
    let here = local(vec![], vec![], vec![host(1, "api", None, None)]);
    let theirs = local(
        vec![],
        vec![],
        vec![
            with_hostname(host(1, "api", None, None), "b"),
            host(2, "web", None, None),
        ],
    );
    let out = run(
        &here,
        &file(FileScope::Home, &theirs, vec![]),
        Strategy::Merge,
    );
    assert_eq!(h(&out.result, "api").hostname, "b");
    assert_eq!(h(&out.result, "api").id, id(1));
    assert_eq!(h(&out.result, "web").id, id(2));
    assert_eq!(
        row(&out, ItemKind::Host),
        r(ItemKind::Host, 1, 1, 0, 0, 0, 0)
    );
    let item = &out.plan.items[0];
    assert_eq!((item.action, item.reason), (Action::Update, Reason::SameId));
    assert_eq!(
        item.changes,
        vec![Change {
            field: Field::Address,
            from: "u@h:22".into(),
            to: "u@b:22".into()
        }]
    );
    assert_eq!(item.location, vec!["Home".to_string()]);
}

#[test]
fn an_item_matched_by_name_keeps_the_local_id() {
    let here = local(
        vec![],
        vec![project(10, "Payments", vec![])],
        vec![host(1, "api", Some(10), None)],
    );
    let theirs = local(
        vec![],
        vec![project(90, "payments", vec![])],
        vec![host(91, "API", Some(90), None)],
    );
    let out = run(
        &here,
        &file(FileScope::All, &theirs, vec![]),
        Strategy::Merge,
    );
    assert_eq!(out.result.projects.len(), 1);
    assert_eq!(out.result.projects[0].id, id(10));
    assert_eq!(out.result.projects[0].name, "payments");
    let api = h(&out.result, "API");
    assert_eq!(
        (api.id.as_str(), api.project_id.as_deref()),
        (id(1).as_str(), Some(id(10).as_str()))
    );
    let item = out
        .plan
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Host)
        .unwrap();
    assert_eq!(item.reason, Reason::SameName);
    assert_eq!(row(&out, ItemKind::Project).updated, 1);
}

#[test]
fn unchanged_items_are_counted_and_not_listed() {
    let here = local(
        vec![plain("u", "x")],
        vec![],
        vec![coll(5, "Tools", None, None), host(1, "api", None, Some(5))],
    );
    let out = run(
        &here,
        &file(FileScope::Home, &here, vec![]),
        Strategy::Merge,
    );
    assert!(out.plan.items.is_empty());
    assert_eq!(row(&out, ItemKind::Host).unchanged, 1);
    assert_eq!(row(&out, ItemKind::Collection).unchanged, 1);
    assert_eq!(row(&out, ItemKind::Variable).unchanged, 1);
    assert_eq!(out.result, here);
}

#[test]
fn replace_deletes_only_inside_the_covered_part() {
    let here = local(
        vec![plain("g", "1")],
        vec![project(10, "P", vec![])],
        vec![
            host(1, "home-x", None, None),
            host(2, "proj-y", Some(10), None),
            coll(3, "C", None, None),
            host(4, "in-c", None, Some(3)),
        ],
    );
    let theirs = local(vec![], vec![], vec![host(7, "new", None, None)]);
    let f = file(FileScope::Home, &theirs, vec![]);

    let merge = run(&here, &f, Strategy::Merge);
    assert_eq!(merge.result.nodes.len(), 5);

    let out = run_with(&here, &f, &[], &[1, 2], true, Strategy::Replace);
    assert_eq!(names(&out.result), vec!["new", "proj-y"]);
    assert_eq!(out.result.variables, Vec::<Variable>::new());
    let mut removed = out.plan.removed_host_ids.clone();
    removed.sort();
    assert_eq!(removed, vec![id(1), id(4)]);
    assert_eq!(out.keychain.saved_hosts.len(), 2);
    assert_eq!(
        out.plan.affected_connected_hosts,
        vec!["home-x".to_string()]
    );
    assert_eq!(
        row(&out, ItemKind::Host),
        r(ItemKind::Host, 1, 0, 0, 0, 2, 0)
    );
    assert_eq!(row(&out, ItemKind::Collection).removed, 1);
    assert_eq!(row(&out, ItemKind::Variable).removed, 1);
    assert!(
        out.plan
            .items
            .iter()
            .all(|i| i.action == Action::Remove && i.reason == Reason::NotInFile)
    );
}

#[test]
fn replace_with_a_project_file_touches_only_that_project_and_keeps_globals() {
    let here = local(
        vec![plain("g1", "1"), secret("g2")],
        vec![
            project(10, "P", vec![plain("a", "1"), secret("s")]),
            project(11, "Q", vec![]),
        ],
        vec![
            host(1, "p-old", Some(10), None),
            host(2, "q-host", Some(11), None),
            host(3, "home", None, None),
        ],
    );
    let theirs = local(
        vec![plain("g2", "plain now"), plain("g3", "3")],
        vec![project(10, "P", vec![plain("a", "2")])],
        vec![host(5, "p-new", Some(10), None)],
    );
    let f = file(
        FileScope::Project {
            project_id: id(10),
            include_shared: true,
        },
        &theirs,
        vec![],
    );
    let out = run(&here, &f, Strategy::Replace);
    assert_eq!(names(&out.result), vec!["home", "p-new", "q-host"]);
    let globals: Vec<&str> = out
        .result
        .variables
        .iter()
        .map(|v| v.name.as_str())
        .collect();
    assert_eq!(globals, vec!["g1", "g2", "g3"]);
    assert_eq!(
        out.result.variables[1].kind,
        VariableKind::Secret,
        "a shared global secret is never made plain"
    );
    let p = out.result.project(&id(10)).unwrap();
    assert_eq!(p.variables, vec![plain("a", "2")]);
    assert_eq!(
        out.keychain.variables,
        vec![VarAccount {
            project_id: Some(id(10)),
            name: "s".into()
        }]
    );
    assert_eq!(out.plan.secret_values_deleted, 1);
    assert_eq!(out.plan.removed_host_ids, vec![id(1)]);
}

#[test]
fn replace_with_an_all_file_deletes_missing_projects_and_their_secrets() {
    let here = local(
        vec![],
        vec![
            project(10, "Gone", vec![secret("pw"), plain("x", "1")]),
            project(11, "Kept", vec![]),
        ],
        vec![host(1, "a", Some(10), None), host(2, "b", Some(11), None)],
    );
    let theirs = local(
        vec![],
        vec![project(11, "Kept", vec![])],
        vec![host(2, "b", Some(11), None)],
    );
    let out = run(
        &here,
        &file(FileScope::All, &theirs, vec![]),
        Strategy::Replace,
    );
    assert_eq!(out.result.projects.len(), 1);
    assert_eq!(names(&out.result), vec!["b"]);
    assert_eq!(row(&out, ItemKind::Project).removed, 1);
    assert_eq!(row(&out, ItemKind::Variable).removed, 2);
    assert_eq!(out.plan.secret_values_deleted, 1);
    assert_eq!(out.keychain.saved_hosts, vec![id(1)]);
    assert!(out.keychain.variables.contains(&VarAccount {
        project_id: Some(id(10)),
        name: "pw".into()
    }));
}

#[test]
fn keep_both_copies_matches_with_fresh_ids_and_suffixes() {
    let here = local(
        vec![],
        vec![],
        vec![
            host(1, "api", None, None),
            host(2, "api (imported)", None, None),
        ],
    );
    let theirs = local(
        vec![],
        vec![],
        vec![
            with_hostname(host(1, "api", None, None), "b"),
            host(3, "other", None, None),
        ],
    );
    let out = run(
        &here,
        &file(FileScope::Home, &theirs, vec![]),
        Strategy::Duplicate,
    );
    assert_eq!(
        h(&out.result, "api").hostname,
        "h",
        "the local host is untouched"
    );
    let copy = h(&out.result, "api (imported 2)");
    assert_ne!(copy.id, id(1));
    assert_eq!(copy.hostname, "b");
    assert_eq!(h(&out.result, "other").id, id(3));
    assert_eq!(
        row(&out, ItemKind::Host),
        r(ItemKind::Host, 1, 0, 0, 1, 0, 0)
    );
    assert_eq!(
        out.renamed,
        vec![Renamed {
            kind: ItemKind::Host,
            from: "api".into(),
            to: "api (imported 2)".into()
        }]
    );
    let item = &out.plan.items[0];
    assert_eq!((item.action, item.reason), (Action::Copy, Reason::SameId));
    assert_eq!(item.new_name.as_deref(), Some("api (imported 2)"));
}

#[test]
fn keep_both_copies_a_project_with_its_content_and_skips_variables() {
    let here = local(
        vec![plain("g", "local")],
        vec![project(10, "Payments", vec![secret("pw")])],
        vec![
            coll(4, "Backend", Some(10), None),
            host(1, "api", Some(10), Some(4)),
        ],
    );
    let mut theirs = here.clone();
    theirs.variables = vec![plain("g", "theirs"), plain("n", "new")];
    let out = run(
        &here,
        &file(FileScope::All, &theirs, vec![]),
        Strategy::Duplicate,
    );
    assert_eq!(out.result.projects.len(), 2);
    let copy = out.result.projects.iter().find(|p| p.id != id(10)).unwrap();
    assert_eq!(copy.name, "Payments (imported)");
    assert_eq!(copy.variables, vec![secret("pw")]);
    let in_copy: Vec<&Node> = out
        .result
        .nodes
        .iter()
        .filter(|n| n.project_id() == Some(copy.id.as_str()))
        .collect();
    assert_eq!(in_copy.len(), 2);
    let backend = in_copy.iter().find(|n| n.is_collection()).unwrap();
    let api = in_copy.iter().find(|n| !n.is_collection()).unwrap();
    assert_ne!(backend.id(), id(4));
    assert_eq!(
        api.parent_id(),
        Some(backend.id()),
        "children follow their copied parent"
    );
    assert_eq!(api.name(), "api", "no collision in the new project");
    assert_eq!(
        out.result.variables,
        vec![plain("g", "local"), plain("n", "new")]
    );
    let skipped = out
        .plan
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Variable)
        .unwrap();
    assert_eq!(
        (skipped.action, skipped.reason),
        (Action::Skip, Reason::VariableExists)
    );
    assert!(
        out.keychain.variables.is_empty(),
        "a fresh project has no keychain value to clean"
    );
    assert_eq!(row(&out, ItemKind::Project).copied, 1);
    assert_eq!(row(&out, ItemKind::Host).copied, 1);
    let needs = &out.plan.needs_secret;
    assert!(needs.is_empty(), "api uses no secret");
}

#[test]
fn a_moved_collection_takes_its_local_children_along() {
    let here = local(
        vec![],
        vec![project(10, "P", vec![]), project(11, "Q", vec![])],
        vec![
            coll(4, "C", Some(10), None),
            host(1, "x", Some(10), Some(4)),
            host(2, "x", Some(11), None),
        ],
    );
    let theirs = local(
        vec![],
        vec![project(11, "Q", vec![])],
        vec![coll(4, "C", Some(11), None)],
    );
    let f = file(
        FileScope::Project {
            project_id: id(11),
            include_shared: false,
        },
        &theirs,
        vec![],
    );
    let out = run_with(&here, &f, &[], &[1], true, Strategy::Merge);
    validate::structure(&out.result).unwrap();
    let moved = out.result.host(&id(1)).unwrap();
    assert_eq!(moved.project_id.as_deref(), Some(id(11).as_str()));
    assert_eq!(moved.name, "x (imported)", "a host named x is already in Q");
    assert_eq!(out.plan.moved_host_ids, vec![id(1)]);
    assert_eq!(out.keychain.saved_hosts, vec![id(1)]);
    assert_eq!(out.plan.affected_connected_hosts, vec!["x".to_string()]);
    let item = out
        .plan
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Host)
        .unwrap();
    assert_eq!(
        (item.action, item.reason),
        (Action::Rename, Reason::NotInFile)
    );
    assert!(
        item.changes
            .iter()
            .any(|c| c.field == Field::Location && c.from == "P / C" && c.to == "Q / C")
    );
}

#[test]
fn a_host_moved_onto_a_taken_name_is_renamed_and_a_scope_change_is_reported() {
    let here = local(
        vec![],
        vec![project(10, "P", vec![])],
        vec![host(1, "api", None, None), host(2, "api", Some(10), None)],
    );
    let theirs = local(
        vec![],
        vec![project(10, "P", vec![])],
        vec![host(1, "api", Some(10), None)],
    );
    let f = file(
        FileScope::Project {
            project_id: id(10),
            include_shared: false,
        },
        &theirs,
        vec![],
    );
    let out = run(&here, &f, Strategy::Merge);
    let moved = out.result.host(&id(1)).unwrap();
    assert_eq!(moved.name, "api (imported)");
    assert_eq!(out.result.host(&id(2)).unwrap().name, "api");
    assert_eq!(out.plan.moved_host_ids, vec![id(1)]);
    let item = &out.plan.items[0];
    assert_eq!(
        (item.action, item.reason),
        (Action::Rename, Reason::NameTaken)
    );
    assert_eq!(item.changes[0].field, Field::Location);
    assert_eq!(item.changes[0].from, "Home");
}

#[test]
fn suffixes_stay_within_the_name_limit() {
    let long = "a".repeat(100);
    let here = local(vec![], vec![], vec![host(1, &long, None, None)]);
    let theirs = local(vec![], vec![], vec![host(1, &long, None, None)]);
    let out = run(
        &here,
        &file(FileScope::Home, &theirs, vec![]),
        Strategy::Duplicate,
    );
    let copy = out.result.nodes.iter().find(|n| n.id() != id(1)).unwrap();
    assert_eq!(copy.name().chars().count(), 100);
    assert!(copy.name().ends_with(" (imported)"));
}

#[test]
fn an_id_used_by_another_kind_gets_a_fresh_one() {
    let here = local(vec![], vec![], vec![host(1, "api", None, None)]);
    let theirs = local(vec![], vec![], vec![coll(1, "Tools", None, None)]);
    let out = run(
        &here,
        &file(FileScope::Home, &theirs, vec![]),
        Strategy::Merge,
    );
    let tools = node(&out.result, "Tools");
    assert_ne!(tools.id(), id(1));
    assert_eq!(row(&out, ItemKind::Collection).added, 1);
}

#[test]
fn variable_rules_per_strategy() {
    let here = local(
        vec![
            plain("same", "1"),
            plain("p2p", "old"),
            plain("p2s", "x"),
            secret("s2p"),
            secret("s2s"),
            plain("Case", "c"),
        ],
        vec![],
        vec![],
    );
    let theirs = local(
        vec![
            plain("same", "1"),
            plain("p2p", "new"),
            secret("p2s"),
            plain("s2p", "v"),
            secret("s2s"),
            plain("case", "d"),
            secret("added"),
        ],
        vec![],
        vec![],
    );
    let f = file(FileScope::Home, &theirs, vec![]);
    let find = |o: &Outcome, n: &str| o.result.variables.iter().find(|v| v.name == n).cloned();
    let reason = |o: &Outcome, n: &str| {
        o.plan
            .items
            .iter()
            .find(|i| i.name == n)
            .map(|i| (i.action, i.reason))
    };

    let m = run(&here, &f, Strategy::Merge);
    assert_eq!(find(&m, "p2p"), Some(plain("p2p", "new")));
    assert_eq!(find(&m, "p2s"), Some(secret("p2s")));
    assert_eq!(
        reason(&m, "p2s"),
        Some((Action::Update, Reason::BecomesSecret))
    );
    assert_eq!(
        find(&m, "s2p"),
        Some(secret("s2p")),
        "merge never deletes a secret value"
    );
    assert_eq!(reason(&m, "s2p"), Some((Action::Skip, Reason::KeptSecret)));
    assert_eq!(
        reason(&m, "case"),
        Some((Action::Skip, Reason::VariableExists))
    );
    assert!(find(&m, "case").is_none(), "variables are never renamed");
    assert_eq!(find(&m, "Case"), Some(plain("Case", "c")));
    assert_eq!(m.plan.secret_values_deleted, 0);
    let accounts: Vec<&str> = m
        .keychain
        .variables
        .iter()
        .map(|a| a.name.as_str())
        .collect();
    assert_eq!(
        accounts,
        vec!["p2s", "added"],
        "leftover accounts of new secrets are cleared"
    );
    assert_eq!(
        row(&m, ItemKind::Variable),
        r(ItemKind::Variable, 1, 2, 2, 0, 0, 2)
    );
    let change = &m
        .plan
        .items
        .iter()
        .find(|i| i.name == "p2p")
        .unwrap()
        .changes[0];
    assert_eq!(
        (change.field, change.from.as_str(), change.to.as_str()),
        (Field::Value, "old", "new")
    );

    let rp = run(&here, &f, Strategy::Replace);
    assert_eq!(find(&rp, "s2p"), Some(plain("s2p", "v")));
    assert_eq!(find(&rp, "case"), Some(plain("case", "d")));
    assert!(find(&rp, "Case").is_none());
    assert_eq!(rp.plan.secret_values_deleted, 1);
    assert!(rp.keychain.variables.iter().any(|a| a.name == "s2p"));
    let order: Vec<&str> = rp
        .result
        .variables
        .iter()
        .map(|v| v.name.as_str())
        .collect();
    assert_eq!(
        order,
        vec!["same", "p2p", "p2s", "s2p", "s2s", "case", "added"]
    );

    let d = run(&here, &f, Strategy::Duplicate);
    assert_eq!(find(&d, "p2p"), Some(plain("p2p", "old")));
    assert_eq!(find(&d, "p2s"), Some(plain("p2s", "x")));
    assert_eq!(find(&d, "added"), Some(secret("added")));
    assert_eq!(row(&d, ItemKind::Variable).skipped, 4);
}

fn info(algorithm: KeyAlgorithm) -> KeyInfo {
    KeyInfo {
        algorithm,
        bits: None,
        public_key: "ssh-ed25519 AAAA c".into(),
        fingerprint: "SHA256:x".into(),
        comment: "c".into(),
        encrypted: false,
    }
}

fn fkey(n: u32, name: &str, path: &str) -> FileKey {
    FileKey {
        id: id(n),
        name: name.into(),
        path: path.into(),
        algorithm: KeyAlgorithm::Ed25519,
        bits: None,
    }
}

fn entry(n: u32, name: &str, path: &str) -> KeyEntry {
    KeyEntry {
        id: id(n),
        name: name.into(),
        path: path.into(),
        managed: true,
        origin: KeyOrigin::Generated,
        algorithm: KeyAlgorithm::Ed25519,
        bits: None,
        public_key: "p".into(),
        fingerprint: "f".into(),
        comment: String::new(),
        encrypted: false,
    }
}

#[test]
fn key_entries_are_added_unmanaged_renamed_or_skipped_never_deleted() {
    let mut here = local(vec![], vec![], vec![]);
    here.keys = vec![entry(1, "Work", "/k/work"), entry(2, "Laptop", "/k/laptop")];
    let keys = vec![
        fkey(1, "Renamed work", "~/x"),
        fkey(3, "Laptop", "~/new"),
        fkey(4, "Gone", "~/gone"),
        fkey(5, "Wrong", "~/rsa"),
    ];
    let probes = vec![
        KeyProbe::Found("/k/work".into(), info(KeyAlgorithm::Ed25519)),
        KeyProbe::Found("/k/new".into(), info(KeyAlgorithm::Ed25519)),
        KeyProbe::Missing,
        KeyProbe::Mismatch,
    ];
    let f = file(FileScope::All, &local(vec![], vec![], vec![]), keys);

    let out = run_with(&here, &f, &probes, &[], true, Strategy::Replace);
    assert_eq!(
        out.result.keys.len(),
        3,
        "replace never deletes key entries"
    );
    let work = &out.result.keys[0];
    assert_eq!(
        (work.id.as_str(), work.name.as_str()),
        (id(1).as_str(), "Renamed work")
    );
    assert!(
        work.managed && work.origin == KeyOrigin::Generated,
        "a matched entry keeps its origin"
    );
    let added = &out.result.keys[2];
    assert_ne!(added.id, id(3), "key ids from a file are never reused");
    assert_eq!(added.name, "Laptop (imported)");
    assert_eq!(added.path, "/k/new");
    assert!(!added.managed);
    assert_eq!(added.origin, KeyOrigin::Imported);
    assert_eq!(row(&out, ItemKind::Key), r(ItemKind::Key, 1, 1, 0, 0, 0, 2));
    let reasons: Vec<Reason> = out
        .plan
        .items
        .iter()
        .filter(|i| i.kind == ItemKind::Key)
        .map(|i| i.reason)
        .collect();
    assert_eq!(
        reasons,
        vec![
            Reason::SameId,
            Reason::NameTaken,
            Reason::KeyFileMissing,
            Reason::KeyFileMismatch
        ]
    );
    let missing = out
        .plan
        .items
        .iter()
        .find(|i| i.reason == Reason::KeyFileMissing)
        .unwrap();
    assert_eq!(missing.path.as_deref(), Some("~/gone"));
    assert!(missing.location.is_empty());
    let mismatch = out
        .plan
        .items
        .iter()
        .find(|i| i.reason == Reason::KeyFileMismatch)
        .unwrap();
    assert_eq!(mismatch.detail.as_deref(), Some("ed25519"));
    let json = serde_json::to_value(mismatch).unwrap();
    assert_eq!(
        (json["path"].as_str(), json["detail"].as_str()),
        (Some("~/rsa"), Some("ed25519"))
    );
    assert_eq!(out.skipped.len(), 2);

    let dup = run_with(&here, &f, &probes, &[], true, Strategy::Duplicate);
    assert_eq!(
        dup.result.keys[0].name, "Work",
        "keep both skips an entry with the same path"
    );
    assert_eq!(row(&dup, ItemKind::Key).skipped, 3);
}

#[test]
fn secrets_to_set_and_undefined_variables_are_listed_once_per_variable() {
    let here = local(vec![secret("pw")], vec![], vec![]);
    let theirs = local(
        vec![secret("pw")],
        vec![project(10, "P", vec![secret("ppw")])],
        vec![
            with_password(host(1, "a", None, None), "${pw}"),
            with_password(host(2, "b", None, None), "${pw}"),
            with_password(host(3, "c", Some(10), None), "${ppw}"),
            with_hostname(host(4, "d", None, None), "${nope}"),
        ],
    );
    let f = file(FileScope::All, &theirs, vec![]);
    let out = run_with(&here, &f, &[], &[], false, Strategy::Merge);
    assert_eq!(
        out.plan.needs_secret,
        vec![
            NeedsSecret {
                scope: SecretScope::Global,
                name: "pw".into(),
                host_count: 2
            },
            NeedsSecret {
                scope: SecretScope::Project {
                    project_id: id(10),
                    project_name: "P".into()
                },
                name: "ppw".into(),
                host_count: 1
            },
        ]
    );
    assert_eq!(
        out.plan.undefined_variables,
        vec![Undefined {
            name: "nope".into(),
            host_count: 1
        }]
    );
    let with_value = run_with(&here, &f, &[], &[], true, Strategy::Merge);
    assert_eq!(
        with_value.plan.needs_secret.len(),
        1,
        "only the new project's secret has no value"
    );
}

#[test]
fn limits_block_a_strategy_not_the_others() {
    let many: Vec<Variable> = (0..150).map(|i| plain(&format!("v{i}"), "x")).collect();
    let more: Vec<Variable> = (150..300).map(|i| plain(&format!("v{i}"), "x")).collect();
    let here = local(many, vec![], vec![]);
    let f = file(FileScope::Home, &local(more, vec![], vec![]), vec![]);
    let merge = run_with(&here, &f, &[], &[], true, Strategy::Merge);
    assert_eq!(
        merge.plan.blocking,
        vec!["there would be 300 global variables (max 200)".to_string()]
    );
    let replace = run_with(&here, &f, &[], &[], true, Strategy::Replace);
    assert!(replace.plan.blocking.is_empty());
}

#[test]
fn items_are_grouped_and_capped() {
    let here = local(
        vec![],
        vec![],
        (0..600)
            .map(|i| host(i, &format!("h{i}"), None, None))
            .collect(),
    );
    let theirs = local(
        vec![],
        vec![],
        vec![with_hostname(host(1, "h1", None, None), "z")],
    );
    let out = run(
        &here,
        &file(FileScope::Home, &theirs, vec![]),
        Strategy::Replace,
    );
    assert_eq!(out.plan.items.len(), 500);
    assert_eq!(out.plan.more_items, 100);
    assert_eq!(out.plan.items[0].action, Action::Update);
    assert_eq!(out.plan.items[1].action, Action::Remove);
}

#[test]
fn plans_serialize_with_the_contract_names() {
    let here = local(vec![], vec![], vec![host(1, "api", None, None)]);
    let theirs = local(
        vec![],
        vec![],
        vec![with_hostname(host(1, "api", None, None), "b")],
    );
    let out = run(
        &here,
        &file(FileScope::Home, &theirs, vec![]),
        Strategy::Merge,
    );
    let json = serde_json::to_value(&out.plan).unwrap();
    for key in [
        "rows",
        "items",
        "moreItems",
        "removedHostIds",
        "movedHostIds",
        "affectedConnectedHosts",
        "secretValuesDeleted",
        "savedSecretHosts",
        "needsSecret",
        "undefinedVariables",
        "blocking",
    ] {
        assert!(json.get(key).is_some(), "{key}");
    }
    assert_eq!(
        json["items"][0],
        serde_json::json!({"kind":"host","action":"update","name":"api","newName":null,
            "location":["Home"],"reason":"same_id",
            "changes":[{"field":"address","from":"u@h:22","to":"u@b:22"}]})
    );
    assert_eq!(
        json["rows"][2],
        serde_json::json!({"kind":"host","added":0,"updated":1,"unchanged":0,"copied":0,"removed":0,"skipped":0})
    );
    let scope = serde_json::to_value(SecretScope::Project {
        project_id: "p".into(),
        project_name: "P".into(),
    })
    .unwrap();
    assert_eq!(
        scope,
        serde_json::json!({"kind":"project","projectId":"p","projectName":"P"})
    );
    assert_eq!(
        serde_json::to_value(Strategy::Duplicate).unwrap(),
        "duplicate"
    );
}

fn with_address(mut n: Node, hostname: &str, username: &str) -> Node {
    if let Node::Host(h) = &mut n {
        h.hostname = hostname.into();
        h.username = username.into();
    }
    n
}

fn sent(out: &Outcome) -> Vec<(String, String, Option<String>, String)> {
    out.plan
        .secrets_sent_to
        .iter()
        .map(|s| {
            (
                s.host.clone(),
                s.variable.clone(),
                s.from.clone(),
                s.to.clone(),
            )
        })
        .collect()
}

#[test]
fn a_new_host_using_a_stored_secret_is_listed() {
    let here = local(vec![secret("prod_root_pw")], vec![], vec![]);
    let theirs = local(
        vec![],
        vec![],
        vec![with_password(
            with_address(host(1, "evil", None, None), "10.9.9.9", "root"),
            "${prod_root_pw}",
        )],
    );
    let f = file(FileScope::Home, &theirs, vec![]);
    let out = run_with(&here, &f, &[], &[], true, Strategy::Merge);
    assert_eq!(
        sent(&out),
        vec![(
            "evil".into(),
            "prod_root_pw".into(),
            None,
            "root@10.9.9.9:22".into()
        )]
    );
    assert_eq!(
        out.plan.secrets_sent_to[0].location,
        vec!["Home".to_string()]
    );
    let no_value = run_with(&here, &f, &[], &[], false, Strategy::Merge);
    assert!(
        no_value.plan.secrets_sent_to.is_empty(),
        "nothing stored, nothing sent"
    );
}

#[test]
fn an_unchanged_host_sends_nothing_new_and_a_copy_is_new() {
    let here = local(
        vec![secret("pw"), secret("other")],
        vec![],
        vec![with_password(host(1, "api", None, None), "${pw}")],
    );
    let f = file(FileScope::Home, &here, vec![]);
    assert!(
        run(&here, &f, Strategy::Merge)
            .plan
            .secrets_sent_to
            .is_empty()
    );
    let mut theirs = here.clone();
    theirs.nodes = vec![with_password(host(1, "api", None, None), "${other}")];
    let switched = run(
        &here,
        &file(FileScope::Home, &theirs, vec![]),
        Strategy::Merge,
    );
    assert_eq!(
        sent(&switched),
        vec![(
            "api".into(),
            "other".into(),
            Some("u@h:22".into()),
            "u@h:22".into()
        )],
        "another stored secret sent to the same server is listed"
    );
    let dup = run(&here, &f, Strategy::Duplicate);
    assert_eq!(
        sent(&dup),
        vec![("api (imported)".into(), "pw".into(), None, "u@h:22".into())]
    );
}

#[test]
fn a_shared_global_change_redirects_hosts_everywhere() {
    let here = local(
        vec![plain("bastion", "10.0.0.1"), secret("pw")],
        vec![project(10, "P", vec![]), project(11, "Q", vec![])],
        vec![
            with_password(
                with_address(host(1, "q-host", Some(11), None), "${bastion}", "u"),
                "${pw}",
            ),
            with_address(host(2, "p-host", Some(10), None), "${bastion}", "u"),
        ],
    );
    let theirs = local(
        vec![plain("bastion", "10.6.6.6")],
        vec![project(10, "P", vec![])],
        vec![with_address(
            host(2, "p-host", Some(10), None),
            "${bastion}",
            "u",
        )],
    );
    let f = file(
        FileScope::Project {
            project_id: id(10),
            include_shared: true,
        },
        &theirs,
        vec![],
    );
    let out = run(&here, &f, Strategy::Merge);
    assert_eq!(
        sent(&out),
        vec![(
            "q-host".into(),
            "pw".into(),
            Some("u@10.0.0.1:22".into()),
            "u@10.6.6.6:22".into()
        )]
    );
    let item = out
        .plan
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Variable && i.name == "bastion")
        .unwrap();
    assert_eq!(item.reason, Reason::SameName);
    let mut moved = item.redirects.clone();
    moved.sort();
    assert_eq!(moved, vec!["p-host".to_string(), "q-host".to_string()]);
    let json = serde_json::to_value(item).unwrap();
    assert!(json["redirects"].is_array());
}

#[test]
fn a_new_project_variable_shadowing_a_global_is_listed_with_the_hosts_it_moves() {
    let here = local(
        vec![plain("addr", "10.0.0.1"), secret("pw")],
        vec![project(10, "P", vec![])],
        vec![with_password(
            with_address(host(1, "api", Some(10), None), "${addr}", "u"),
            "${pw}",
        )],
    );
    let mut theirs = here.clone();
    theirs.variables.clear();
    theirs.projects[0].variables = vec![plain("addr", "10.6.6.6")];
    let f = file(
        FileScope::Project {
            project_id: id(10),
            include_shared: false,
        },
        &theirs,
        vec![],
    );
    let out = run(&here, &f, Strategy::Merge);
    let item = out
        .plan
        .items
        .iter()
        .find(|i| i.reason == Reason::RedirectsHosts)
        .unwrap();
    assert_eq!(
        (item.name.as_str(), item.location.clone()),
        ("addr", vec!["P".to_string()])
    );
    assert_eq!(item.redirects, vec!["api".to_string()]);
    assert_eq!(sent(&out).len(), 1);
    let json = serde_json::to_value(&out.plan).unwrap();
    assert_eq!(json["secretsSentTo"][0]["from"], "u@10.0.0.1:22");
    assert_eq!(json["secretsSentTo"][0]["to"], "u@10.6.6.6:22");
}

#[test]
fn a_refused_key_path_is_reported_as_not_found_outside_home() {
    let f = file(
        FileScope::All,
        &local(vec![], vec![], vec![]),
        vec![fkey(1, "k", "/net/host/k")],
    );
    let out = run_with(
        &local(vec![], vec![], vec![]),
        &f,
        &[KeyProbe::Refused],
        &[],
        true,
        Strategy::Merge,
    );
    let item = &out.plan.items[0];
    assert_eq!(item.reason, Reason::KeyFileMissing);
    assert_eq!(item.detail.as_deref(), Some("outside_home"));
}

#[test]
fn counts_beyond_the_caps_block() {
    let mut here = local(vec![], vec![], vec![]);
    here.keys = (0..501)
        .map(|i| entry(i, &format!("k{i}"), &format!("/k/{i}")))
        .collect();
    let f = file(FileScope::Home, &local(vec![], vec![], vec![]), vec![]);
    let out = run_with(&here, &f, &[], &[], true, Strategy::Merge);
    assert_eq!(
        out.plan.blocking,
        vec!["there would be 501 SSH keys (max 500)".to_string()]
    );
}
