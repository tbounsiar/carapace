use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::export::references;
use super::format::{self, DataFile, FileScope, FileVariable};
use crate::config::model::{
    AuthMethod, Collection, ConfigFile, Host, KeyEntry, KeyOrigin, Node, Project, Variable,
    VariableKind,
};
use crate::config::same_path;
use crate::config::validate::{self, MAX_DEPTH, MAX_NODES, MAX_VARIABLES, same_name};
use crate::keys::KeyInfo;
use crate::vars::{Layers, Level, resolve_host};

const MAX_ITEMS: usize = 500;
const MAX_NAME: usize = 100;
const MAX_KEY_NAME: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strategy {
    Merge,
    Replace,
    Duplicate,
}

impl Strategy {
    pub const ALL: [Strategy; 3] = [Strategy::Merge, Strategy::Replace, Strategy::Duplicate];

    pub fn label(self) -> &'static str {
        match self {
            Strategy::Merge => "Merge",
            Strategy::Replace => "Replace",
            Strategy::Duplicate => "Keep both",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Project,
    Collection,
    Host,
    Variable,
    Key,
}

impl ItemKind {
    const ALL: [ItemKind; 5] = [
        ItemKind::Project,
        ItemKind::Collection,
        ItemKind::Host,
        ItemKind::Variable,
        ItemKind::Key,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Update,
    Copy,
    Rename,
    Remove,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    SameId,
    SameName,
    #[allow(
        dead_code,
        reason = "part of the IPC contract; fresh ids are not listed"
    )]
    IdInUse,
    NameTaken,
    KeptSecret,
    BecomesSecret,
    VariableExists,
    KeyFileMissing,
    KeyFileMismatch,
    NotInFile,
    /// A new variable that changes where existing hosts connect.
    RedirectsHosts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Field {
    Name,
    Address,
    Location,
    Auth,
    Value,
    Kind,
}

/// Plain data only: names, raw templates, plain values, kinds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    pub field: Field,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub kind: ItemKind,
    pub action: Action,
    pub name: String,
    pub new_name: Option<String>,
    /// Scope first, then collections; empty for projects and keys.
    pub location: Vec<String>,
    pub reason: Reason,
    pub changes: Vec<Change>,
    /// Keys only: the path as written in the file (`~/…` under the home directory).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Keys only: the algorithm the file announced (`key_file_mismatch`), or `outside_home`
    /// for a path that was not inspected (`key_file_missing`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Variables only: hosts whose address this variable change moves.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub redirects: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub kind: ItemKind,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub copied: usize,
    pub removed: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SecretScope {
    Global,
    Project {
        project_id: String,
        project_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsSecret {
    pub scope: SecretScope,
    pub name: String,
    pub host_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undefined {
    pub name: String,
    pub host_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub rows: Vec<Row>,
    pub items: Vec<PlanItem>,
    pub more_items: usize,
    pub removed_host_ids: Vec<String>,
    pub moved_host_ids: Vec<String>,
    pub affected_connected_hosts: Vec<String>,
    pub secret_values_deleted: usize,
    pub saved_secret_hosts: usize,
    pub needs_secret: Vec<NeedsSecret>,
    pub undefined_variables: Vec<Undefined>,
    /// Hosts that would send a secret with a value on this computer to a target it does not
    /// go to today (new host, new address, or another secret variable).
    pub secrets_sent_to: Vec<SecretSent>,
    pub blocking: Vec<String>,
}

/// `from` / `to`: resolved `user@host:port`, plain values only; `from` is null for a host that
/// does not exist here or did not resolve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSent {
    pub host: String,
    pub location: Vec<String>,
    pub variable: String,
    pub from: Option<String>,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    pub kind: ItemKind,
    pub from: String,
    pub to: String,
}

/// What the key file at a file entry's path turned out to be on this computer.
#[derive(Debug, Clone, PartialEq)]
pub enum KeyProbe {
    /// Canonical path and the key read from it.
    Found(String, KeyInfo),
    Missing,
    Mismatch,
    /// Not inspected: outside the home directory and not a registered key path.
    Refused,
}

/// A secret variable account: `project_id: None` is global.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VarAccount {
    pub project_id: Option<String>,
    pub name: String,
}

/// Keychain deletes the apply must make before writing; every one of them must succeed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeychainWork {
    pub variables: Vec<VarAccount>,
    /// Hosts removed or moved to another scope: their saved connection secrets go.
    pub saved_hosts: Vec<String>,
}

pub struct Context<'a> {
    pub local: &'a ConfigFile,
    pub file: &'a DataFile,
    /// One per `file.keys` entry, in order.
    pub keys: &'a [KeyProbe],
    pub connected: &'a HashSet<String>,
    /// Whether the keychain holds a value for that account.
    pub has_value: &'a dyn Fn(&VarAccount) -> bool,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub plan: ImportPlan,
    pub result: ConfigFile,
    pub keychain: KeychainWork,
    pub renamed: Vec<Renamed>,
    pub skipped: Vec<PlanItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    Matched(Reason),
    Copied(Reason),
    New,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VarMode {
    Merge,
    Replace,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Slot {
    Project,
    Node,
}

struct Touched {
    slot: Slot,
    kind: ItemKind,
    id: String,
    origin: Origin,
    desired: String,
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

fn suffixed(base: &str, n: usize, max: usize) -> String {
    let tag = if n == 1 {
        " (imported)".to_owned()
    } else {
        format!(" (imported {n})")
    };
    let room = max.saturating_sub(tag.chars().count());
    let cut: String = base.chars().take(room).collect();
    format!("{}{tag}", cut.trim_end())
}

/// Claims `desired` in `taken`, else the first free suffixed form; true when suffixed.
fn claim(taken: &mut HashSet<String>, desired: &str, max: usize) -> (String, bool) {
    if taken.insert(lower(desired)) {
        return (desired.to_owned(), false);
    }
    let mut n = 1;
    loop {
        let candidate = suffixed(desired, n, max);
        if taken.insert(lower(&candidate)) {
            return (candidate, true);
        }
        n += 1;
    }
}

fn address(h: &Host) -> String {
    format!("{}@{}:{}", h.username, h.hostname, h.port)
}

fn auth_text(a: &AuthMethod) -> String {
    match a {
        AuthMethod::Password { password: None } => "password".into(),
        AuthMethod::Password { password: Some(r) } => format!("password {r}"),
        AuthMethod::Key {
            key_path,
            passphrase,
        } => match passphrase {
            Some(r) => format!("key {key_path}, passphrase {r}"),
            None => format!("key {key_path}"),
        },
        AuthMethod::Agent => "agent".into(),
    }
}

fn algorithm_text(a: crate::config::KeyAlgorithm) -> String {
    match a {
        crate::config::KeyAlgorithm::Ed25519 => "ed25519".into(),
        crate::config::KeyAlgorithm::Rsa => "rsa".into(),
    }
}

fn kind_text(k: VariableKind) -> String {
    match k {
        VariableKind::Plain => "plain".into(),
        VariableKind::Secret => "secret".into(),
    }
}

/// Scope name then collection names, root first, of the place `parent_id` designates.
fn place(
    cfg: &ConfigFile,
    index: &HashMap<&str, usize>,
    project_id: Option<&str>,
    parent_id: Option<&str>,
) -> Vec<String> {
    let scope = project_id
        .and_then(|p| cfg.project(p))
        .map_or_else(|| "Home".to_owned(), |p| p.name.clone());
    let mut chain = Vec::new();
    let mut next = parent_id;
    while let Some(id) = next {
        let Some(n) = index.get(id).map(|i| &cfg.nodes[*i]) else {
            break;
        };
        if chain.len() > MAX_DEPTH {
            break;
        }
        chain.push(n.name().to_owned());
        next = n.parent_id();
    }
    chain.reverse();
    std::iter::once(scope).chain(chain).collect()
}

fn index(cfg: &ConfigFile) -> HashMap<&str, usize> {
    cfg.nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id(), i))
        .collect()
}

fn file_depth(file: &DataFile, id: &str) -> usize {
    let by_id: HashMap<&str, &Node> = file.nodes.iter().map(|n| (n.id(), n)).collect();
    let mut depth = 0;
    let mut next = by_id.get(id).and_then(|n| n.parent_id());
    while let Some(p) = next {
        depth += 1;
        if depth > MAX_DEPTH {
            break;
        }
        next = by_id.get(p).and_then(|n| n.parent_id());
    }
    depth
}

struct Builder<'a> {
    ctx: &'a Context<'a>,
    strategy: Strategy,
    result: ConfigFile,
    used: HashSet<String>,
    matched: HashSet<String>,
    project_map: HashMap<String, String>,
    node_map: HashMap<String, String>,
    /// Projects created by this import with an id never seen here: no keychain value can exist.
    fresh: HashSet<String>,
    touched: Vec<Touched>,
    touched_ids: HashSet<String>,
    items: Vec<PlanItem>,
    rows: HashMap<ItemKind, Row>,
    keychain: KeychainWork,
    secret_values_deleted: usize,
    renamed: Vec<Renamed>,
    /// Final names of file items that had to be suffixed.
    suffix: HashMap<(Slot, String), String>,
    removed_hosts: Vec<Host>,
}

