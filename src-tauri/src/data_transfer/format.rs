use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::model::{
    ConfigFile, HostInput, KeyAlgorithm, Node, Project, Variable, VariableKind,
};
use crate::config::validate::{self, MAX_DEPTH, MAX_NODES, MAX_VARIABLES, same_name};
use crate::config::{ConfigError, KeyEntry};
use crate::text::{Localized, Text};

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
#[derive(Debug, Clone, PartialEq)]
pub enum ParseError {
    Format,
    Version(u64),
    NotUtf8,
    Syntax { line: usize, column: usize },
    Invalid(Vec<Text>),
    SecretValue(Text),
}

/// A list parameter: sent as an array of texts the interface translates one by one; the English
/// joins them with `separator`.
#[derive(Debug, Clone, PartialEq)]
pub struct TextList {
    pub items: Vec<Text>,
    pub separator: &'static str,
}

impl Serialize for TextList {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.items.serialize(s)
    }
}

impl std::fmt::Display for TextList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (i, t) in self.items.iter().enumerate() {
            if i > 0 {
                f.write_str(self.separator)?;
            }
            f.write_str(&t.message)?;
        }
        Ok(())
    }
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

    pub fn text(&self) -> Text {
        match self {
            Self::Format => crate::text!(
                "errors.dataTransfer.notDataFile",
                "This is not a Carapace data file."
            ),
            Self::Version(v) => crate::text!(
                "errors.dataTransfer.newerVersion",
                "The file uses data format version {version}; this version of Carapace reads format version {supported}.",
                version = *v,
                supported = VERSION
            ),
            Self::NotUtf8 => {
                crate::text!("errors.dataTransfer.notUtf8", "The file is not UTF-8 text.")
            }
            Self::Syntax { line, column } => crate::text!(
                "errors.dataTransfer.syntax",
                "The file is not valid JSON (line {line}, column {column}).",
                line = *line,
                column = *column
            ),
            Self::Invalid(m) => crate::text!(
                "errors.dataTransfer.invalidFile",
                "{errors}",
                errors = TextList {
                    items: m.clone(),
                    separator: "\n",
                }
            ),
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
        ParseError::Invalid(vec![crate::text!(
            "errors.dataTransfer.unknownStructure",
            "The file does not have the structure Carapace writes."
        )])
    })?;
    let messages = check(&file);
    if messages.is_empty() {
        Ok(file)
    } else {
        Err(ParseError::Invalid(messages))
    }
}

fn quoted_variable(v: &Value) -> Text {
    match v.get("name").and_then(Value::as_str) {
        Some(n) if crate::vars::is_valid_name(n) => crate::text!(
            "errors.dataTransfer.secretVariableNamed",
            "secret variable “{name}”",
            name = n
        ),
        _ => crate::text!(
            "errors.dataTransfer.secretVariableUnnamed",
            "a secret variable"
        ),
    }
}

