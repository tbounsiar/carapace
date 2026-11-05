use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use super::format::{self, DataFile, FileProject, FileScope};
use crate::config::model::{AuthMethod, ConfigFile, Host, KeyEntry, Node, VariableKind};
use crate::config::same_path;
use crate::vars::{self, Segment};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportScope {
    All,
    Home,
    Project(String),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub projects: usize,
    pub collections: usize,
    pub hosts: usize,
    /// Plain and secret, every scope.
    pub variables: usize,
    pub secret_variables: usize,
    pub keys: usize,
}

pub fn counts(file: &DataFile) -> Counts {
    let vars = file
        .variables
        .iter()
        .chain(file.projects.iter().flat_map(|p| p.variables.iter()));
    let (mut variables, mut secret_variables) = (0, 0);
    for v in vars {
        variables += 1;
        if v.kind == VariableKind::Secret {
            secret_variables += 1;
        }
    }
    Counts {
        projects: file.projects.len(),
        collections: file.nodes.iter().filter(|n| n.is_collection()).count(),
        hosts: file.nodes.iter().filter(|n| !n.is_collection()).count(),
        variables,
        secret_variables,
        keys: file.keys.len(),
    }
}

fn fields(h: &Host) -> Vec<&str> {
    let mut out = vec![h.hostname.as_str(), h.port.as_str(), h.username.as_str()];
    match &h.auth {
        AuthMethod::Password { password } => out.extend(password.as_deref()),
        AuthMethod::Key {
            key_path,
            passphrase,
        } => {
            out.push(key_path);
            out.extend(passphrase.as_deref());
        }
        AuthMethod::Agent => {}
    }
    out
}

pub(super) fn references(h: &Host) -> Vec<&str> {
    fields(h)
        .into_iter()
        .filter_map(|t| vars::parse(t).ok())
        .flat_map(|segments| {
            segments.into_iter().filter_map(|s| match s {
                Segment::Reference(r) => Some(r),
                Segment::Literal(_) => None,
            })
        })
        .collect()
}

/// The key path of a host when it is a literal (no reference), expanded.
fn literal_key_path(h: &Host) -> Option<std::path::PathBuf> {
    let AuthMethod::Key { key_path, .. } = &h.auth else {
        return None;
    };
    let segments = vars::parse(key_path).ok()?;
    if vars::has_references(&segments) {
        return None;
    }
    let literal: String = segments
        .iter()
        .map(|s| match s {
            Segment::Literal(l) => l.as_str(),
            Segment::Reference(_) => "",
        })
        .collect();
    crate::fsutil::expand_local(&literal)
}

fn key_used(key: &KeyEntry, paths: &[std::path::PathBuf]) -> bool {
    paths.iter().any(|p| {
        let canonical = crate::fsutil::canonical(p).ok();
        [Some(p.as_path()), canonical.as_deref()]
            .into_iter()
            .flatten()
            .filter_map(Path::to_str)
            .any(|p| same_path(p, &key.path))
    })
}

fn same_component(a: std::path::Component<'_>, b: std::path::Component<'_>) -> bool {
    if cfg!(windows) {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// The plain components of `path` after `home`, when `path` is below it (compared per
/// component, case-insensitively on Windows); `None` otherwise or with `..`.
fn below<'p>(path: &'p Path, home: &Path) -> Option<Vec<&'p str>> {
    use std::path::Component;
    let mut rest = path.components();
    for h in home.components() {
        match rest.next() {
            Some(c) if same_component(c, h) => {}
            _ => return None,
        }
    }
    let parts: Vec<&str> = rest
        .map(|c| match c {
            Component::Normal(n) => n.to_str(),
            _ => None,
        })
        .collect::<Option<_>>()?;
    (!parts.is_empty()).then_some(parts)
}

/// Whether `path` is strictly below `home`.
pub(super) fn under(path: &Path, home: &Path) -> bool {
    below(path, home).is_some()
}

