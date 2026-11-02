use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::error::CommandError;
use super::resolve::{self, ResolvedView, required};
use super::secrets::{check_secret, forget_legacy, forget_saved, forget_variables, secret_keys};
use crate::config::{
    ConfigStore, Environment, Host, HostInput, Project, Variable, VariableKind, VariableScope,
};
use crate::secrets::{SecretError, SecretStore, VarKey, fits_keychain};

type Res<T> = Result<T, CommandError>;

/// `value` is null for a secret; `hasValue` tells whether the keychain holds one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableView {
    pub name: String,
    pub kind: VariableKind,
    pub value: Option<String>,
    pub has_value: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentView {
    pub id: String,
    pub name: String,
    pub variables: Vec<VariableView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub variables: Vec<VariableView>,
    pub environments: Vec<EnvironmentView>,
    pub hosts: Vec<Host>,
    pub active_environment_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub variables: Vec<VariableView>,
    pub projects: Vec<ProjectView>,
}

/// `secretValue` sets a secret's value; null or absent keeps the stored one (by exact name).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableInput {
    pub name: String,
    pub kind: VariableKind,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub secret_value: Option<SecretString>,
}

fn views(
    secrets: &SecretStore,
    variables: &[Variable],
    key: impl Fn(&str) -> Result<VarKey, SecretError>,
) -> Vec<VariableView> {
    variables
        .iter()
        .map(|v| {
            let has_value = match v.kind {
                VariableKind::Plain => true,
                VariableKind::Secret => key(&v.name)
                    .and_then(|k| secrets.has_var(&k))
                    .unwrap_or_else(|_| {
                        log::warn!("could not check a secret variable in the keychain");
                        false
                    }),
            };
            VariableView {
                name: v.name.clone(),
                kind: v.kind,
                value: v.value.clone(),
                has_value,
            }
        })
        .collect()
}

fn env_view(secrets: &SecretStore, e: &Environment) -> EnvironmentView {
    EnvironmentView {
        id: e.id.clone(),
        name: e.name.clone(),
        variables: views(secrets, &e.variables, |n| VarKey::environment(&e.id, n)),
    }
}

fn project_view(secrets: &SecretStore, p: &Project) -> ProjectView {
    ProjectView {
        id: p.id.clone(),
        name: p.name.clone(),
        variables: views(secrets, &p.variables, |n| VarKey::project(&p.id, n)),
        environments: p
            .environments
            .iter()
            .map(|e| env_view(secrets, e))
            .collect(),
        hosts: p.hosts.clone(),
        active_environment_id: p.active_environment_id.clone(),
    }
}

fn config_view(store: &ConfigStore, secrets: &SecretStore) -> Res<ConfigView> {
    let cfg = store.snapshot()?;
    Ok(ConfigView {
        variables: views(secrets, &cfg.variables, VarKey::global),
        projects: cfg
            .projects
            .iter()
            .map(|p| project_view(secrets, p))
            .collect(),
    })
}

fn scope_key(scope: &VariableScope, name: &str) -> Result<VarKey, SecretError> {
    match scope {
        VariableScope::Global => VarKey::global(name),
        VariableScope::Project { project_id } => VarKey::project(project_id, name),
        VariableScope::Environment { environment_id, .. } => {
            VarKey::environment(environment_id, name)
        }
    }
}

fn scope_id(scope: &VariableScope) -> &str {
    match scope {
        VariableScope::Global => "global",
        VariableScope::Project { project_id } => project_id,
        VariableScope::Environment { environment_id, .. } => environment_id,
    }
}

fn is_secret_named(list: &[Variable], name: &str) -> bool {
    list.iter()
        .any(|v| v.kind == VariableKind::Secret && v.name == name)
}

/// Saves the config first, then deletes the keychain values that no longer belong to a secret
/// of that name, then stores the new values. Deleting first matters where account names are
/// case-insensitive (Windows): a case-only rename would otherwise delete the value just set.
fn save_variables(
    store: &ConfigStore,
    secrets: &SecretStore,
    scope: &VariableScope,
    inputs: Vec<VariableInput>,
) -> Res<Vec<VariableView>> {
    let mut values = Vec::new();
    let mut list = Vec::with_capacity(inputs.len());
    for input in inputs {
        // Names are quoted in the messages below, so they are checked first.
        if !crate::vars::is_valid_name(&input.name) {
            return Err(CommandError::new(
                "invalid_input",
                "variable names start with a letter or '_' and contain only letters, digits, '_', '.' and '-' (64 characters at most)",
            ));
        }
        match (input.kind, input.secret_value) {
            (VariableKind::Plain, Some(_)) => {
                return Err(CommandError::new(
                    "invalid_input",
                    format!("plain variable {} cannot take a secret value", input.name),
                ));
            }
            (VariableKind::Secret, Some(value)) => {
                check_secret(&value)?;
                if !fits_keychain(&value) {
                    return Err(CommandError::new(
                        "invalid_input",
                        format!(
                            "the value of {} is too long for the system keychain",
                            input.name
                        ),
                    ));
                }
                values.push((input.name.clone(), value));
            }
            _ => {}
        }
        list.push(Variable {
            name: input.name,
            kind: input.kind,
            value: input.value,
        });
    }
    let given_names: Vec<String> = values.iter().map(|(n, _)| n.clone()).collect();
    // Validated before saving, so a scope id that cannot hold keychain entries changes nothing.
    let keyed: Vec<(VarKey, SecretString)> = values
        .into_iter()
        .map(|(name, v)| scope_key(scope, &name).map(|k| (k, v)))
        .collect::<Result<_, _>>()?;
    let _lifecycle = secrets.lifecycle();
    let (old, new) = store.set_variables(scope, &list)?;

    let mut stale: Vec<VarKey> = Vec::new();
    for v in old.iter().chain(new.iter()) {
        let (was, is) = (
            is_secret_named(&old, &v.name),
            is_secret_named(&new, &v.name),
        );
        let given = given_names.contains(&v.name);
        // Removed, made plain or renamed; or a new secret without value whose account may
        // still hold a leftover from a failed cleanup.
        if (was || is)
            && !(was && is)
            && !given
            && let Ok(key) = scope_key(scope, &v.name)
            && !stale.contains(&key)
        {
            stale.push(key);
        }
    }
    forget_variables(secrets, scope_id(scope), &stale);
    for (key, value) in &keyed {
        secrets.set_var(key, value)?;
    }
    Ok(views(secrets, &new, |n| scope_key(scope, n)))
}

