use serde::Serialize;

use super::error::CommandError;
use crate::config::{ConfigFile, ConfigStore, Environment, Host, Project};
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
    pub environment: Option<&'a Environment>,
}

impl Located<'_> {
    pub fn resolution(&self) -> Resolution {
        resolve_host(
            self.host,
            Layers::of(self.config, self.project, self.environment),
        )
    }
}

/// The environment a host of `project` (None: Home) may use: none for a Home host, one of
/// its project's otherwise. An id that exists in no project is `not_found`.
pub(super) fn scope_environment<'a>(
    config: &ConfigFile,
    project: Option<&'a Project>,
    environment_id: Option<&str>,
) -> Res<Option<&'a Environment>> {
    let Some(id) = environment_id else {
        return Ok(None);
    };
    required("environmentId", id)?;
    let Some(project) = project else {
        return Err(CommandError::new(
            "invalid_input",
            "a host outside a project has no environment",
        ));
    };
    if let Some(e) = project.environment(id) {
        return Ok(Some(e));
    }
    if config.projects.iter().any(|p| p.environment(id).is_some()) {
        return Err(CommandError::new(
            "invalid_input",
            "the environment belongs to another project",
        ));
    }
    Err(not_found("environment"))
}

/// Finds the host by id and derives its scope from the host itself.
pub(super) fn locate<'a>(
    config: &'a ConfigFile,
    host_id: &str,
    environment_id: Option<&str>,
) -> Res<Located<'a>> {
    required("hostId", host_id)?;
    let host = config.host(host_id).ok_or_else(|| not_found("host"))?;
    let project = match host.project_id.as_deref() {
        Some(id) => Some(config.project(id).ok_or_else(|| not_found("project"))?),
        None => None,
    };
    let environment = scope_environment(config, project, environment_id)?;
    Ok(Located {
        config,
        project,
        host,
        environment,
    })
}

pub(super) fn var_key(level: &Level, name: &str) -> Result<VarKey, SecretError> {
    match level {
        Level::Global => VarKey::global(name),
        Level::Project(id) => VarKey::project(id, name),
        Level::Environment(id) => VarKey::environment(id, name),
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

/// Resolves the host for `environment_id` (None: no environment layer) into a connect target.
/// Fails with `missing_variables` or `invalid_input` before any network call.
pub(super) fn target(
    store: &ConfigStore,
    host_id: &str,
    environment_id: Option<&str>,
) -> Res<Target> {
    let config = store.snapshot()?;
    let at = locate(&config, host_id, environment_id)?;
    let resolved = at.resolution().complete()?;
    let env_id = at.environment.map(|e| e.id.as_str());
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
        connection_id: Target::connection_id_of(&at.host.id, env_id),
        host_id: at.host.id.clone(),
        project_id: at.host.project_id.clone(),
        environment_id: env_id.map(str::to_owned),
        saved: SavedKey::new(&at.host.id, env_id)?,
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

pub(super) fn view(
    store: &ConfigStore,
    host_id: &str,
    environment_id: Option<&str>,
) -> Res<ResolvedView> {
    let config = store.snapshot()?;
    Ok(locate(&config, host_id, environment_id)?
        .resolution()
        .into())
}
