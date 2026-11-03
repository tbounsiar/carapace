use serde::Serialize;

use super::error::CommandError;
use crate::config::{ConfigFile, ConfigStore, Host, Project};
use crate::secrets::{KeyPassKey, SavedKey, SecretError, VarKey};
use crate::ssh::{RegisteredKey, Target, TargetAuth};
use crate::vars::{Layers, Level, Resolution, ResolvedAuth, SecretRef, resolve_host};

type Res<T> = Result<T, CommandError>;

pub(super) fn required(name: &str, value: &str) -> Res<()> {
    if value.trim().is_empty() {
        return Err(CommandError::new(
            "invalid_input",
            format!("{name} is required"),
        ));
    }
    Ok(())
}

fn not_found(what: &str) -> CommandError {
    CommandError::new("not_found", format!("{what} not found"))
}

pub(super) struct Located<'a> {
    pub config: &'a ConfigFile,
    pub project: Option<&'a Project>,
    pub host: &'a Host,
}

impl Located<'_> {
    pub fn resolution(&self) -> Resolution {
        resolve_host(self.host, Layers::of(self.config, self.project))
    }
}

/// Finds the host by id and derives its scope from the host itself.
pub(super) fn locate<'a>(config: &'a ConfigFile, host_id: &str) -> Res<Located<'a>> {
    required("hostId", host_id)?;
    let host = config.host(host_id).ok_or_else(|| not_found("host"))?;
    let project = match host.project_id.as_deref() {
        Some(id) => Some(config.project(id).ok_or_else(|| not_found("project"))?),
        None => None,
    };
    Ok(Located {
        config,
        project,
        host,
    })
}

pub(super) fn var_key(level: &Level, name: &str) -> Result<VarKey, SecretError> {
    match level {
        Level::Global => VarKey::global(name),
        Level::Project(id) => VarKey::project(id, name),
    }
}

fn secret_key(r: Option<SecretRef>) -> Result<Option<VarKey>, SecretError> {
    r.map(|r| var_key(&r.level, &r.name)).transpose()
}

/// Registered keys with a remembered passphrase are not known here (the keychain is read at
/// connect time); every encrypted registered key is a candidate, matched by fingerprint
/// against the key file the connect actually reads.
pub(super) fn registered_keys(config: &ConfigFile) -> Vec<RegisteredKey> {
    config
        .keys
        .iter()
        .filter(|k| k.encrypted)
        .filter_map(|k| {
            Some(RegisteredKey {
                fingerprint: k.fingerprint.clone(),
                passphrase: KeyPassKey::new(&k.id).ok()?,
            })
        })
        .collect()
}

/// Resolves the host into a connect target. Fails with `missing_variables` or `invalid_input`
/// before any network call.
pub(super) fn target(store: &ConfigStore, host_id: &str) -> Res<Target> {
    let config = store.snapshot()?;
    let at = locate(&config, host_id)?;
    let resolved = at.resolution().complete()?;
    let auth = match resolved.auth {
        ResolvedAuth::Agent => TargetAuth::Agent,
        ResolvedAuth::Password { password } => TargetAuth::Password {
            variable: secret_key(password)?,
        },
        ResolvedAuth::Key {
            key_path,
            passphrase,
        } => TargetAuth::Key {
            registered: registered_keys(&config),
            key_path,
            passphrase: secret_key(passphrase)?,
        },
    };
    Ok(Target {
        connection_id: at.host.id.clone(),
        host_id: at.host.id.clone(),
        project_id: at.host.project_id.clone(),
        saved: SavedKey::new(&at.host.id)?,
        hostname: resolved.hostname,
        port: resolved.port,
        username: resolved.username,
        auth,
    })
}

/// Plain fields only, for display; secret values are never resolved here.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedView {
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub key_path: Option<String>,
    pub missing: Vec<String>,
    pub errors: Vec<String>,
}

impl From<Resolution> for ResolvedView {
    fn from(r: Resolution) -> Self {
        Self {
            hostname: r.hostname,
            port: r.port,
            username: r.username,
            key_path: r.key_path,
            missing: r.missing,
            errors: r.errors,
        }
    }
}

pub(super) fn view(store: &ConfigStore, host_id: &str) -> Res<ResolvedView> {
    let config = store.snapshot()?;
    Ok(locate(&config, host_id)?.resolution().into())
}