/// `~/…` with `/` separators under the home directory, so the file works for another user
/// name or OS layout; any other path as stored. Rebuilt from the path's own components.
pub fn portable_path(path: &str, home: Option<&Path>) -> String {
    match home.and_then(|h| below(Path::new(path), h)) {
        Some(parts) => format!("~/{}", parts.join("/")),
        None => path.to_owned(),
    }
}

pub struct ExportInput<'a> {
    pub scope: &'a ExportScope,
    pub include_shared: bool,
    pub home: Option<&'a Path>,
    pub exported_at: String,
    pub app_version: &'a str,
}

/// `None` when the project does not exist. Reads only `data.json` types: nothing here can hold
/// a secret value.
pub fn build(cfg: &ConfigFile, input: &ExportInput<'_>) -> Option<DataFile> {
    let project = |p: &crate::config::Project| FileProject {
        id: p.id.clone(),
        name: p.name.clone(),
        variables: format::from_variables(&p.variables),
    };
    let keys = |list: &mut dyn Iterator<Item = &KeyEntry>| {
        list.map(|k| format::file_key(k, portable_path(&k.path, input.home)))
            .collect()
    };
    let (scope, variables, projects, nodes, file_keys) = match input.scope {
        ExportScope::All => (
            FileScope::All,
            format::from_variables(&cfg.variables),
            cfg.projects.iter().map(project).collect(),
            cfg.nodes.clone(),
            keys(&mut cfg.keys.iter()),
        ),
        ExportScope::Home => (
            FileScope::Home,
            format::from_variables(&cfg.variables),
            Vec::new(),
            cfg.nodes
                .iter()
                .filter(|n| n.project_id().is_none())
                .cloned()
                .collect(),
            keys(&mut cfg.keys.iter()),
        ),
        ExportScope::Project(id) => {
            let p = cfg.project(id)?;
            let nodes: Vec<Node> = cfg
                .nodes
                .iter()
                .filter(|n| n.project_id() == Some(id.as_str()))
                .cloned()
                .collect();
            let (variables, used_keys) = if input.include_shared {
                let hosts: Vec<&Host> = nodes.iter().filter_map(Node::as_host).collect();
                let names: HashSet<&str> = hosts
                    .iter()
                    .flat_map(|h| references(h))
                    .filter(|r| !p.variables.iter().any(|v| v.name == *r))
                    .collect();
                let globals: Vec<_> = cfg
                    .variables
                    .iter()
                    .filter(|v| names.contains(v.name.as_str()))
                    .cloned()
                    .collect();
                let paths: Vec<_> = hosts.iter().filter_map(|h| literal_key_path(h)).collect();
                let used: Vec<&KeyEntry> =
                    cfg.keys.iter().filter(|k| key_used(k, &paths)).collect();
                (
                    format::from_variables(&globals),
                    keys(&mut used.into_iter()),
                )
            } else {
                (Vec::new(), Vec::new())
            };
            (
                FileScope::Project {
                    project_id: id.clone(),
                    include_shared: input.include_shared,
                },
                variables,
                vec![project(p)],
                nodes,
                used_keys,
            )
        }
    };
    Some(DataFile {
        format: format::FORMAT.into(),
        version: format::VERSION,
        exported_at: Some(input.exported_at.clone()),
        app_version: Some(input.app_version.to_owned()),
        scope,
        variables,
        projects,
        nodes,
        keys: file_keys,
    })
}

/// Lowercase ASCII letters, digits and `-`, at most 40; `project` when nothing is left.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let mut out: String = out.trim_end_matches('-').chars().take(40).collect();
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "project".into()
    } else {
        out
    }
}

pub fn default_file_name(scope: &ExportScope, project_name: Option<&str>, date: &str) -> String {
    let part = match scope {
        ExportScope::All => "all".to_owned(),
        ExportScope::Home => "home".to_owned(),
        ExportScope::Project(_) => slug(project_name.unwrap_or("")),
    };
    format!("carapace-{part}-{date}.json")
}
