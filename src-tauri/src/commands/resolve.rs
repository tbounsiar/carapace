use serde::Serialize;

use super::error::CommandError;
use crate::config::{ConfigFile, ConfigStore, Environment, Host, Project};
use crate::secrets::{SavedKey, SecretError, VarKey};
use crate::ssh::{Target, TargetAuth};
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
    pub project: &'a Project,
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

pub(super) fn locate<'a>(
    config: &'a ConfigFile,
    project_id: &str,
    host_id: &str,
    environment_id: Option<&str>,
) -> Res<Located<'a>> {
    required("projectId", project_id)?;
    required("hostId", host_id)?;
    let project = config
        .project(project_id)
        .ok_or_else(|| not_found("project"))?;
    let host = project.host(host_id).ok_or_else(|| not_found("host"))?;
    let environment = match environment_id {
        Some(id) => Some(
            project
                .environment(id)
                .ok_or_else(|| not_found("environment"))?,
        ),
        None => None,
    };
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

/// Resolves the host for `environment_id` (None: no environment layer) into a connect target.
/// Fails with `missing_variables` or `invalid_input` before any network call.
pub(super) fn target(
    store: &ConfigStore,
    project_id: &str,
    host_id: &str,
    environment_id: Option<&str>,
) -> Res<Target> {
    let config = store.snapshot()?;
    let at = locate(&config, project_id, host_id, environment_id)?;
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
            key_path,
            passphrase: secret_key(passphrase)?,
        },
    };
    Ok(Target {
        connection_id: Target::connection_id_of(&at.host.id, env_id),
        host_id: at.host.id.clone(),
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
    project_id: &str,
    host_id: &str,
    environment_id: Option<&str>,
) -> Res<ResolvedView> {
    let config = store.snapshot()?;
    Ok(locate(&config, project_id, host_id, environment_id)?
        .resolution()
        .into())
}
