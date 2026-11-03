use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, Prefix};

use uuid::Uuid;

use super::model::{AuthMethod, ConfigFile, HostInput, Node, Template, Variable, VariableKind};
use super::store::ConfigError;
use crate::vars::{self, Segment};

pub const MAX_VARIABLES: usize = 200;
pub const MAX_PLAIN_VALUE_CHARS: usize = 4096;
pub const MAX_NODES: usize = 5000;
pub const MAX_DEPTH: usize = 32;

fn invalid(msg: impl Into<String>) -> ConfigError {
    ConfigError::InvalidInput(msg.into())
}

pub(super) fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

pub(super) fn name(raw: &str) -> Result<String, ConfigError> {
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if !(1..=100).contains(&len) {
        return Err(invalid("name must be 1 to 100 characters"));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn key_name(raw: &str) -> Result<String, ConfigError> {
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if !(1..=64).contains(&len) {
        return Err(invalid("key name must be 1 to 64 characters"));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(invalid("key name must not contain control characters"));
    }
    Ok(trimmed.to_string())
}

fn token(value: &str, max: usize, label: &str) -> Result<(), String> {
    let len = value.chars().count();
    if len == 0 || len > max {
        return Err(format!("{label} must be 1 to {max} characters"));
    }
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!(
            "{label} must not contain whitespace or control characters"
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
pub(crate) fn hostname(value: &str) -> Result<(), String> {
    token(value, 253, "hostname")?;
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        return Err("hostname may only contain letters, digits, '.', '-' and ':'".into());
    }
    Ok(())
}

pub(crate) fn port(value: &str) -> Result<u16, String> {
    let digits = !value.is_empty() && value.len() <= 5 && value.bytes().all(|b| b.is_ascii_digit());
    digits
        .then(|| value.parse::<u16>().ok())
        .flatten()
        .filter(|p| *p != 0)
        .ok_or_else(|| "port must be between 1 and 65535".into())
}

pub(crate) fn username(value: &str) -> Result<(), String> {
    token(value, 64, "username")
}

pub(crate) fn key_path(value: &str) -> Result<(), String> {
    if value.chars().count() > 4096 || value.chars().any(char::is_control) {
        return Err("key path is invalid".into());
    }
    if !value.starts_with("~/") && !is_local_absolute(value) {
        return Err("key path must be absolute or start with ~/".into());
    }
    Ok(())
}

/// Parses a plain-field template; without references it must already be a valid value.
fn plain_field(
    template: &str,
    label: &str,
    check: impl Fn(&str) -> Result<(), String>,
) -> Result<(), ConfigError> {
    let segments = vars::parse(template).map_err(|e| invalid(format!("{label} {e}")))?;
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

fn secret_field(template: &Option<Template>, label: &str) -> Result<(), ConfigError> {
    match template {
        Some(t) if vars::single_reference(t).is_none() => Err(invalid(format!(
            "{label} must be empty or a single ${{name}} reference to a secret variable"
        ))),
        _ => Ok(()),
    }
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
pub(super) fn variables(list: &[Variable]) -> Result<Vec<Variable>, ConfigError> {
    if list.len() > MAX_VARIABLES {
        return Err(invalid(format!(
            "a scope holds at most {MAX_VARIABLES} variables"
        )));
    }
    let mut out: Vec<Variable> = Vec::with_capacity(list.len());
    for v in list {
        if !vars::is_valid_name(&v.name) {
            return Err(invalid(
                "variable names start with a letter or '_' and contain only letters, digits, '_', '.' and '-' (64 characters at most)",
            ));
        }
        if out.iter().any(|o| same_name(&o.name, &v.name)) {
            return Err(ConfigError::InvalidInput(format!(
                "variable {} is defined twice",
                v.name
            )));
        }
        let value = match v.kind {
            VariableKind::Plain => {
                let value = v.value.clone().unwrap_or_default();
                if value.chars().count() > MAX_PLAIN_VALUE_CHARS {
                    return Err(ConfigError::InvalidInput(format!(
                        "the value of {} is longer than {MAX_PLAIN_VALUE_CHARS} characters",
                        v.name
                    )));
                }
                Some(value)
            }
            VariableKind::Secret => {
                if v.value.is_some() {
                    return Err(ConfigError::InvalidInput(format!(
                        "secret variable {} cannot have a plain value",
                        v.name
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
pub(super) fn collection_chain<'a>(
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
pub(super) fn structure(cfg: &ConfigFile) -> Result<(), String> {
    if cfg.nodes.len() > MAX_NODES {
        return Err(format!("more than {MAX_NODES} nodes"));
    }
    let mut ids = HashSet::new();
    let mut add = |id: &str| -> Result<(), String> {
        if !is_canonical_id(id) {
            return Err("an id is not a canonical UUID".into());
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("id {id} is used twice"));
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
    for n in &cfg.nodes {
        if let Some(p) = n.project_id()
            && !projects.contains(p)
        {
            return Err(format!("node {} refers to a missing project", n.id()));
        }
        let Some(parent) = n.parent_id() else {
            continue;
        };
        let chain = collection_chain(&by_id, Some(parent))
            .ok_or_else(|| format!("node {} has an invalid parent", n.id()))?;
        if chain
            .iter()
            .any(|c| c.project_id() != n.project_id() || c.id() == n.id())
        {
            return Err(format!("node {} has an invalid parent", n.id()));
        }
        if n.is_collection() && chain.len() >= MAX_DEPTH {
            return Err(format!("collection {} is nested too deep", n.id()));
        }
    }
    Ok(())
}
