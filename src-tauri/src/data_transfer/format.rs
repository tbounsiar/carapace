use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::model::{
    ConfigFile, HostInput, KeyAlgorithm, Node, Project, Variable, VariableKind,
};
use crate::config::validate::{self, MAX_DEPTH, MAX_NODES, MAX_VARIABLES, same_name};
use crate::config::{ConfigError, KeyEntry};

pub const FORMAT: &str = "carapace-data";
pub const VERSION: u64 = 1;
/// Same cap as `data.json`.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Messages of an invalid file shown at most.
const MAX_MESSAGES: usize = 5;
const MAX_KEY_BITS: u32 = 16384;
pub const MAX_PROJECTS: usize = 1000;
pub const MAX_KEYS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileScope {
    All,
    Home,
    Project {
        project_id: String,
        #[serde(default)]
        include_shared: bool,
    },
}

/// A secret variable has no `value` key at all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVariable {
    pub name: String,
    pub kind: VariableKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<FileVariable>,
}

/// Public facts only: no key material, fingerprint, comment or origin. The id is never reused
/// on import.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileKey {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub path: String,
    pub algorithm: KeyAlgorithm,
    #[serde(default)]
    pub bits: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFile {
    pub format: String,
    pub version: u64,
    #[serde(default)]
    pub exported_at: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    pub scope: FileScope,
    #[serde(default)]
    pub variables: Vec<FileVariable>,
    #[serde(default)]
    pub projects: Vec<FileProject>,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub keys: Vec<FileKey>,
}

/// Messages never quote a value from the file; only item kinds and names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    Format,
    Version(u64),
    NotUtf8,
    Syntax { line: usize, column: usize },
    Invalid(Vec<String>),
    SecretValue(String),
}

impl ParseError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Format => "import_format",
            Self::Version(_) => "import_version",
            Self::NotUtf8 | Self::Syntax { .. } => "import_malformed",
            Self::Invalid(_) => "import_invalid",
            Self::SecretValue(_) => "import_secret_value",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Format => "This is not a Carapace data file.".into(),
            Self::Version(v) => format!(
                "The file uses data format version {v}; this version of Carapace reads format version {VERSION}."
            ),
            Self::NotUtf8 => "The file is not UTF-8 text.".into(),
            Self::Syntax { line, column } => {
                format!("The file is not valid JSON (line {line}, column {column}).")
            }
            Self::Invalid(m) => m.join("\n"),
            Self::SecretValue(m) => m.clone(),
        }
    }
}

/// Plain values default to "", as in `data.json`.
pub(super) fn to_variables(list: &[FileVariable]) -> Vec<Variable> {
    list.iter()
        .map(|v| Variable {
            name: v.name.clone(),
            kind: v.kind,
            value: match v.kind {
                VariableKind::Plain => Some(v.value.clone().unwrap_or_default()),
                VariableKind::Secret => None,
            },
        })
        .collect()
}

pub(super) fn from_variables(list: &[Variable]) -> Vec<FileVariable> {
    list.iter()
        .map(|v| FileVariable {
            name: v.name.clone(),
            kind: v.kind,
            value: match v.kind {
                VariableKind::Plain => Some(v.value.clone().unwrap_or_default()),
                VariableKind::Secret => None,
            },
        })
        .collect()
}

pub fn to_bytes(file: &DataFile) -> Vec<u8> {
    let mut out = serde_json::to_vec_pretty(file).unwrap_or_default();
    out.push(b'\n');
    out
}

/// Reads and checks a data file: encoding, JSON, `format` and `version`, secret values (refused,
/// never stripped), the typed shape, then every rule `data.json` follows.
pub fn parse(raw: &[u8]) -> Result<DataFile, ParseError> {
    let text = std::str::from_utf8(raw).map_err(|_| ParseError::NotUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let value: Value = serde_json::from_str(text).map_err(|e| ParseError::Syntax {
        line: e.line(),
        column: e.column(),
    })?;
    let obj = value.as_object().ok_or(ParseError::Format)?;
    if obj.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(ParseError::Format);
    }
    let version = obj
        .get("version")
        .and_then(Value::as_u64)
        .filter(|v| *v >= 1)
        .ok_or(ParseError::Format)?;
    if version > VERSION {
        return Err(ParseError::Version(version));
    }
    secret_values(&value)?;
    let file: DataFile = serde_json::from_value(value).map_err(|_| {
        ParseError::Invalid(vec![
            "The file does not have the structure Carapace writes.".into(),
        ])
    })?;
    let messages = check(&file);
    if messages.is_empty() {
        Ok(file)
    } else {
        Err(ParseError::Invalid(messages))
    }
}

fn quoted_variable(v: &Value) -> String {
    match v.get("name").and_then(Value::as_str) {
        Some(n) if crate::vars::is_valid_name(n) => format!("secret variable “{n}”"),
        _ => "a secret variable".into(),
    }
}

