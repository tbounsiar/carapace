use serde::Serialize;

use super::error::CommandError;
use crate::config::{ConfigFile, ConfigStore, Host, HostInput, Project};
use crate::secrets::{KeyPassKey, SavedKey, SecretError, VarKey};
use crate::ssh::{RegisteredKey, Target, TargetAuth};
use crate::text::Text;
use crate::vars::{Layers, Level, Resolution, ResolvedAuth, ResolvedHost, SecretRef, resolve_host};

type Res<T> = Result<T, CommandError>;

pub(super) fn required(name: &str, value: &str) -> Res<()> {
    if value.trim().is_empty() {
        return Err(CommandError::new(
            "invalid_input",
            crate::text!("errors.config.required", "{name} is required", name = name),
        ));
    }
    Ok(())
}

/// `what` is a code: "host" or "project".
fn not_found(what: &'static str) -> CommandError {
    crate::config::ConfigError::NotFound(what).into()
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
    build(
        &config,
        resolved,
        &at.host.id,
        at.host.project_id.clone(),
        Some(SavedKey::new(&at.host.id)?),
    )
}

/// Resolves an unsaved host form in the scope `project_id` (None: Home), with the same rules
/// as a saved host. Only with `host_id` (a host of that same scope) is its saved connection
/// secret a candidate.
pub(super) fn draft_target(
    store: &ConfigStore,
    draft: &HostInput,
    project_id: Option<&str>,
    host_id: Option<&str>,
) -> Res<Target> {
    let valid = crate::config::validate::host(draft)?;
    let config = store.snapshot()?;
    let project = match project_id {
        Some(id) => Some(config.project(id).ok_or_else(|| not_found("project"))?),
        None => None,
    };
    let saved = match host_id {
        Some(id) => {
            let host = config.host(id).ok_or_else(|| not_found("host"))?;
            if host.project_id.as_deref() != project_id {
                let message = if project_id.is_some() {
                    crate::text!(
                        "errors.config.hostNotInProject",
                        "the host does not belong to this project"
                    )
                } else {
                    crate::text!(
                        "errors.config.hostNotInHome",
                        "the host does not belong to Home"
                    )
                };
                return Err(CommandError::new("invalid_input", message));
            }
            Some(SavedKey::new(id)?)
        }
        None => None,
    };
    let host = Host {
        id: host_id.unwrap_or_default().to_owned(),
        name: valid.name,
        project_id: project_id.map(str::to_owned),
        parent_id: None,
        hostname: valid.hostname,
        port: valid.port,
        username: valid.username,
        auth: valid.auth,
    };
    let resolved = resolve_host(&host, Layers::of(&config, project)).complete()?;
    build(&config, resolved, &host.id, host.project_id.clone(), saved)
}

fn build(
    config: &ConfigFile,
    resolved: ResolvedHost,
    host_id: &str,
    project_id: Option<String>,
    saved: Option<SavedKey>,
) -> Res<Target> {
    let auth = match resolved.auth {
        ResolvedAuth::Agent => TargetAuth::Agent,
        ResolvedAuth::Password { password } => TargetAuth::Password {
            variable: secret_key(password)?,
        },
        ResolvedAuth::Key {
            key_path,
            passphrase,
        } => TargetAuth::Key {
            registered: registered_keys(config),
            key_path,
            passphrase: secret_key(passphrase)?,
        },
    };
    Ok(Target {
        connection_id: host_id.to_owned(),
        host_id: host_id.to_owned(),
        project_id,
        saved,
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
    pub errors: Vec<Text>,
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
