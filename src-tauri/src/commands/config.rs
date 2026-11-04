use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::analytics::auth_of;
use super::error::CommandError;
use super::resolve::{self, ResolvedView, required};
use super::secrets::{check_secret, forget_legacy, forget_saved, forget_variables, secret_keys};
use super::ssh::close_hosts;
use crate::analytics::{Analytics, Count, Event, Scope};
use crate::config::{
    ConfigStore, HostInput, Moved, Node, Project, Variable, VariableKind, VariableScope,
};
use crate::external::ExternalEdits;
use crate::secrets::{SecretError, SecretStore, VarKey, fits_keychain};
use crate::ssh::SshManager;

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
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub variables: Vec<VariableView>,
}

/// `nodes` serialize as `CollectionView` / `HostView`, discriminated by `kind`; they hold no
/// secret value (auth fields are null or a `${name}` reference).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub variables: Vec<VariableView>,
    pub projects: Vec<ProjectView>,
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedNodes {
    pub collection_ids: Vec<String>,
    pub host_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    pub nodes: Vec<Node>,
    pub scope_changed: bool,
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

fn project_view(secrets: &SecretStore, p: &Project) -> ProjectView {
    ProjectView {
        id: p.id.clone(),
        name: p.name.clone(),
        variables: views(secrets, &p.variables, |n| VarKey::project(&p.id, n)),
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
        nodes: cfg.nodes,
    })
}

/// A nullable id argument: null is fine, an empty string is not.
fn optional<'a>(name: &str, value: &'a Option<String>) -> Res<Option<&'a str>> {
    match value.as_deref() {
        Some(v) => required(name, v).map(|()| Some(v)),
        None => Ok(None),
    }
}

fn scope_key(scope: &VariableScope, name: &str) -> Result<VarKey, SecretError> {
    match scope {
        VariableScope::Global => VarKey::global(name),
        VariableScope::Project { project_id } => VarKey::project(project_id, name),
    }
}