fn label(kind: &str, name: Option<&str>) -> String {
    match name.and_then(|n| validate::name(n).ok()) {
        Some(n) => format!("{kind} “{n}”"),
        None => format!("a {kind}"),
    }
}

/// Walks the raw document so a value is refused whatever else is wrong with the file.
fn secret_values(doc: &Value) -> Result<(), ParseError> {
    let lists = std::iter::once(doc.get("variables")).chain(
        doc.get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|p| p.get("variables")),
    );
    for list in lists.flatten().filter_map(Value::as_array) {
        for v in list {
            let secret = v.get("kind").and_then(Value::as_str) == Some("secret");
            if secret && v.get("value").is_some_and(|x| !x.is_null()) {
                return Err(ParseError::SecretValue(format!(
                    "{} has a value. Carapace never imports secret values.",
                    quoted_variable(v)
                )));
            }
        }
    }
    for n in doc
        .get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if n.get("kind").and_then(Value::as_str) != Some("host") {
            continue;
        }
        let Some(auth) = n.get("auth") else { continue };
        for field in ["password", "passphrase"] {
            let ok = match auth.get(field) {
                None | Some(Value::Null) => true,
                Some(Value::String(s)) => crate::vars::single_reference(s).is_some(),
                Some(_) => false,
            };
            if !ok {
                let host = label("host", n.get("name").and_then(Value::as_str));
                return Err(ParseError::SecretValue(format!(
                    "{host} has a {field} in the file. Carapace only imports a ${{name}} reference to a secret variable there."
                )));
            }
        }
    }
    Ok(())
}

fn kind_label(n: &Node) -> String {
    let kind = if n.is_collection() {
        "collection"
    } else {
        "host"
    };
    label(kind, Some(n.name()))
}

fn field_message(e: ConfigError) -> String {
    match e {
        ConfigError::InvalidInput(m) => m,
        other => other.to_string(),
    }
}

/// The data of the file as a `data.json` document, keys left out.
pub(super) fn as_config(file: &DataFile) -> ConfigFile {
    ConfigFile {
        variables: to_variables(&file.variables),
        projects: file
            .projects
            .iter()
            .map(|p| Project {
                id: p.id.clone(),
                name: p.name.clone(),
                variables: to_variables(&p.variables),
            })
            .collect(),
        nodes: file.nodes.clone(),
        ..ConfigFile::default()
    }
}

struct Messages(Vec<String>);

impl Messages {
    fn push(&mut self, m: String) {
        if self.0.len() < MAX_MESSAGES && !self.0.contains(&m) {
            self.0.push(m);
        }
    }

    fn full(&self) -> bool {
        self.0.len() >= MAX_MESSAGES
    }
}

/// Counts are checked before any per-item work, so no check below is quadratic in an
/// unbounded list.
fn check_sizes(file: &DataFile) -> Vec<String> {
    let mut out = Vec::new();
    if file.nodes.len() > MAX_NODES {
        out.push(format!(
            "The file holds {} hosts and collections (max {MAX_NODES}).",
            file.nodes.len()
        ));
    }
    if file.projects.len() > MAX_PROJECTS {
        out.push(format!(
            "The file holds {} projects (max {MAX_PROJECTS}).",
            file.projects.len()
        ));
    }
    if file.keys.len() > MAX_KEYS {
        out.push(format!(
            "The file holds {} SSH keys (max {MAX_KEYS}).",
            file.keys.len()
        ));
    }
    let scopes = std::iter::once(&file.variables).chain(file.projects.iter().map(|p| &p.variables));
    if scopes.clone().any(|v| v.len() > MAX_VARIABLES) {
        out.push(format!(
            "A scope of the file holds more than {MAX_VARIABLES} variables."
        ));
    }
    out
}

fn check(file: &DataFile) -> Vec<String> {
    let sizes = check_sizes(file);
    if !sizes.is_empty() {
        return sizes;
    }
    let mut out = Messages(Vec::new());
    check_scope(file, &mut out);
    if let Err(e) = validate::variables(&to_variables(&file.variables)) {
        out.push(format!("global variables: {}.", field_message(e)));
    }
    check_projects(file, &mut out);
    if !out.full() {
        check_nodes(file, &mut out);
    }
    check_keys(file, &mut out);
    if out.0.is_empty()
        && let Err(e) = validate::structure(&as_config(file))
    {
        out.push(format!(
            "The hosts and collections are not consistent: {e}."
        ));
    }
    out.0
}

fn check_scope(file: &DataFile, out: &mut Messages) {
    match &file.scope {
        FileScope::All => {}
        FileScope::Home => {
            if !file.projects.is_empty() || file.nodes.iter().any(|n| n.project_id().is_some()) {
                out.push("A Home export cannot hold projects.".into());
            }
        }
        FileScope::Project { project_id, .. } => {
            if file.projects.len() != 1 || &file.projects[0].id != project_id {
                out.push("A project export must hold exactly its project.".into());
            }
            if file
                .nodes
                .iter()
                .any(|n| n.project_id() != Some(project_id.as_str()))
            {
                out.push("A project export holds hosts or collections of another scope.".into());
            }
        }
    }
}

