use serde::Deserialize;

use super::model::{
    AuthMethod, ConfigFile, Environment, Host, KeyEntry, Node, Project, Template, Variable,
};

/// The version 2 shape, read only to migrate it: hosts lived inside their project.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2File {
    #[serde(default)]
    variables: Vec<Variable>,
    #[serde(default)]
    projects: Vec<V2Project>,
    #[serde(default)]
    keys: Vec<KeyEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2Project {
    id: String,
    name: String,
    #[serde(default)]
    variables: Vec<Variable>,
    #[serde(default)]
    environments: Vec<Environment>,
    #[serde(default)]
    hosts: Vec<V2Host>,
    #[serde(default)]
    active_environment_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2Host {
    id: String,
    name: String,
    hostname: Template,
    port: Template,
    username: Template,
    auth: AuthMethod,
}

/// Every project host becomes a host node at the root of its project; ids are kept, so
/// keychain accounts stay valid.
pub(super) fn from_v2(raw: &[u8], version: u32) -> Result<ConfigFile, serde_json::Error> {
    let v2: V2File = serde_json::from_slice(raw)?;
    let mut nodes = Vec::new();
    let projects = v2
        .projects
        .into_iter()
        .map(|p| {
            // v2 cleared it on delete; a dangling one (hand edit) must not block the migration.
            let active_environment_id = p
                .active_environment_id
                .filter(|id| p.environments.iter().any(|e| &e.id == id));
            nodes.extend(p.hosts.into_iter().map(|h| {
                Node::Host(Host {
                    id: h.id,
                    name: h.name,
                    project_id: Some(p.id.clone()),
                    parent_id: None,
                    hostname: h.hostname,
                    port: h.port,
                    username: h.username,
                    auth: h.auth,
                })
            }));
            Project {
                id: p.id,
                name: p.name,
                variables: p.variables,
                environments: p.environments,
                active_environment_id,
            }
        })
        .collect();
    Ok(ConfigFile {
        version,
        variables: v2.variables,
        projects,
        nodes,
        keys: v2.keys,
    })
}