fn scope_id(scope: &VariableScope) -> &str {
    match scope {
        VariableScope::Global => "global",
        VariableScope::Project { project_id } => project_id,
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

/// The config and keychain part of the delete; returns the removed host ids, whose connections
/// the caller closes once the locks are released.
fn remove_project(
    store: &ConfigStore,
    secrets: &SecretStore,
    project_id: &str,
) -> Res<Vec<String>> {
    required("projectId", project_id)?;
    let _lifecycle = secrets.lifecycle();
    let (p, hosts) = store.delete_project(project_id)?;
    forget_variables(
        secrets,
        &p.id,
        &secret_keys(&p.variables, |n| VarKey::project(&p.id, n).ok()),
    );
    for h in &hosts {
        forget_saved(secrets, &h.id);
    }
    Ok(hosts.into_iter().map(|h| h.id).collect())
}

fn remove_host(store: &ConfigStore, secrets: &SecretStore, host_id: &str) -> Res<Vec<String>> {
    required("hostId", host_id)?;
    let _lifecycle = secrets.lifecycle();
    let h = store.delete_host(host_id)?;
    forget_saved(secrets, &h.id);
    Ok(vec![h.id])
}

fn remove_collection(
    store: &ConfigStore,
    secrets: &SecretStore,
    collection_id: &str,
) -> Res<DeletedNodes> {
    required("collectionId", collection_id)?;
    let _lifecycle = secrets.lifecycle();
    let removed = store.delete_collection(collection_id)?;
    for h in &removed.hosts {
        forget_saved(secrets, &h.id);
    }
    Ok(DeletedNodes {
        collection_ids: removed.collections.into_iter().map(|c| c.id).collect(),
        host_ids: removed.hosts.into_iter().map(|h| h.id).collect(),
    })
}

/// A host keeps its saved connection secret account across scopes, so a cross-scope move deletes
/// them before the file is written; the new scope's variables may resolve to another target.
fn relocate(
    store: &ConfigStore,
    secrets: &SecretStore,
    node_id: &str,
    project_id: Option<&str>,
    parent_id: Option<&str>,
) -> Res<Moved> {
    let _lifecycle = secrets.lifecycle();
    Ok(store.move_node(node_id, project_id, parent_id, |m| {
        if m.scope_changed {
            for h in m.host_ids() {
                forget_saved(secrets, &h);
            }
        }
    })?)
}

/// Connections of the moved hosts are closed before the move (they were resolved with the old
/// scope's variables) and once more after it, for a connect that slipped in between.
async fn move_node_in(
    store: &ConfigStore,
    secrets: &SecretStore,
    ssh: &SshManager,
    node_id: &str,
    project_id: Option<&str>,
    parent_id: Option<&str>,
) -> Res<MoveResult> {
    required("nodeId", node_id)?;
    let plan = store.plan_move(node_id, project_id, parent_id)?;
    if plan.scope_changed {
        close_hosts(ssh, &plan.host_ids()).await;
    }
    let moved = relocate(store, secrets, node_id, project_id, parent_id)?;
    if moved.scope_changed {
        close_hosts(ssh, &moved.host_ids()).await;
    }
    Ok(MoveResult {
        nodes: moved.nodes,
        scope_changed: moved.scope_changed,
    })
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
    ssh: State<'_, SshManager>,
    edits: State<'_, ExternalEdits>,
    project_id: String,
) -> Res<()> {
    let hosts = remove_project(&store, &secrets, &project_id)?;
    close_hosts(&ssh, &hosts).await;
    edits.forget_hosts(&hosts);
    Ok(())
}

#[tauri::command]
pub async fn set_variables(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    analytics: State<'_, Analytics>,
    scope: VariableScope,
    variables: Vec<VariableInput>,
) -> Res<Vec<VariableView>> {
    set_variables_in(&store, &secrets, &analytics, &scope, variables)
}

pub(super) fn set_variables_in(
    store: &ConfigStore,
    secrets: &SecretStore,
    analytics: &Analytics,
    scope: &VariableScope,
    variables: Vec<VariableInput>,
) -> Res<Vec<VariableView>> {
    let saved = save_variables(store, secrets, scope, variables)?;
    analytics.record(Event::VariablesSaved {
        scope: match scope {
            VariableScope::Global => Scope::Global,
            VariableScope::Project { .. } => Scope::Project,
        },
        count: Count::of(saved.len()),
    });
    Ok(saved)
}

#[tauri::command]
pub async fn create_collection(
    store: State<'_, ConfigStore>,
    project_id: Option<String>,
    parent_id: Option<String>,
    name: String,
) -> Res<Node> {
    let project_id = optional("projectId", &project_id)?;
    let parent_id = optional("parentId", &parent_id)?;
    Ok(Node::Collection(
        store.create_collection(project_id, parent_id, &name)?,
    ))
}

#[tauri::command]
pub async fn rename_collection(
    store: State<'_, ConfigStore>,
    collection_id: String,
    name: String,
) -> Res<Node> {
    required("collectionId", &collection_id)?;
    Ok(Node::Collection(
        store.rename_collection(&collection_id, &name)?,
    ))
}

#[tauri::command]
pub async fn delete_collection(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    ssh: State<'_, SshManager>,
    edits: State<'_, ExternalEdits>,
    collection_id: String,
) -> Res<DeletedNodes> {
    let deleted = remove_collection(&store, &secrets, &collection_id)?;
    close_hosts(&ssh, &deleted.host_ids).await;
    edits.forget_hosts(&deleted.host_ids);
    Ok(deleted)
}

#[tauri::command]
pub async fn move_node(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    ssh: State<'_, SshManager>,
    node_id: String,
    project_id: Option<String>,
    parent_id: Option<String>,
) -> Res<MoveResult> {
    let project_id = optional("projectId", &project_id)?;
    let parent_id = optional("parentId", &parent_id)?;
    move_node_in(&store, &secrets, &ssh, &node_id, project_id, parent_id).await
}

#[tauri::command]
pub async fn create_host(
    store: State<'_, ConfigStore>,
    analytics: State<'_, Analytics>,
    project_id: Option<String>,
    parent_id: Option<String>,
    host: HostInput,
) -> Res<Node> {
    create_host_in(&store, &analytics, project_id, parent_id, &host)
}

pub(super) fn create_host_in(
    store: &ConfigStore,
    analytics: &Analytics,
    project_id: Option<String>,
    parent_id: Option<String>,
    host: &HostInput,
) -> Res<Node> {
    let project_id = optional("projectId", &project_id)?;
    let parent_id = optional("parentId", &parent_id)?;
    let created = store.create_host(project_id, parent_id, host)?;
    analytics.record(Event::HostCreated {
        auth: auth_of(&created.auth),
    });
    Ok(Node::Host(created))
}

/// Saved connection secrets are bound to their resolved target, so an edit that changes the
/// endpoint or key path invalidates them without explicit cleanup.
#[tauri::command]
pub async fn update_host(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    host_id: String,
    host: HostInput,
) -> Res<Node> {
    required("hostId", &host_id)?;
    let _lifecycle = secrets.lifecycle();
    Ok(Node::Host(store.update_host(&host_id, &host)?))
}

#[tauri::command]
pub async fn delete_host(
    store: State<'_, ConfigStore>,
    secrets: State<'_, SecretStore>,
    ssh: State<'_, SshManager>,
    edits: State<'_, ExternalEdits>,
    host_id: String,
) -> Res<()> {
    let hosts = remove_host(&store, &secrets, &host_id)?;
    close_hosts(&ssh, &hosts).await;
    edits.forget_hosts(&hosts);
    Ok(())
}

#[tauri::command]
pub async fn resolve_host(store: State<'_, ConfigStore>, host_id: String) -> Res<ResolvedView> {
    resolve::view(&store, &host_id)
}

#[cfg(test)]
mod tests;
