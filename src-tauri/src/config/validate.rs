use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, Prefix};

use uuid::Uuid;

use super::model::{AuthMethod, ConfigFile, HostInput, Node, Template, Variable, VariableKind};
use super::store::ConfigError;
use crate::text;
use crate::text::Text;
use crate::vars::{self, Segment};

pub const MAX_VARIABLES: usize = 200;
pub const MAX_PLAIN_VALUE_CHARS: usize = 4096;
pub const MAX_NODES: usize = 5000;
pub const MAX_DEPTH: usize = 32;

fn invalid(msg: Text) -> ConfigError {
    ConfigError::InvalidInput(msg)
}

pub(crate) fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

pub(crate) fn name(raw: &str) -> Result<String, ConfigError> {
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if !(1..=100).contains(&len) {
        return Err(invalid(text!(
            "errors.config.nameLength",
            "name must be 1 to {max} characters",
            max = 100
        )));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn key_name(raw: &str) -> Result<String, ConfigError> {
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if !(1..=64).contains(&len) {
        return Err(invalid(text!(
            "errors.config.keyNameLength",
            "key name must be 1 to {max} characters",
            max = 64
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(invalid(text!(
            "errors.config.keyNameControl",
            "key name must not contain control characters"
        )));
    }
    Ok(trimmed.to_string())
}

/// `field` is "hostname" or "username".
fn token(value: &str, max: usize, field: &'static str) -> Result<(), Text> {
    let len = value.chars().count();
    if len == 0 || len > max {
        return Err(text!(
            "errors.config.fieldLength",
            "{field} must be 1 to {max} characters",
            field = field,
            max = max
        ));
    }
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(text!(
            "errors.config.fieldWhitespace",
            "{field} must not contain whitespace or control characters",
            field = field
        ));
    }
    Ok(())
}

pub(crate) fn is_local_absolute(path: &str) -> bool {
    if path.starts_with("\\") || path.starts_with("//") {
        return false;
    }
    let p = Path::new(path);
    if let Some(Component::Prefix(prefix)) = p.components().next()
        && !matches!(prefix.kind(), Prefix::Disk(_))
    {
        return false;
    }
    p.is_absolute()
}

/// The checks below apply to resolved values; messages never quote the value.
pub(crate) fn hostname(value: &str) -> Result<(), Text> {
    token(value, 253, "hostname")?;
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        return Err(text!(
            "errors.config.hostnameCharacters",
            "hostname may only contain letters, digits, '.', '-' and ':'"
        ));
    }
    Ok(())
}

pub(crate) fn port(value: &str) -> Result<u16, Text> {
    let digits = !value.is_empty() && value.len() <= 5 && value.bytes().all(|b| b.is_ascii_digit());
    digits
        .then(|| value.parse::<u16>().ok())
        .flatten()
        .filter(|p| *p != 0)
        .ok_or_else(|| {
            text!(
                "errors.config.portRange",
                "port must be between {min} and {max}",
                min = 1,
                max = 65535
            )
        })
}

pub(crate) fn username(value: &str) -> Result<(), Text> {
    token(value, 64, "username")
}

pub(crate) fn key_path(value: &str) -> Result<(), Text> {
    if value.chars().count() > 4096 || value.chars().any(char::is_control) {
        return Err(text!("errors.config.keyPathInvalid", "key path is invalid"));
    }
    let local = match value.strip_prefix("~/") {
        Some(rest) => crate::fsutil::is_home_relative(rest),
        None => is_local_absolute(value),
    };
    if !local {
        return Err(text!(
            "errors.config.keyPathNotLocal",
            "key path must be absolute or start with ~/"
        ));
    }
    Ok(())
}

/// Parses a plain-field template; without references it must already be a valid value.
fn plain_field(
    template: &str,
    label: &'static str,
    check: impl Fn(&str) -> Result<(), Text>,
) -> Result<(), ConfigError> {
    let segments = vars::parse(template).map_err(|e| invalid(e.of_field(label)))?;
    if vars::has_references(&segments) {
        return Ok(());
    }
    let literal: String = segments
        .iter()
        .map(|s| match s {
            Segment::Literal(l) => l.as_str(),
            Segment::Reference(_) => "",
        })
        .collect();
    check(&literal).map_err(invalid)
}

/// The error of a secret field ("password" or "passphrase") that is not one reference.
pub(crate) fn not_a_secret_reference(field: &'static str) -> Text {
    text!(
        "errors.config.secretFieldReference",
        "{field} must be empty or a single ${{name}} reference to a secret variable",
        field = field
    )
}

fn secret_field(template: &Option<Template>, field: &'static str) -> Result<(), ConfigError> {
    match template {
        Some(t) if vars::single_reference(t).is_none() => {
            Err(invalid(not_a_secret_reference(field)))
        }
        _ => Ok(()),
    }
}

/// Also checked by the variable commands before a name is quoted in a message.
pub(crate) fn invalid_variable_name() -> Text {
    text!(
        "errors.config.variableName",
        "variable names start with a letter or '_' and contain only letters, digits, '_', '.' and '-' ({max} characters at most)",
        max = vars::MAX_NAME_CHARS
    )
}

pub(crate) struct ValidHost {
    pub name: String,
    pub hostname: Template,
    pub port: Template,
    pub username: Template,
    pub auth: AuthMethod,
}

pub(crate) fn host(input: &HostInput) -> Result<ValidHost, ConfigError> {
    let name = name(&input.name)?;
    plain_field(&input.hostname, "hostname", hostname)?;
    plain_field(&input.port, "port", |v| port(v).map(|_| ()))?;
    plain_field(&input.username, "username", username)?;
    match &input.auth {
        AuthMethod::Password { password } => secret_field(password, "password")?,
        AuthMethod::Key {
            key_path: path,
            passphrase,
        } => {
            plain_field(path, "key path", key_path)?;
            secret_field(passphrase, "passphrase")?;
        }
        AuthMethod::Agent => {}
    }
    Ok(ValidHost {
        name,
        hostname: input.hostname.clone(),
        port: input.port.clone(),
        username: input.username.clone(),
        auth: input.auth.clone(),
    })
}

/// Normalizes a whole scope: plain values default to "", secrets never carry a value.
pub(crate) fn variables(list: &[Variable]) -> Result<Vec<Variable>, ConfigError> {
    if list.len() > MAX_VARIABLES {
        return Err(invalid(text!(
            "errors.config.tooManyVariables",
            "a scope holds at most {max} variables",
            max = MAX_VARIABLES
        )));
    }
    let mut out: Vec<Variable> = Vec::with_capacity(list.len());
    for v in list {
        if !vars::is_valid_name(&v.name) {
            return Err(invalid(invalid_variable_name()));
        }
        if out.iter().any(|o| same_name(&o.name, &v.name)) {
            return Err(invalid(text!(
                "errors.config.variableTwice",
                "variable {name} is defined twice",
                name = v.name.as_str()
            )));
        }
        let value = match v.kind {
            VariableKind::Plain => {
                let value = v.value.clone().unwrap_or_default();
                if value.chars().count() > MAX_PLAIN_VALUE_CHARS {
                    return Err(invalid(text!(
                        "errors.config.valueTooLong",
                        "the value of {name} is longer than {max} characters",
                        name = v.name.as_str(),
                        max = MAX_PLAIN_VALUE_CHARS
                    )));
                }
                Some(value)
            }
            VariableKind::Secret => {
                if v.value.is_some() {
                    return Err(invalid(text!(
                        "errors.config.secretWithValue",
                        "secret variable {name} cannot have a plain value",
                        name = v.name.as_str()
                    )));
                }
                None
            }
        };
        out.push(Variable {
            name: v.name.clone(),
            kind: v.kind,
            value,
        });
    }
    Ok(out)
}

/// Lowercase hyphenated only: keychain accounts are built from ids, and some keychains compare
/// them case-insensitively.
pub(crate) fn is_canonical_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

/// Collections from `id` up to the scope root, `id` included when it is a collection.
/// `None` when a parent is missing, is not a collection, or the chain is longer than
/// `MAX_DEPTH` (which also stops a loop).
pub(crate) fn collection_chain<'a>(
    by_id: &HashMap<&str, &'a Node>,
    id: Option<&str>,
) -> Option<Vec<&'a Node>> {
    let mut out = Vec::new();
    let mut next = id;
    while let Some(id) = next {
        let node = *by_id.get(id)?;
        if !node.is_collection() || out.len() >= MAX_DEPTH {
            return None;
        }
        out.push(node);
        next = node.parent_id();
    }
    Some(out)
}

/// Structural invariants of a version 3 file, limits included; name rules are checked by the
/// mutations. Linear in the number of nodes (chains are at most `MAX_DEPTH` long).
pub(crate) fn structure(cfg: &ConfigFile) -> Result<(), Text> {
    if cfg.nodes.len() > MAX_NODES {
        return Err(text!(
            "errors.config.structureTooManyNodes",
            "more than {max} nodes",
            max = MAX_NODES
        ));
    }
    let mut ids = HashSet::new();
    let mut add = |id: &str| -> Result<(), Text> {
        if !is_canonical_id(id) {
            return Err(text!(
                "errors.config.structureIdNotCanonical",
                "an id is not a canonical UUID"
            ));
        }
        if !ids.insert(id.to_string()) {
            return Err(text!(
                "errors.config.structureIdTwice",
                "id {id} is used twice",
                id = id
            ));
        }
        Ok(())
    };
    for p in &cfg.projects {
        add(&p.id)?;
    }
    let projects: HashSet<&str> = cfg.projects.iter().map(|p| p.id.as_str()).collect();
    for n in &cfg.nodes {
        add(n.id())?;
    }
    let by_id: HashMap<&str, &Node> = cfg.nodes.iter().map(|n| (n.id(), n)).collect();
    let invalid_parent = |id: &str| {
        text!(
            "errors.config.structureInvalidParent",
            "node {id} has an invalid parent",
            id = id
        )
    };
    for n in &cfg.nodes {
        if let Some(p) = n.project_id()
            && !projects.contains(p)
        {
            return Err(text!(
                "errors.config.structureMissingProject",
                "node {id} refers to a missing project",
                id = n.id()
            ));
        }
        let Some(parent) = n.parent_id() else {
            continue;
        };
        let chain = collection_chain(&by_id, Some(parent)).ok_or_else(|| invalid_parent(n.id()))?;
        if chain
            .iter()
            .any(|c| c.project_id() != n.project_id() || c.id() == n.id())
        {
            return Err(invalid_parent(n.id()));
        }
        if n.is_collection() && chain.len() >= MAX_DEPTH {
            return Err(text!(
                "errors.config.structureTooDeep",
                "collection {id} is nested too deep",
                id = n.id()
            ));
        }
    }
    Ok(())
}