impl<'a> Builder<'a> {
    fn new(ctx: &'a Context<'a>, strategy: Strategy) -> Self {
        let local = ctx.local;
        let used: HashSet<String> = local
            .projects
            .iter()
            .map(|p| p.id.clone())
            .chain(local.nodes.iter().map(|n| n.id().to_owned()))
            .collect();
        let mut matched = HashSet::new();
        for p in &ctx.file.projects {
            if local.project(&p.id).is_some() {
                matched.insert(p.id.clone());
            }
        }
        for n in &ctx.file.nodes {
            if local
                .node(n.id())
                .is_some_and(|l| l.is_collection() == n.is_collection())
            {
                matched.insert(n.id().to_owned());
            }
        }
        let rows = ItemKind::ALL
            .iter()
            .map(|k| {
                (
                    *k,
                    Row {
                        kind: *k,
                        added: 0,
                        updated: 0,
                        unchanged: 0,
                        copied: 0,
                        removed: 0,
                        skipped: 0,
                    },
                )
            })
            .collect();
        Self {
            ctx,
            strategy,
            result: local.clone(),
            used,
            matched,
            project_map: HashMap::new(),
            node_map: HashMap::new(),
            fresh: HashSet::new(),
            touched: Vec::new(),
            touched_ids: HashSet::new(),
            items: Vec::new(),
            rows,
            keychain: KeychainWork::default(),
            secret_values_deleted: 0,
            renamed: Vec::new(),
            suffix: HashMap::new(),
            removed_hosts: Vec::new(),
        }
    }

    fn row(&mut self, kind: ItemKind) -> &mut Row {
        self.rows.get_mut(&kind).expect("every kind has a row")
    }

    fn item(&mut self, item: PlanItem) {
        self.items.push(item);
    }

    /// The file id when nobody uses it here, else a new one.
    fn take_id(&mut self, wanted: &str) -> (String, bool) {
        let id = if self.used.contains(wanted) {
            new_id()
        } else {
            wanted.to_owned()
        };
        self.used.insert(id.clone());
        let reused = id == wanted;
        (id, reused)
    }

    fn fresh_id(&mut self) -> String {
        let id = new_id();
        self.used.insert(id.clone());
        id
    }

    fn touch(&mut self, slot: Slot, kind: ItemKind, id: String, origin: Origin, desired: &str) {
        self.touched_ids.insert(id.clone());
        self.touched.push(Touched {
            slot,
            kind,
            id,
            origin,
            desired: desired.to_owned(),
        });
    }

    fn delete_account(&mut self, account: VarAccount, counted: bool) {
        if counted && (self.ctx.has_value)(&account) {
            self.secret_values_deleted += 1;
        }
        if !self.keychain.variables.contains(&account) {
            self.keychain.variables.push(account);
        }
    }

    fn var_item(
        &mut self,
        action: Action,
        name: &str,
        scope: &str,
        reason: Reason,
        changes: Vec<Change>,
    ) {
        self.item(PlanItem {
            kind: ItemKind::Variable,
            action,
            name: name.to_owned(),
            new_name: None,
            location: vec![scope.to_owned()],
            reason,
            changes,
            path: None,
            detail: None,
            redirects: Vec::new(),
        });
    }