fn check_projects(file: &DataFile, out: &mut Messages) {
    let mut names: Vec<&str> = Vec::new();
    for p in &file.projects {
        let who = label("project", Some(&p.name));
        if validate::name(&p.name).is_err() {
            out.push(format!("{who} has an invalid name (1 to 100 characters)."));
        } else if names.iter().any(|n| same_name(n, &p.name)) {
            out.push(format!("{who} is in the file twice."));
        }
        names.push(&p.name);
        if !validate::is_canonical_id(&p.id) {
            out.push(format!("{who}: the id is not valid."));
        }
        if let Err(e) = validate::variables(&to_variables(&p.variables)) {
            out.push(format!("{who}: {}.", field_message(e)));
        }
    }
}

fn check_nodes(file: &DataFile, out: &mut Messages) {
    let projects: HashSet<&str> = file.projects.iter().map(|p| p.id.as_str()).collect();
    let mut ids: HashSet<&str> = projects.clone();
    let by_id: HashMap<&str, &Node> = file.nodes.iter().map(|n| (n.id(), n)).collect();
    let mut collection_names: Vec<(Option<&str>, Option<&str>, &str)> = Vec::new();
    let mut host_names: Vec<(Option<&str>, &str)> = Vec::new();
    for n in &file.nodes {
        if out.full() {
            return;
        }
        let who = kind_label(n);
        if validate::name(n.name()).is_err() {
            out.push(format!("{who} has an invalid name (1 to 100 characters)."));
        }
        if !validate::is_canonical_id(n.id()) {
            out.push(format!("{who}: the id is not valid."));
        } else if !ids.insert(n.id()) {
            out.push(format!("{who}: the id is used twice."));
        }
        if let Some(p) = n.project_id()
            && !projects.contains(p)
        {
            out.push(format!("{who}: its project is not in the file."));
        }
        if let Some(parent) = n.parent_id() {
            if parent == n.id() {
                out.push(format!("{who} is its own parent."));
            } else {
                match by_id.get(parent) {
                    Some(c) if c.is_collection() && c.project_id() == n.project_id() => {
                        if n.is_collection() {
                            match validate::collection_chain(&by_id, Some(parent)) {
                                None => {
                                    out.push(format!("{who} is inside itself or nested too deep."))
                                }
                                Some(chain) if chain.iter().any(|c| c.id() == n.id()) => {
                                    out.push(format!("{who} is inside itself."))
                                }
                                Some(chain) if chain.len() >= MAX_DEPTH => out.push(format!(
                                    "{who} is nested deeper than {MAX_DEPTH} levels."
                                )),
                                Some(_) => {}
                            }
                        }
                    }
                    Some(c) if c.is_collection() => {
                        out.push(format!("{who}: its parent collection is in another scope."))
                    }
                    _ => out.push(format!("{who}: its parent collection is not in the file.")),
                }
            }
        }
        match n {
            Node::Collection(c) => {
                let key = (c.project_id.as_deref(), c.parent_id.as_deref());
                if collection_names
                    .iter()
                    .any(|(p, q, name)| (*p, *q) == key && same_name(name, &c.name))
                {
                    out.push(format!("{who} is twice in the same place."));
                }
                collection_names.push((key.0, key.1, &c.name));
            }
            Node::Host(h) => {
                let scope = h.project_id.as_deref();
                if host_names
                    .iter()
                    .any(|(p, name)| *p == scope && same_name(name, &h.name))
                {
                    out.push(format!("{who} is twice in the same scope."));
                }
                host_names.push((scope, &h.name));
                let input = HostInput {
                    name: h.name.clone(),
                    hostname: h.hostname.clone(),
                    port: h.port.clone(),
                    username: h.username.clone(),
                    auth: h.auth.clone(),
                };
                if let Err(e) = validate::host(&input) {
                    out.push(format!("{who}: {}.", field_message(e)));
                }
            }
        }
    }
}

fn check_keys(file: &DataFile, out: &mut Messages) {
    for k in &file.keys {
        let who = match validate::key_name(&k.name) {
            Ok(n) => format!("SSH key “{n}”"),
            Err(_) => {
                out.push("An SSH key has an invalid name (1 to 64 characters).".into());
                continue;
            }
        };
        if validate::key_path(&k.path).is_err() {
            out.push(format!(
                "{who}: the path must be absolute or start with ~/."
            ));
        }
        if k.bits.is_some_and(|b| b == 0 || b > MAX_KEY_BITS) {
            out.push(format!("{who}: the key size is not valid."));
        }
    }
}

/// Only the public facts the format carries.
pub(super) fn file_key(k: &KeyEntry, path: String) -> FileKey {
    FileKey {
        id: k.id.clone(),
        name: k.name.clone(),
        path,
        algorithm: k.algorithm,
        bits: k.bits,
    }
}

#[cfg(test)]
#[path = "format_tests.rs"]
mod tests;