fn remove_project(store: &ConfigStore, secrets: &SecretStore, project_id: &str) -> Res<()> {
    required("projectId", project_id)?;
    let _lifecycle = secrets.lifecycle();
    let p = store.delete_project(project_id)?;
    forget_variables(
        secrets,
        &p.id,
        &secret_keys(&p.variables, |n| VarKey::project(&p.id, n).ok()),
    );
    for e in &p.environments {
        forget_variables(
            secrets,
            &e.id,
            &secret_keys(&e.variables, |n| VarKey::environment(&e.id, n).ok()),
        );
    }
    let envs: Vec<Option<&str>> = std::iter::once(None)
        .chain(p.environments.iter().map(|e| Some(e.id.as_str())))
        .collect();
    for h in &p.hosts {
        forget_saved(secrets, &h.id, &envs);
    }
    Ok(())
}

fn remove_environment(
    store: &ConfigStore,
    secrets: &SecretStore,
    project_id: &str,
    environment_id: &str,
) -> Res<()> {
    required("projectId", project_id)?;
    required("environmentId", environment_id)?;
    let _lifecycle = secrets.lifecycle();
    let (e, hosts) = store.delete_environment(project_id, environment_id)?;
    forget_variables(
        secrets,
        &e.id,
        &secret_keys(&e.variables, |n| VarKey::environment(&e.id, n).ok()),
    );
    for h in &hosts {
        forget_saved(secrets, h, &[Some(&e.id)]);
    }
    Ok(())
}

fn remove_host(
    store: &ConfigStore,
    secrets: &SecretStore,
    project_id: &str,
    host_id: &str,
) -> Res<()> {
    required("projectId", project_id)?;
    required("hostId", host_id)?;
    let _lifecycle = secrets.lifecycle();
    let (h, envs) = store.delete_host(project_id, host_id)?;
    let envs: Vec<Option<&str>> = std::iter::once(None)
        .chain(envs.iter().map(|e| Some(e.as_str())))
        .collect();
    forget_saved(secrets, &h.id, &envs);
    Ok(())
}

#[tauri::command]
pub async fn get_config(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
) -> Res<ConfigView> {
    let view = config_view(&store, &secrets);
    forget_legacy(&store, &secrets);
    view
}

#[tauri::command]
pub async fn create_project(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    name: String,
) -> Res<ProjectView> {
    Ok(project_view(&secrets, &store.create_project(&name)?))
}

#[tauri::command]
pub async fn rename_project(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    name: String,
) -> Res<ProjectView> {
    Ok(project_view(
        &secrets,
        &store.rename_project(&project_id, &name)?,
    ))
}

#[tauri::command]
pub async fn delete_project(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
) -> Res<()> {
    remove_project(&store, &secrets, &project_id)
}

#[tauri::command]
pub async fn create_environment(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    name: String,
) -> Res<EnvironmentView> {
    Ok(env_view(
        &secrets,
        &store.create_environment(&project_id, &name)?,
    ))
}

#[tauri::command]
pub async fn rename_environment(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    environment_id: String,
    name: String,
) -> Res<EnvironmentView> {
    Ok(env_view(
        &secrets,
        &store.rename_environment(&project_id, &environment_id, &name)?,
    ))
}

#[tauri::command]
pub async fn delete_environment(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    environment_id: String,
) -> Res<()> {
    remove_environment(&store, &secrets, &project_id, &environment_id)
}

#[tauri::command]
pub async fn set_active_environment(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    environment_id: Option<String>,
) -> Res<ProjectView> {
    Ok(project_view(
        &secrets,
        &store.set_active_environment(&project_id, environment_id.as_deref())?,
    ))
}

#[tauri::command]
pub async fn set_variables(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    scope: VariableScope,
    variables: Vec<VariableInput>,
) -> Res<Vec<VariableView>> {
    save_variables(&store, &secrets, &scope, variables)
}

#[tauri::command]
pub async fn create_host(
    store: State<'_, ConfigStore>,
    project_id: String,
    host: HostInput,
) -> Res<Host> {
    Ok(store.create_host(&project_id, &host)?)
}

/// Saved connection secrets are bound to their resolved target, so an edit that changes the
/// endpoint or key path invalidates them without explicit cleanup.
#[tauri::command]
pub async fn update_host(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    host_id: String,
    host: HostInput,
) -> Res<Host> {
    let _lifecycle = secrets.lifecycle();
    Ok(store.update_host(&project_id, &host_id, &host)?)
}

#[tauri::command]
pub async fn delete_host(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    project_id: String,
    host_id: String,
) -> Res<()> {
    remove_host(&store, &secrets, &project_id, &host_id)
}

#[tauri::command]
pub async fn resolve_host(
    store: State<'_, ConfigStore>,
    project_id: String,
    host_id: String,
    environment_id: Option<String>,
) -> Res<ResolvedView> {
    resolve::view(&store, &project_id, &host_id, environment_id.as_deref())
}

#[cfg(test)]
mod tests;