    /// The variables of one scope after the import, with their rows, items and keychain work.
    /// `project`: the scope's id in the result (None = global); `fresh`: no account can hold a
    /// value yet.
    fn merge_vars(
        &mut self,
        local: &[Variable],
        file: &[FileVariable],
        mode: VarMode,
        project: Option<&str>,
        fresh: bool,
        scope: &str,
    ) -> Vec<Variable> {
        let account = |name: &str| VarAccount {
            project_id: project.map(str::to_owned),
            name: name.to_owned(),
        };
        let file = format::to_variables(file);
        let mut out: Vec<Variable> = if mode == VarMode::Replace {
            Vec::new()
        } else {
            local.to_vec()
        };
        let put = |out: &mut Vec<Variable>, v: Variable| match out
            .iter_mut()
            .find(|o| o.name == v.name)
        {
            Some(slot) => *slot = v,
            None => out.push(v),
        };
        for fv in file {
            let exact = local.iter().find(|v| v.name == fv.name).cloned();
            let case_only = exact.is_none() && local.iter().any(|v| same_name(&v.name, &fv.name));
            let Some(lv) = exact else {
                if case_only && mode != VarMode::Replace {
                    self.row(ItemKind::Variable).skipped += 1;
                    self.var_item(
                        Action::Skip,
                        &fv.name,
                        scope,
                        Reason::VariableExists,
                        Vec::new(),
                    );
                    continue;
                }
                self.row(ItemKind::Variable).added += 1;
                if fv.kind == VariableKind::Secret && !fresh {
                    self.delete_account(account(&fv.name), false);
                }
                out.push(fv);
                continue;
            };
            let kept = match (fv.kind, lv.kind, mode) {
                (VariableKind::Secret, VariableKind::Secret, _) => None,
                (VariableKind::Plain, VariableKind::Plain, _) if lv.value == fv.value => None,
                (_, _, VarMode::Duplicate) => Some(Reason::VariableExists),
                (VariableKind::Plain, VariableKind::Secret, VarMode::Merge) => {
                    Some(Reason::KeptSecret)
                }
                _ => {
                    let mut changes = Vec::new();
                    let reason = if fv.kind != lv.kind {
                        changes.push(Change {
                            field: Field::Kind,
                            from: kind_text(lv.kind),
                            to: kind_text(fv.kind),
                        });
                        self.delete_account(account(&fv.name), lv.kind == VariableKind::Secret);
                        if fv.kind == VariableKind::Secret {
                            Reason::BecomesSecret
                        } else {
                            Reason::SameName
                        }
                    } else {
                        Reason::SameName
                    };
                    if fv.kind == VariableKind::Plain {
                        changes.push(Change {
                            field: Field::Value,
                            from: lv.value.clone().unwrap_or_default(),
                            to: fv.value.clone().unwrap_or_default(),
                        });
                    }
                    self.row(ItemKind::Variable).updated += 1;
                    self.var_item(Action::Update, &fv.name, scope, reason, changes);
                    put(&mut out, fv);
                    continue;
                }
            };
            match kept {
                None => self.row(ItemKind::Variable).unchanged += 1,
                Some(reason) => {
                    self.row(ItemKind::Variable).skipped += 1;
                    self.var_item(Action::Skip, &fv.name, scope, reason, Vec::new());
                }
            }
            put(&mut out, lv);
        }
        if mode == VarMode::Replace {
            for lv in local {
                if out.iter().any(|v| v.name == lv.name) {
                    continue;
                }
                self.row(ItemKind::Variable).removed += 1;
                self.var_item(
                    Action::Remove,
                    &lv.name,
                    scope,
                    Reason::NotInFile,
                    Vec::new(),
                );
                if lv.kind == VariableKind::Secret {
                    self.delete_account(account(&lv.name), true);
                }
            }
        }
        out
    }

    fn global_mode(&self) -> VarMode {
        match (self.strategy, &self.ctx.file.scope) {
            (Strategy::Duplicate, _) => VarMode::Duplicate,
            // A project file only adds or updates the globals it carries.
            (_, FileScope::Project { .. }) | (Strategy::Merge, _) => VarMode::Merge,
            (Strategy::Replace, _) => VarMode::Replace,
        }
    }

    fn globals(&mut self) {
        let local = self.ctx.local.variables.clone();
        let mode = self.global_mode();
        self.result.variables = self.merge_vars(
            &local,
            &self.ctx.file.variables,
            mode,
            None,
            false,
            "Global",
        );
    }

    fn projects(&mut self) {
        let ctx = self.ctx;
        for fp in &ctx.file.projects {
            let found = match ctx.local.project(&fp.id) {
                Some(lp) => Some((lp, Reason::SameId)),
                None => ctx
                    .local
                    .projects
                    .iter()
                    .find(|lp| !self.matched.contains(&lp.id) && same_name(&lp.name, &fp.name))
                    .map(|lp| (lp, Reason::SameName)),
            };
            if let Some((lp, _)) = found {
                self.matched.insert(lp.id.clone());
            }
            let id = match (found, self.strategy) {
                (Some((lp, reason)), Strategy::Merge | Strategy::Replace) => {
                    let mode = if self.strategy == Strategy::Replace {
                        VarMode::Replace
                    } else {
                        VarMode::Merge
                    };
                    let vars = self.merge_vars(
                        &lp.variables,
                        &fp.variables,
                        mode,
                        Some(&lp.id),
                        false,
                        &fp.name,
                    );
                    let slot = self
                        .result
                        .projects
                        .iter_mut()
                        .find(|p| p.id == lp.id)
                        .expect("a matched project is in the result");
                    slot.variables = vars;
                    self.touch(
                        Slot::Project,
                        ItemKind::Project,
                        lp.id.clone(),
                        Origin::Matched(reason),
                        &fp.name,
                    );
                    lp.id.clone()
                }
                (found, _) => {
                    let (id, fresh) = match found {
                        Some(_) => (self.fresh_id(), true),
                        None => {
                            let (id, reused) = self.take_id(&fp.id);
                            (id, !reused)
                        }
                    };
                    if fresh {
                        self.fresh.insert(id.clone());
                    }
                    let vars = self.merge_vars(
                        &[],
                        &fp.variables,
                        VarMode::Merge,
                        Some(&id),
                        fresh,
                        &fp.name,
                    );
                    self.result.projects.push(Project {
                        id: id.clone(),
                        name: fp.name.clone(),
                        variables: vars,
                    });
                    let origin = match found {
                        Some((_, reason)) => Origin::Copied(reason),
                        None => Origin::New,
                    };
                    self.touch(
                        Slot::Project,
                        ItemKind::Project,
                        id.clone(),
                        origin,
                        &fp.name,
                    );
                    id
                }
            };
            self.project_map.insert(fp.id.clone(), id);
        }
    }

