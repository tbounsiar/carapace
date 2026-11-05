use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::model::{
    AnalyticsSettings, AuthMethod, Category, CategoryChoice, CategoryChoices, ConfigFile, Consent,
    ExternalEditor, Host, KeyEntry, Node, Project, Template, Variable, VariableKind,
};
use super::settings::Settings;
use super::validate::{self, MAX_VARIABLES, is_canonical_id, same_name};
use crate::vars;

/// The catalogue version the single consent of the first release is mapped to. Fixed, not the
/// current version: a category changed after it must still be asked again.
pub(super) const V1_ANALYTICS_VERSION: u32 = 2;

/// The first release's `analytics: { consent, catalogueVersion }`, read only to migrate it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V1Analytics {
    consent: Consent,
    catalogue_version: u32,
}

/// The preferences a `config.json` held, read as leniently as that file did: a malformed
/// `analytics` or `externalEditor` is left out.
pub(super) fn legacy_preferences(raw: &[u8]) -> Settings {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(raw) else {
        return Settings::default();
    };
    Settings {
        analytics: value.get("analytics").and_then(analytics),
        external_editor: value
            .get("externalEditor")
            .and_then(|v| ExternalEditor::deserialize(v).ok()),
        ..Settings::default()
    }
}

/// `analytics` as stored in `config.json`. With `categories`, each category is read on its own
/// and anything that does not parse is unset; without it, the first release's single consent is
/// mapped: a refusal onto every category, a grant onto the three it covered. Any other shape is
/// unset, so a hand edit can never turn a category on.
pub(super) fn analytics(value: &serde_json::Value) -> Option<AnalyticsSettings> {
    let obj = value.as_object()?;
    if let Some(categories) = obj.get("categories") {
        let categories = categories.as_object()?;
        let mut out = CategoryChoices::default();
        for category in Category::ALL {
            if let Some(choice) = categories
                .get(category.name())
                .and_then(|v| CategoryChoice::deserialize(v).ok())
            {
                out.set(category, choice);
            }
        }
        return Some(AnalyticsSettings { categories: out });
    }
    let v1 = V1Analytics::deserialize(value).ok()?;
    let answer = |consent| CategoryChoice {
        consent,
        version: V1_ANALYTICS_VERSION,
    };
    let categories = match v1.consent {
        // The first release asked again below catalogue 1, so such a grant was never in effect.
        Consent::Granted if v1.catalogue_version >= 1 => {
            // That grant never covered crash reports: they are asked about.
            let mut c = CategoryChoices::all(answer(Consent::Granted));
            c.crashes = CategoryChoice::default();
            c
        }
        // A refusal is never turned into a question.
        Consent::Denied => CategoryChoices::all(answer(Consent::Denied)),
        _ => return None,
    };
    Some(AnalyticsSettings { categories })
}

/// The version 2 shape, read only to migrate it: hosts lived inside their project. Environments
/// are handled by `drop_environments`.
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
    hosts: Vec<V2Host>,
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

/// Bounds the best-effort cleanup a single file can cause.
pub(super) const MAX_LEGACY_ENVIRONMENTS: usize = 1000;
/// Bounds the keychain calls made before a migrated file is written; a file above it is
/// refused.
pub(super) const MAX_MIGRATION_CALLS: usize = 10_000;

/// What a version 2 file, or a version 3 file written before environments were removed, kept
/// about environments. Only read to flatten and drop them.
#[derive(Deserialize)]
struct EnvFile {
    #[serde(default)]
    projects: Vec<EnvProject>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvProject {
    id: String,
    #[serde(default)]
    environments: Vec<EnvEntry>,
    #[serde(default)]
    active_environment_id: Option<String>,
}

#[derive(Deserialize)]
struct EnvEntry {
    id: String,
    #[serde(default)]
    variables: Vec<Variable>,
}

/// Keychain work that must succeed before the migrated file is written, because it decides
/// what hosts resolve to. Every id is canonical and every name valid.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationPlan {
    pub projects: Vec<ProjectMove>,
}

impl MigrationPlan {
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty()
    }

    /// Keychain calls the plan makes: one per delete, a read and a set or delete per copy.
    pub fn calls(&self) -> usize {
        self.projects
            .iter()
            .map(|p| p.delete.len() + 2 * p.copy.len())
            .sum()
    }
}

/// For a project whose active environment was flattened. `delete`: project secrets replaced by
/// a plain variable of the environment, whose `var/project/{projectId}/{n}` goes. `copy`: the
/// environment's secrets; `var/env/{environmentId}/{n}` is copied to
/// `var/project/{projectId}/{n}`, or, without a value, that project account is deleted so a
/// leftover from an earlier failed cleanup cannot become the secret. Names match exactly
/// (`flatten` refuses case-only differences), so no two of these accounts alias.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectMove {
    pub project_id: String,
    pub environment_id: String,
    pub delete: Vec<String>,
    pub copy: Vec<String>,
}