/// `kind` is a stable code (`host`, `collection`, `project`) the translations select on.
fn label(kind: &'static str, name: Option<&str>) -> Text {
    match name.and_then(|n| validate::name(n).ok()) {
        Some(n) => crate::text!(
            "errors.dataTransfer.itemNamed",
            "{kind} “{name}”",
            kind = kind,
            name = n
        ),
        None => crate::text!("errors.dataTransfer.itemUnnamed", "a {kind}", kind = kind),
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
                return Err(ParseError::SecretValue(crate::text!(
                    "errors.dataTransfer.secretHasValue",
                    "{what} has a value. Carapace never imports secret values.",
                    what = quoted_variable(v)
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
                return Err(ParseError::SecretValue(crate::text!(
                    "errors.dataTransfer.authHasSecret",
                    "{host} has a {field} in the file. Carapace only imports a ${{name}} reference to a secret variable there.",
                    host = host,
                    field = field
                )));
            }
        }
    }
    Ok(())
}

fn kind_label(n: &Node) -> Text {
    let kind = if n.is_collection() {
        "collection"
    } else {
        "host"
    };
    label(kind, Some(n.name()))
}

fn field_message(e: ConfigError) -> Text {
    e.text()
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

struct Messages(Vec<Text>);

impl Messages {
    fn push(&mut self, m: Text) {
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
fn check_sizes(file: &DataFile) -> Vec<Text> {
    let mut out = Vec::new();
    if file.nodes.len() > MAX_NODES {
        out.push(crate::text!(
            "errors.dataTransfer.fileTooManyNodes",
            "The file holds {count} hosts and collections (max {max}).",
            count = file.nodes.len(),
            max = MAX_NODES
        ));
    }
    if file.projects.len() > MAX_PROJECTS {
        out.push(crate::text!(
            "errors.dataTransfer.fileTooManyProjects",
            "The file holds {count} projects (max {max}).",
            count = file.projects.len(),
            max = MAX_PROJECTS
        ));
    }
    if file.keys.len() > MAX_KEYS {
        out.push(crate::text!(
            "errors.dataTransfer.fileTooManyKeys",
            "The file holds {count} SSH keys (max {max}).",
            count = file.keys.len(),
            max = MAX_KEYS
        ));
    }
    let scopes = std::iter::once(&file.variables).chain(file.projects.iter().map(|p| &p.variables));
    if scopes.clone().any(|v| v.len() > MAX_VARIABLES) {
        out.push(crate::text!(
            "errors.dataTransfer.fileTooManyVariables",
            "A scope of the file holds more than {max} variables.",
            max = MAX_VARIABLES
        ));
    }
    out
}

fn check(file: &DataFile) -> Vec<Text> {
    let sizes = check_sizes(file);
    if !sizes.is_empty() {
        return sizes;
    }
    let mut out = Messages(Vec::new());
    check_scope(file, &mut out);
    if let Err(e) = validate::variables(&to_variables(&file.variables)) {
        out.push(crate::text!(
            "errors.dataTransfer.globalVariables",
            "global variables: {error}.",
            error = field_message(e)
        ));
    }
    check_projects(file, &mut out);
    if !out.full() {
        check_nodes(file, &mut out);
    }
    check_keys(file, &mut out);
    if out.0.is_empty()
        && let Err(e) = validate::structure(&as_config(file))
    {
        out.push(crate::text!(
            "errors.dataTransfer.inconsistentNodes",
            "The hosts and collections are not consistent: {error}.",
            error = e
        ));
    }
    out.0
}

fn check_scope(file: &DataFile, out: &mut Messages) {
    match &file.scope {
        FileScope::All => {}
        FileScope::Home => {
            if !file.projects.is_empty() || file.nodes.iter().any(|n| n.project_id().is_some()) {
                out.push(crate::text!(
                    "errors.dataTransfer.homeWithProjects",
                    "A Home export cannot hold projects."
                ));
            }
        }
        FileScope::Project { project_id, .. } => {
            if file.projects.len() != 1 || &file.projects[0].id != project_id {
                out.push(crate::text!(
                    "errors.dataTransfer.projectExportProjects",
                    "A project export must hold exactly its project."
                ));
            }
            if file
                .nodes
                .iter()
                .any(|n| n.project_id() != Some(project_id.as_str()))
            {
                out.push(crate::text!(
                    "errors.dataTransfer.projectExportForeignNodes",
                    "A project export holds hosts or collections of another scope."
                ));
            }
        }
    }
}

fn invalid_name(who: &Text) -> Text {
    crate::text!(
        "errors.dataTransfer.invalidName",
        "{who} has an invalid name (1 to 100 characters).",
        who = who
    )
}

fn invalid_id(who: &Text) -> Text {
    crate::text!(
        "errors.dataTransfer.invalidId",
        "{who}: the id is not valid.",
        who = who
    )
}

fn item_error(who: &Text, e: ConfigError) -> Text {
    crate::text!(
        "errors.dataTransfer.itemError",
        "{who}: {error}.",
        who = who,
        error = field_message(e)
    )
}

fn check_projects(file: &DataFile, out: &mut Messages) {
    let mut names: Vec<&str> = Vec::new();
    for p in &file.projects {
        let who = label("project", Some(&p.name));
        if validate::name(&p.name).is_err() {
            out.push(invalid_name(&who));
        } else if names.iter().any(|n| same_name(n, &p.name)) {
            out.push(crate::text!(
                "errors.dataTransfer.inFileTwice",
                "{who} is in the file twice.",
                who = &who
            ));
        }
        names.push(&p.name);
        if !validate::is_canonical_id(&p.id) {
            out.push(invalid_id(&who));
        }
        if let Err(e) = validate::variables(&to_variables(&p.variables)) {
            out.push(item_error(&who, e));
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
        let who = &kind_label(n);
        if validate::name(n.name()).is_err() {
            out.push(invalid_name(who));
        }
        if !validate::is_canonical_id(n.id()) {
            out.push(invalid_id(who));
        } else if !ids.insert(n.id()) {
            out.push(crate::text!(
                "errors.dataTransfer.idTwice",
                "{who}: the id is used twice.",
                who = who
            ));
        }
        if let Some(p) = n.project_id()
            && !projects.contains(p)
        {
            out.push(crate::text!(
                "errors.dataTransfer.projectMissing",
                "{who}: its project is not in the file.",
                who = who
            ));
        }
        if let Some(parent) = n.parent_id() {
            if parent == n.id() {
                out.push(crate::text!(
                    "errors.dataTransfer.ownParent",
                    "{who} is its own parent.",
                    who = who
                ));
            } else {
                match by_id.get(parent) {
                    Some(c) if c.is_collection() && c.project_id() == n.project_id() => {
                        if n.is_collection() {
                            match validate::collection_chain(&by_id, Some(parent)) {
                                None => out.push(crate::text!(
                                    "errors.dataTransfer.cycleOrTooDeep",
                                    "{who} is inside itself or nested too deep.",
                                    who = who
                                )),
                                Some(chain) if chain.iter().any(|c| c.id() == n.id()) => {
                                    out.push(crate::text!(
                                        "errors.dataTransfer.insideItself",
                                        "{who} is inside itself.",
                                        who = who
                                    ))
                                }
                                Some(chain) if chain.len() >= MAX_DEPTH => out.push(crate::text!(
                                    "errors.dataTransfer.tooDeep",
                                    "{who} is nested deeper than {max} levels.",
                                    who = who,
                                    max = MAX_DEPTH
                                )),
                                Some(_) => {}
                            }
                        }
                    }
                    Some(c) if c.is_collection() => out.push(crate::text!(
                        "errors.dataTransfer.parentOtherScope",
                        "{who}: its parent collection is in another scope.",
                        who = who
                    )),
                    _ => out.push(crate::text!(
                        "errors.dataTransfer.parentMissing",
                        "{who}: its parent collection is not in the file.",
                        who = who
                    )),
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
                    out.push(crate::text!(
                        "errors.dataTransfer.twiceInPlace",
                        "{who} is twice in the same place.",
                        who = who
                    ));
                }
                collection_names.push((key.0, key.1, &c.name));
            }
            Node::Host(h) => {
                let scope = h.project_id.as_deref();
                if host_names
                    .iter()
                    .any(|(p, name)| *p == scope && same_name(name, &h.name))
                {
                    out.push(crate::text!(
                        "errors.dataTransfer.twiceInScope",
                        "{who} is twice in the same scope.",
                        who = who
                    ));
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
                    out.push(item_error(who, e));
                }
            }
        }
    }
}

fn check_keys(file: &DataFile, out: &mut Messages) {
    for k in &file.keys {
        let who = match validate::key_name(&k.name) {
            Ok(n) => crate::text!("errors.dataTransfer.keyNamed", "SSH key “{name}”", name = n),
            Err(_) => {
                out.push(crate::text!(
                    "errors.dataTransfer.keyInvalidName",
                    "An SSH key has an invalid name (1 to 64 characters)."
                ));
                continue;
            }
        };
        if validate::key_path(&k.path).is_err() {
            out.push(crate::text!(
                "errors.dataTransfer.keyPathNotLocal",
                "{who}: the path must be absolute or start with ~/.",
                who = &who
            ));
        }
        if k.bits.is_some_and(|b| b == 0 || b > MAX_KEY_BITS) {
            out.push(crate::text!(
                "errors.dataTransfer.keySizeInvalid",
                "{who}: the key size is not valid.",
                who = &who
            ));
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