    fn nodes(&mut self) {
        let ctx = self.ctx;
        let mut collections: Vec<&Node> = ctx
            .file
            .nodes
            .iter()
            .filter(|n| n.is_collection())
            .collect();
        let depth: HashMap<&str, usize> = collections
            .iter()
            .map(|n| (n.id(), file_depth(ctx.file, n.id())))
            .collect();
        collections.sort_by_key(|n| depth[n.id()]);
        let hosts = ctx.file.nodes.iter().filter(|n| !n.is_collection());
        for fnode in collections.into_iter().chain(hosts) {
            self.node(fnode);
        }
    }

    fn node(&mut self, fnode: &Node) {
        let ctx = self.ctx;
        let project = fnode
            .project_id()
            .and_then(|p| self.project_map.get(p))
            .cloned();
        let parent = fnode
            .parent_id()
            .and_then(|p| self.node_map.get(p))
            .cloned();
        let collection = fnode.is_collection();
        let kind = if collection {
            ItemKind::Collection
        } else {
            ItemKind::Host
        };
        let by_id = ctx
            .local
            .node(fnode.id())
            .filter(|l| l.is_collection() == collection)
            .map(|l| (l, Reason::SameId));
        let found = by_id.or_else(|| {
            ctx.local
                .nodes
                .iter()
                .filter(|l| l.is_collection() == collection && !self.matched.contains(l.id()))
                .filter(|l| l.project_id() == project.as_deref())
                .filter(|l| !collection || l.parent_id() == parent.as_deref())
                .find(|l| same_name(l.name(), fnode.name()))
                .map(|l| (l, Reason::SameName))
        });
        if let Some((l, _)) = found {
            self.matched.insert(l.id().to_owned());
        }
        let mut placed = fnode.clone();
        placed.set_location(project, parent);
        let id = match (found, self.strategy) {
            (Some((l, reason)), Strategy::Merge | Strategy::Replace) => {
                let id = l.id().to_owned();
                set_id(&mut placed, &id);
                let slot = self
                    .result
                    .nodes
                    .iter_mut()
                    .find(|n| n.id() == id)
                    .expect("a matched node is in the result");
                *slot = placed;
                self.touch(
                    Slot::Node,
                    kind,
                    id.clone(),
                    Origin::Matched(reason),
                    fnode.name(),
                );
                id
            }
            (found, _) => {
                let (id, origin) = match found {
                    Some((_, reason)) => (self.fresh_id(), Origin::Copied(reason)),
                    None => (self.take_id(fnode.id()).0, Origin::New),
                };
                set_id(&mut placed, &id);
                self.result.nodes.push(placed);
                self.touch(Slot::Node, kind, id.clone(), origin, fnode.name());
                id
            }
        };
        self.node_map.insert(fnode.id().to_owned(), id);
    }

    fn covered(&self, project_id: Option<&str>) -> bool {
        match &self.ctx.file.scope {
            FileScope::All => true,
            FileScope::Home => project_id.is_none(),
            FileScope::Project {
                project_id: file_id,
                ..
            } => {
                let target = self.project_map.get(file_id);
                project_id.is_some_and(|p| {
                    target.is_some_and(|t| t == p) && self.ctx.local.project(p).is_some()
                })
            }
        }
    }