/// Best-effort cleanup once the migrated file is written: these accounts are never read again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyProject {
    pub project_id: String,
    /// Hosts of the project, for `conn/{hostId}/{environmentId}/*`.
    pub host_ids: Vec<String>,
    pub environments: Vec<LegacyEnvironment>,
}

/// `var/env/{environmentId}/{name}` for each of `secret_variables`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyEnvironment {
    pub environment_id: String,
    pub secret_variables: Vec<String>,
}

#[derive(Debug, Default)]
pub(super) struct Dropped {
    pub plan: MigrationPlan,
    pub legacy: Vec<LegacyProject>,
}

/// Merges the active environment into the project layer so every host resolves as it did with
/// that environment selected: an environment variable replaces the project variable of the same
/// name or is added. A name differing only by case is refused: lookup is case-sensitive, so
/// renaming `PW` to `pw` would let `${PW}` fall through to another layer. Both the
/// environment's own list and the merged one must be valid.
fn flatten(project: &mut Project, env: &EnvEntry) -> Result<ProjectMove, ()> {
    let env_vars = validate::variables(&env.variables).map_err(|_| ())?;
    let mut merged = project.variables.clone();
    let mut delete = Vec::new();
    let mut copy = Vec::new();
    for v in env_vars {
        let replaced = match merged.iter().position(|o| same_name(&o.name, &v.name)) {
            Some(i) if merged[i].name != v.name => return Err(()),
            Some(i) => Some(std::mem::replace(&mut merged[i], v.clone())),
            None => {
                merged.push(v.clone());
                None
            }
        };
        if v.kind == VariableKind::Secret {
            copy.push(v.name);
        } else if let Some(old) = replaced.filter(|o| o.kind == VariableKind::Secret) {
            delete.push(old.name);
        }
    }
    project.variables = validate::variables(&merged).map_err(|_| ())?;
    Ok(ProjectMove {
        project_id: project.id.clone(),
        environment_id: env.id.clone(),
        delete,
        copy,
    })
}

/// Flattens the active environment of every project into `cfg`, which must already hold the
/// file's projects and host nodes and pass `validate::structure`. Fails (the file is refused)
/// when the environment fields do not parse; an environment id is not canonical, is used twice
/// or equals a project or node id; an active environment id names none of the project's own
/// environments (a version 2 file treats that as no active environment, as its writer did
/// after a delete); a flattened list is invalid; or the plan exceeds `MAX_MIGRATION_CALLS`.
pub(super) fn drop_environments(
    cfg: &mut ConfigFile,
    raw: &[u8],
    dangling_active_is_none: bool,
) -> Result<Dropped, ()> {
    let file: EnvFile = serde_json::from_slice(raw).map_err(|_| ())?;
    let mut ids: HashSet<String> = cfg.projects.iter().map(|p| p.id.clone()).collect();
    ids.extend(cfg.nodes.iter().map(|n| n.id().to_owned()));
    let mut hosts: HashMap<String, Vec<String>> = HashMap::new();
    for h in cfg.nodes.iter().filter_map(Node::as_host) {
        if let Some(p) = &h.project_id {
            hosts.entry(p.clone()).or_default().push(h.id.clone());
        }
    }
    let mut budget = MAX_LEGACY_ENVIRONMENTS;
    let mut over = 0usize;
    let mut out = Dropped::default();
    for ep in file.projects {
        for e in &ep.environments {
            if !is_canonical_id(&e.id) || !ids.insert(e.id.clone()) {
                return Err(());
            }
        }
        let project = cfg.projects.iter_mut().find(|p| p.id == ep.id).ok_or(())?;
        let active = match ep.active_environment_id.as_deref() {
            None => None,
            Some(a) => match ep.environments.iter().find(|e| e.id == a) {
                Some(e) => Some(e),
                None if dangling_active_is_none => None,
                None => return Err(()),
            },
        };
        if let Some(env) = active {
            let moved = flatten(project, env)?;
            if !moved.delete.is_empty() || !moved.copy.is_empty() {
                out.plan.projects.push(moved);
            }
        }
        let mut environments = Vec::new();
        for e in &ep.environments {
            if budget == 0 {
                over += 1;
                continue;
            }
            budget -= 1;
            environments.push(LegacyEnvironment {
                environment_id: e.id.clone(),
                secret_variables: e
                    .variables
                    .iter()
                    .filter(|v| v.kind == VariableKind::Secret && vars::is_valid_name(&v.name))
                    .take(MAX_VARIABLES)
                    .map(|v| v.name.clone())
                    .collect(),
            });
        }
        if !environments.is_empty() {
            out.legacy.push(LegacyProject {
                host_ids: hosts.remove(&ep.id).unwrap_or_default(),
                project_id: ep.id,
                environments,
            });
        }
    }
    if out.plan.calls() > MAX_MIGRATION_CALLS {
        return Err(());
    }
    if over > 0 {
        log::warn!(
            "environment cleanup cap hit: {over} environments beyond {MAX_LEGACY_ENVIRONMENTS} keep their keychain entries"
        );
    }
    Ok(out)
}