    fn remove_missing(&mut self) {
        if self.strategy != Strategy::Replace {
            return;
        }
        let ctx = self.ctx;
        let local_index = index(ctx.local);
        let gone_projects: Vec<Project> = if ctx.file.scope == FileScope::All {
            ctx.local
                .projects
                .iter()
                .filter(|p| !self.matched.contains(&p.id))
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let gone_ids: HashSet<&str> = gone_projects.iter().map(|p| p.id.as_str()).collect();
        let doomed: Vec<Node> = ctx
            .local
            .nodes
            .iter()
            .filter(|n| !self.matched.contains(n.id()))
            .filter(|n| {
                n.project_id().is_some_and(|p| gone_ids.contains(p)) || self.covered(n.project_id())
            })
            .cloned()
            .collect();
        let doomed_ids: HashSet<String> = doomed.iter().map(|n| n.id().to_owned()).collect();
        self.result.nodes.retain(|n| !doomed_ids.contains(n.id()));
        for n in &doomed {
            let kind = if n.is_collection() {
                ItemKind::Collection
            } else {
                ItemKind::Host
            };
            self.row(kind).removed += 1;
            let location = place(ctx.local, &local_index, n.project_id(), n.parent_id());
            self.item(PlanItem {
                kind,
                action: Action::Remove,
                name: n.name().to_owned(),
                new_name: None,
                location,
                reason: Reason::NotInFile,
                changes: Vec::new(),
                path: None,
                detail: None,
                redirects: Vec::new(),
            });
            if let Node::Host(h) = n {
                self.removed_hosts.push(h.clone());
                self.keychain.saved_hosts.push(h.id.clone());
            }
        }
        for p in &gone_projects {
            self.row(ItemKind::Project).removed += 1;
            self.item(PlanItem {
                kind: ItemKind::Project,
                action: Action::Remove,
                name: p.name.clone(),
                new_name: None,
                location: Vec::new(),
                reason: Reason::NotInFile,
                changes: Vec::new(),
                path: None,
                detail: None,
                redirects: Vec::new(),
            });
            for v in &p.variables {
                self.row(ItemKind::Variable).removed += 1;
                if v.kind == VariableKind::Secret {
                    let account = VarAccount {
                        project_id: Some(p.id.clone()),
                        name: v.name.clone(),
                    };
                    self.delete_account(account, true);
                }
            }
        }
        self.result
            .projects
            .retain(|p| !gone_ids.contains(p.id.as_str()));
    }

    /// Nodes left alone by the file follow a parent that moved to another scope, as a moved
    /// collection's subtree does. Returns them.
    fn cascade(&mut self) -> Vec<String> {
        let mut moved = Vec::new();
        for _ in 0..=MAX_DEPTH + 1 {
            let idx = index(&self.result);
            let mut changes: Vec<(usize, Option<String>, Option<String>)> = Vec::new();
            for (i, n) in self.result.nodes.iter().enumerate() {
                if self.touched_ids.contains(n.id()) {
                    continue;
                }
                let Some(parent) = n.parent_id() else {
                    continue;
                };
                match idx.get(parent).map(|j| &self.result.nodes[*j]) {
                    Some(p) if p.project_id() != n.project_id() => changes.push((
                        i,
                        p.project_id().map(str::to_owned),
                        Some(parent.to_owned()),
                    )),
                    Some(_) => {}
                    None => changes.push((i, n.project_id().map(str::to_owned), None)),
                }
            }
            if changes.is_empty() {
                break;
            }
            for (i, project, parent) in changes {
                let n = &mut self.result.nodes[i];
                n.set_location(project, parent);
                if !moved.contains(&n.id().to_owned()) {
                    moved.push(n.id().to_owned());
                }
            }
        }
        moved
    }

    /// Resolves name collisions: what the import leaves alone keeps its name, then file items
    /// in file order, then nodes that followed a moved parent.
    fn claims(&mut self, cascaded: &[String]) {
        let mut projects: HashSet<String> = HashSet::new();
        let mut collections: HashMap<(Option<String>, Option<String>), HashSet<String>> =
            HashMap::new();
        let mut hosts: HashMap<Option<String>, HashSet<String>> = HashMap::new();
        for p in &self.result.projects {
            if !self.touched_ids.contains(&p.id) {
                projects.insert(lower(&p.name));
            }
        }
        let later: HashSet<&str> = cascaded.iter().map(String::as_str).collect();
        for n in &self.result.nodes {
            if self.touched_ids.contains(n.id()) || later.contains(n.id()) {
                continue;
            }
            claim_node(&mut collections, &mut hosts, n);
        }
        let touched = std::mem::take(&mut self.touched);
        let mut suffixed: Vec<(usize, String)> = Vec::new();
        for (i, t) in touched.iter().enumerate() {
            let (name, renamed) = match t.slot {
                Slot::Project => claim(&mut projects, &t.desired, MAX_NAME),
                Slot::Node => {
                    let n = self
                        .result
                        .nodes
                        .iter()
                        .find(|n| n.id() == t.id)
                        .expect("placed");
                    let set = namespace(&mut collections, &mut hosts, n);
                    claim(set, &t.desired, MAX_NAME)
                }
            };
            self.set_name(t.slot, &t.id, &name);
            if renamed {
                self.suffix.insert((t.slot, t.id.clone()), name.clone());
                suffixed.push((i, name));
            }
        }
        self.touched = touched;
        for id in cascaded {
            let n = self
                .result
                .nodes
                .iter()
                .find(|n| n.id() == id)
                .expect("placed")
                .clone();
            let set = namespace(&mut collections, &mut hosts, &n);
            let (name, renamed) = claim(set, n.name(), MAX_NAME);
            if renamed {
                self.set_name(Slot::Node, id, &name);
            }
        }
        for (i, name) in suffixed {
            let t = &self.touched[i];
            self.renamed.push(Renamed {
                kind: t.kind,
                from: t.desired.clone(),
                to: name,
            });
        }
    }

    fn set_name(&mut self, slot: Slot, id: &str, name: &str) {
        match slot {
            Slot::Project => {
                if let Some(p) = self.result.projects.iter_mut().find(|p| p.id == id) {
                    p.name = name.to_owned();
                }
            }
            Slot::Node => {
                if let Some(n) = self.result.nodes.iter_mut().find(|n| n.id() == id) {
                    match n {
                        Node::Collection(c) => c.name = name.to_owned(),
                        Node::Host(h) => h.name = name.to_owned(),
                    }
                }
            }
        }
    }

    fn node_changes(&self, before: &Node, after: &Node, places: &Places<'_>) -> Vec<Change> {
        let mut out = Vec::new();
        if before.project_id() != after.project_id() || before.parent_id() != after.parent_id() {
            out.push(Change {
                field: Field::Location,
                from: places.local(before).join(" / "),
                to: places.result(after).join(" / "),
            });
        }
        if let (Node::Host(a), Node::Host(b)) = (before, after) {
            if address(a) != address(b) {
                out.push(Change {
                    field: Field::Address,
                    from: address(a),
                    to: address(b),
                });
            }
            if a.auth != b.auth {
                out.push(Change {
                    field: Field::Auth,
                    from: auth_text(&a.auth),
                    to: auth_text(&b.auth),
                });
            }
        }
        out
    }

    fn report_touched(&mut self, cascaded: &[String]) {
        let snapshot = self.result.clone();
        let places = Places::new(self.ctx.local, &snapshot);
        let mut items = Vec::new();
        let mut counts: Vec<(ItemKind, Origin, bool)> = Vec::new();
        for t in &self.touched {
            let suffix = self.suffix.get(&(t.slot, t.id.clone())).cloned();
            let (location, mut changes) = match t.slot {
                Slot::Project => {
                    let before = self.ctx.local.project(&t.id);
                    let after = self.result.project(&t.id).expect("placed");
                    let mut changes = Vec::new();
                    if let (Origin::Matched(_), Some(b)) = (t.origin, before)
                        && b.name != after.name
                        && suffix.is_none()
                    {
                        changes.push(Change {
                            field: Field::Name,
                            from: b.name.clone(),
                            to: after.name.clone(),
                        });
                    }
                    (Vec::new(), changes)
                }
                Slot::Node => {
                    let after = self.result.node(&t.id).expect("placed");
                    let before = self.ctx.local.node(&t.id);
                    let mut changes = Vec::new();
                    if let (Origin::Matched(_), Some(b)) = (t.origin, before) {
                        if b.name() != after.name() && suffix.is_none() {
                            changes.push(Change {
                                field: Field::Name,
                                from: b.name().to_owned(),
                                to: after.name().to_owned(),
                            });
                        }
                        changes.extend(self.node_changes(b, after, &places));
                    }
                    (places.result(after), changes)
                }
            };
            let action = match (t.origin, &suffix) {
                (Origin::Copied(_), _) => Some(Action::Copy),
                (_, Some(_)) => Some(Action::Rename),
                (Origin::Matched(_), None) if !changes.is_empty() => Some(Action::Update),
                _ => None,
            };
            let reason = match (t.origin, &suffix, action) {
                (Origin::Copied(r), _, _) => r,
                (_, Some(_), _) => Reason::NameTaken,
                (Origin::Matched(r), _, _) => r,
                (Origin::New, None, _) => Reason::SameId,
            };
            counts.push((t.kind, t.origin, !changes.is_empty() || suffix.is_some()));
            if let Some(action) = action {
                if t.slot == Slot::Project && action == Action::Copy {
                    changes.clear();
                }
                items.push(PlanItem {
                    kind: t.kind,
                    action,
                    name: t.desired.clone(),
                    new_name: suffix,
                    location,
                    reason,
                    changes,
                    path: None,
                    detail: None,
                    redirects: Vec::new(),
                });
            }
        }
        for (kind, origin, changed) in counts {
            let row = self.row(kind);
            match origin {
                Origin::Matched(_) if changed => row.updated += 1,
                Origin::Matched(_) => row.unchanged += 1,
                Origin::Copied(_) => row.copied += 1,
                Origin::New => row.added += 1,
            }
        }
        for id in cascaded {
            let (Some(before), Some(after)) = (self.ctx.local.node(id), self.result.node(id))
            else {
                continue;
            };
            let kind = if after.is_collection() {
                ItemKind::Collection
            } else {
                ItemKind::Host
            };
            let renamed = (before.name() != after.name()).then(|| after.name().to_owned());
            let changes = self.node_changes(before, after, &places);
            items.push(PlanItem {
                kind,
                action: if renamed.is_some() {
                    Action::Rename
                } else {
                    Action::Update
                },
                name: before.name().to_owned(),
                new_name: renamed.clone(),
                location: places.result(after),
                reason: Reason::NotInFile,
                changes,
                path: None,
                detail: None,
                redirects: Vec::new(),
            });
            if let Some(to) = renamed {
                self.renamed.push(Renamed {
                    kind,
                    from: before.name().to_owned(),
                    to,
                });
            }
            self.row(kind).updated += 1;
        }
        self.items.extend(items);
    }

    fn keys(&mut self) {
        let ctx = self.ctx;
        for (fk, probe) in ctx.file.keys.iter().zip(ctx.keys) {
            let skip = |reason| PlanItem {
                kind: ItemKind::Key,
                action: Action::Skip,
                name: fk.name.clone(),
                new_name: None,
                location: Vec::new(),
                reason,
                changes: Vec::new(),
                path: Some(fk.path.clone()),
                detail: (reason == Reason::KeyFileMismatch).then(|| algorithm_text(fk.algorithm)),
                redirects: Vec::new(),
            };
            let (path, info) = match probe {
                KeyProbe::Found(path, info) => (path, info),
                KeyProbe::Missing => {
                    self.row(ItemKind::Key).skipped += 1;
                    self.item(skip(Reason::KeyFileMissing));
                    continue;
                }
                KeyProbe::Refused => {
                    self.row(ItemKind::Key).skipped += 1;
                    let mut item = skip(Reason::KeyFileMissing);
                    item.detail = Some("outside_home".into());
                    self.item(item);
                    continue;
                }
                KeyProbe::Mismatch => {
                    self.row(ItemKind::Key).skipped += 1;
                    self.item(skip(Reason::KeyFileMismatch));
                    continue;
                }
            };
            let existing = self
                .result
                .keys
                .iter()
                .position(|k| same_path(&k.path, path));
            let mut taken: HashSet<String> = self
                .result
                .keys
                .iter()
                .enumerate()
                .filter(|(i, _)| Some(*i) != existing)
                .map(|(_, k)| lower(&k.name))
                .collect();
            match existing {
                Some(_) if self.strategy == Strategy::Duplicate => {
                    self.row(ItemKind::Key).skipped += 1;
                    self.item(skip(Reason::SameId));
                }
                Some(i) => {
                    let before = self.result.keys[i].name.clone();
                    if before == fk.name {
                        self.row(ItemKind::Key).unchanged += 1;
                        continue;
                    }
                    let (name, renamed) = claim(&mut taken, &fk.name, MAX_KEY_NAME);
                    if name == before {
                        self.row(ItemKind::Key).unchanged += 1;
                        continue;
                    }
                    self.result.keys[i].name = name.clone();
                    self.row(ItemKind::Key).updated += 1;
                    self.item(PlanItem {
                        kind: ItemKind::Key,
                        action: if renamed {
                            Action::Rename
                        } else {
                            Action::Update
                        },
                        name: fk.name.clone(),
                        new_name: renamed.then(|| name.clone()),
                        location: Vec::new(),
                        reason: if renamed {
                            Reason::NameTaken
                        } else {
                            Reason::SameId
                        },
                        changes: vec![Change {
                            field: Field::Name,
                            from: before,
                            to: name.clone(),
                        }],
                        path: Some(fk.path.clone()),
                        detail: None,
                        redirects: Vec::new(),
                    });
                    if renamed {
                        self.renamed.push(Renamed {
                            kind: ItemKind::Key,
                            from: fk.name.clone(),
                            to: name,
                        });
                    }
                }
                None => {
                    let (name, renamed) = claim(&mut taken, &fk.name, MAX_KEY_NAME);
                    self.result.keys.push(KeyEntry {
                        id: new_id(),
                        name: name.clone(),
                        path: path.clone(),
                        managed: false,
                        origin: KeyOrigin::Imported,
                        algorithm: info.algorithm,
                        bits: info.bits,
                        public_key: info.public_key.clone(),
                        fingerprint: info.fingerprint.clone(),
                        comment: info.comment.clone(),
                        encrypted: info.encrypted,
                    });
                    self.row(ItemKind::Key).added += 1;
                    if renamed {
                        self.item(PlanItem {
                            kind: ItemKind::Key,
                            action: Action::Rename,
                            name: fk.name.clone(),
                            new_name: Some(name.clone()),
                            location: Vec::new(),
                            reason: Reason::NameTaken,
                            changes: Vec::new(),
                            path: Some(fk.path.clone()),
                            detail: None,
                            redirects: Vec::new(),
                        });
                        self.renamed.push(Renamed {
                            kind: ItemKind::Key,
                            from: fk.name.clone(),
                            to: name,
                        });
                    }
                }
            }
        }
    }

    /// Hosts that would send a stored secret somewhere it does not go today, and the plain
    /// variable changes that move existing hosts (attached to the variable's item). Never
    /// reads a value: `has_value` only.
    fn redirects(&mut self) -> Vec<SecretSent> {
        let snapshot = self.result.clone();
        let places = Places::new(self.ctx.local, &snapshot);
        let deleted: HashSet<VarAccount> = self.keychain.variables.iter().cloned().collect();
        let mut sent = Vec::new();
        let mut moves: Vec<(String, String, String)> = Vec::new();
        for node in &snapshot.nodes {
            let Node::Host(h) = node else { continue };
            let Some(to) = target(&snapshot, h) else {
                continue;
            };
            let before = self.ctx.local.host(&h.id);
            let from = before.and_then(|l| target(self.ctx.local, l));
            if let Some(account) = password_account(&snapshot, h) {
                let had = before.and_then(|l| password_account(self.ctx.local, l));
                let same = from.as_deref() == Some(to.as_str()) && had.as_ref() == Some(&account);
                let fresh = account
                    .project_id
                    .as_ref()
                    .is_some_and(|p| self.fresh.contains(p));
                if !same && !fresh && !deleted.contains(&account) && (self.ctx.has_value)(&account)
                {
                    sent.push(SecretSent {
                        host: h.name.clone(),
                        location: places.result(node),
                        variable: account.name.clone(),
                        from: from.clone(),
                        to: to.clone(),
                    });
                }
            }
            let Some(l) = before else { continue };
            let same_fields =
                (&l.hostname, &l.port, &l.username) == (&h.hostname, &h.port, &h.username);
            if !same_fields || from.as_deref() == Some(to.as_str()) {
                continue;
            }
            for name in address_references(h) {
                let (old, new) = (winner(self.ctx.local, l, name), winner(&snapshot, h, name));
                if old == new {
                    continue;
                }
                let scope = new.or(old).and_then(|(scope, _)| scope);
                let label = match scope {
                    None => "Global".to_owned(),
                    Some(id) => snapshot
                        .project(&id)
                        .or_else(|| self.ctx.local.project(&id))
                        .map(|p| p.name.clone())
                        .unwrap_or_default(),
                };
                moves.push((label, name.to_owned(), h.name.clone()));
            }
        }
        for (label, name, host) in moves {
            let found = self.items.iter_mut().find(|i| {
                i.kind == ItemKind::Variable && i.name == name && i.location == [label.as_str()]
            });
            match found {
                Some(i) if i.redirects.contains(&host) => {}
                Some(i) => i.redirects.push(host),
                None => self.items.push(PlanItem {
                    kind: ItemKind::Variable,
                    action: Action::Update,
                    name,
                    new_name: None,
                    location: vec![label],
                    reason: Reason::RedirectsHosts,
                    changes: Vec::new(),
                    path: None,
                    detail: None,
                    redirects: vec![host],
                }),
            }
        }
        sent
    }

    fn blocking(&self) -> Vec<String> {
        let mut out = Vec::new();
        let r = &self.result;
        if r.nodes.len() > MAX_NODES {
            out.push(format!(
                "there would be {} hosts and collections (max {MAX_NODES})",
                r.nodes.len()
            ));
        }
        if r.projects.len() > format::MAX_PROJECTS {
            out.push(format!(
                "there would be {} projects (max {})",
                r.projects.len(),
                format::MAX_PROJECTS
            ));
        }
        if r.keys.len() > format::MAX_KEYS {
            out.push(format!(
                "there would be {} SSH keys (max {})",
                r.keys.len(),
                format::MAX_KEYS
            ));
        }
        if r.variables.len() > MAX_VARIABLES {
            out.push(format!(
                "there would be {} global variables (max {MAX_VARIABLES})",
                r.variables.len()
            ));
        }
        for p in &r.projects {
            if p.variables.len() > MAX_VARIABLES {
                out.push(format!(
                    "{} would have {} variables (max {MAX_VARIABLES})",
                    p.name,
                    p.variables.len()
                ));
            }
        }
        if !out.is_empty() {
            return out;
        }
        let lists = std::iter::once(&r.variables).chain(r.projects.iter().map(|p| &p.variables));
        for list in lists {
            if let Err(e) = validate::variables(list) {
                out.push(e.to_string());
            }
        }
        if let Err(e) = validate::structure(r) {
            out.push(if e.contains("nested too deep") {
                format!("a collection would be nested deeper than {MAX_DEPTH} levels")
            } else {
                format!("the result would not be consistent ({e})")
            });
        }
        out
    }

    fn secrets(&self) -> (Vec<NeedsSecret>, Vec<Undefined>) {
        let mut needs: Vec<NeedsSecret> = Vec::new();
        let mut undefined: Vec<Undefined> = Vec::new();
        let deleted: HashSet<&VarAccount> = self.keychain.variables.iter().collect();
        let mut known: HashMap<VarAccount, bool> = HashMap::new();
        for t in self.touched.iter().filter(|t| t.slot == Slot::Node) {
            let Some(h) = self.result.host(&t.id) else {
                continue;
            };
            let project = h.project_id.as_deref().and_then(|p| self.result.project(p));
            let layers = Layers::of(&self.result, project);
            let secret_fields: Vec<&str> = match &h.auth {
                AuthMethod::Password { password } => password.iter().collect(),
                AuthMethod::Key { passphrase, .. } => passphrase.iter().collect(),
                AuthMethod::Agent => Vec::new(),
            }
            .into_iter()
            .filter_map(|t| crate::vars::single_reference(t))
            .collect();
            let mut seen = HashSet::new();
            for name in references(h) {
                if !seen.insert(name) {
                    continue;
                }
                match layers.lookup(name) {
                    None => match undefined.iter_mut().find(|u| u.name == name) {
                        Some(u) => u.host_count += 1,
                        None => undefined.push(Undefined {
                            name: name.to_owned(),
                            host_count: 1,
                        }),
                    },
                    Some((level, v))
                        if v.kind == VariableKind::Secret && secret_fields.contains(&name) =>
                    {
                        let (account, scope) = match level {
                            Level::Global => (
                                VarAccount {
                                    project_id: None,
                                    name: name.to_owned(),
                                },
                                SecretScope::Global,
                            ),
                            Level::Project(id) => (
                                VarAccount {
                                    project_id: Some(id.clone()),
                                    name: name.to_owned(),
                                },
                                SecretScope::Project {
                                    project_name: project
                                        .map(|p| p.name.clone())
                                        .unwrap_or_default(),
                                    project_id: id,
                                },
                            ),
                        };
                        let fresh = account
                            .project_id
                            .as_ref()
                            .is_some_and(|p| self.fresh.contains(p));
                        let has = !fresh
                            && !deleted.contains(&account)
                            && *known
                                .entry(account.clone())
                                .or_insert_with(|| (self.ctx.has_value)(&account));
                        if has {
                            continue;
                        }
                        match needs
                            .iter_mut()
                            .find(|n| n.scope == scope && n.name == name)
                        {
                            Some(n) => n.host_count += 1,
                            None => needs.push(NeedsSecret {
                                scope,
                                name: name.to_owned(),
                                host_count: 1,
                            }),
                        }
                    }
                    Some(_) => {}
                }
            }
        }
        (needs, undefined)
    }
}

fn layers_of<'c>(cfg: &'c ConfigFile, h: &Host) -> Layers<'c> {
    let project = h.project_id.as_deref().and_then(|p| cfg.project(p));
    Layers::of(cfg, project)
}

/// `user@host:port` from plain values only (the resolver refuses a secret in those fields).
fn target(cfg: &ConfigFile, h: &Host) -> Option<String> {
    let r = resolve_host(h, layers_of(cfg, h));
    Some(format!("{}@{}:{}", r.username?, r.hostname?, r.port?))
}

/// The secret variable account a host's password field sends, if any. A key passphrase only
/// unlocks a local file and is never sent.
fn password_account(cfg: &ConfigFile, h: &Host) -> Option<VarAccount> {
    let AuthMethod::Password { password: Some(t) } = &h.auth else {
        return None;
    };
    let name = crate::vars::single_reference(t)?;
    let (level, v) = layers_of(cfg, h).lookup(name)?;
    (v.kind == VariableKind::Secret).then(|| VarAccount {
        project_id: match level {
            Level::Global => None,
            Level::Project(id) => Some(id),
        },
        name: name.to_owned(),
    })
}

/// Which layer defines `name` for `h` and its plain value.
fn winner(cfg: &ConfigFile, h: &Host, name: &str) -> Option<(Option<String>, Option<String>)> {
    let (level, v) = layers_of(cfg, h).lookup(name)?;
    let scope = match level {
        Level::Global => None,
        Level::Project(id) => Some(id),
    };
    Some((scope, v.value.clone()))
}

fn address_references(h: &Host) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for t in [&h.hostname, &h.port, &h.username] {
        for s in crate::vars::parse(t).unwrap_or_default() {
            if let crate::vars::Segment::Reference(r) = s
                && !out.contains(&r)
            {
                out.push(r);
            }
        }
    }
    out
}

fn set_id(node: &mut Node, id: &str) {
    match node {
        Node::Collection(c) => c.id = id.to_owned(),
        Node::Host(h) => h.id = id.to_owned(),
    }
}

type CollectionNames = HashMap<(Option<String>, Option<String>), HashSet<String>>;
type HostNames = HashMap<Option<String>, HashSet<String>>;

fn namespace<'n>(
    collections: &'n mut CollectionNames,
    hosts: &'n mut HostNames,
    n: &Node,
) -> &'n mut HashSet<String> {
    match n {
        Node::Collection(Collection {
            project_id,
            parent_id,
            ..
        }) => collections
            .entry((project_id.clone(), parent_id.clone()))
            .or_default(),
        Node::Host(h) => hosts.entry(h.project_id.clone()).or_default(),
    }
}

fn claim_node(collections: &mut CollectionNames, hosts: &mut HostNames, n: &Node) {
    namespace(collections, hosts, n).insert(lower(n.name()));
}

struct Places<'a> {
    local: &'a ConfigFile,
    local_index: HashMap<&'a str, usize>,
    result: &'a ConfigFile,
    result_index: HashMap<&'a str, usize>,
}

impl<'a> Places<'a> {
    fn new(local: &'a ConfigFile, result: &'a ConfigFile) -> Self {
        Self {
            local,
            local_index: index(local),
            result,
            result_index: index(result),
        }
    }

    fn local(&self, n: &Node) -> Vec<String> {
        place(self.local, &self.local_index, n.project_id(), n.parent_id())
    }

    fn result(&self, n: &Node) -> Vec<String> {
        place(
            self.result,
            &self.result_index,
            n.project_id(),
            n.parent_id(),
        )
    }
}

fn group(item: &PlanItem) -> u8 {
    match (item.action, item.reason) {
        (Action::Update, _) => 0,
        (Action::Copy, _) => 1,
        (Action::Rename, _) => 2,
        (Action::Remove, _) => 3,
        (Action::Skip, Reason::KeyFileMissing | Reason::KeyFileMismatch) => 5,
        (Action::Skip, _) => 4,
    }
}

/// The result of importing `ctx.file` with `strategy` into `ctx.local`, and how it reads.
pub fn plan(ctx: &Context<'_>, strategy: Strategy) -> Outcome {
    let mut b = Builder::new(ctx, strategy);
    b.globals();
    b.projects();
    b.nodes();
    b.remove_missing();
    let cascaded = b.cascade();
    b.claims(&cascaded);
    b.report_touched(&cascaded);
    b.keys();

    let local_hosts: HashMap<&str, &Host> = ctx
        .local
        .nodes
        .iter()
        .filter_map(Node::as_host)
        .map(|h| (h.id.as_str(), h))
        .collect();
    let mut moved: Vec<String> = Vec::new();
    for h in b.result.nodes.iter().filter_map(Node::as_host) {
        if let Some(l) = local_hosts.get(h.id.as_str())
            && l.project_id != h.project_id
        {
            moved.push(h.id.clone());
        }
    }
    b.keychain.saved_hosts.extend(moved.iter().cloned());
    let removed: Vec<String> = b.removed_hosts.iter().map(|h| h.id.clone()).collect();
    let affected = removed
        .iter()
        .chain(&moved)
        .filter(|id| ctx.connected.contains(*id))
        .filter_map(|id| local_hosts.get(id.as_str()).map(|h| h.name.clone()))
        .collect();
    let blocking = b.blocking();
    let (needs_secret, undefined_variables) = b.secrets();
    let secrets_sent_to = b.redirects();

    let mut items = std::mem::take(&mut b.items);
    items.sort_by_key(group);
    let skipped: Vec<PlanItem> = items
        .iter()
        .filter(|i| i.action == Action::Skip)
        .take(MAX_ITEMS)
        .cloned()
        .collect();
    let more_items = items.len().saturating_sub(MAX_ITEMS);
    items.truncate(MAX_ITEMS);
    let rows = ItemKind::ALL.iter().map(|k| b.rows[k]).collect();
    let plan = ImportPlan {
        rows,
        items,
        more_items,
        saved_secret_hosts: b.keychain.saved_hosts.len(),
        removed_host_ids: removed,
        moved_host_ids: moved,
        affected_connected_hosts: affected,
        secret_values_deleted: b.secret_values_deleted,
        needs_secret,
        undefined_variables,
        secrets_sent_to,
        blocking,
    };
    Outcome {
        plan,
        result: b.result,
        keychain: b.keychain,
        renamed: b.renamed,
        skipped,
    }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
