use std::collections::{HashMap, HashSet};

use super::super::model::{Collection, ConfigFile, Host, HostInput, Node};
use super::super::validate::{self, MAX_DEPTH, MAX_NODES, collection_chain, same_name};
use super::{ConfigError, ConfigStore, new_id};

/// What a collection delete took out of the config, for keychain cleanup and closing
/// connections. `environments` are those of the scope's project (empty for Home).
#[derive(Debug, Clone, PartialEq)]
pub struct Removed {
    pub collections: Vec<Collection>,
    pub hosts: Vec<Host>,
    pub environments: Vec<String>,
}

/// `nodes` is the moved node and its subtree, after the move. When the scope changed,
/// `old_environments` are the environments of the previous project (empty for Home).
#[derive(Debug, Clone, PartialEq)]
pub struct Moved {
    pub nodes: Vec<Node>,
    pub scope_changed: bool,
    pub old_environments: Vec<String>,
}

impl Moved {
    pub fn host_ids(&self) -> Vec<String> {
        self.nodes
            .iter()
            .filter_map(Node::as_host)
            .map(|h| h.id.clone())
            .collect()
    }
}

fn by_id(cfg: &ConfigFile) -> HashMap<&str, &Node> {
    cfg.nodes.iter().map(|n| (n.id(), n)).collect()
}

fn environments_of(cfg: &ConfigFile, project_id: Option<&str>) -> Vec<String> {
    project_id
        .and_then(|p| cfg.project(p))
        .map(|p| p.environments.iter().map(|e| e.id.clone()).collect())
        .unwrap_or_default()
}

fn scope_label(cfg: &ConfigFile, project_id: Option<&str>) -> String {
    project_id
        .and_then(|p| cfg.project(p))
        .map_or_else(|| "Home".to_string(), |p| p.name.clone())
}

/// Checks that `parent_id` can hold nodes of `project_id`; returns how many collections deep
/// that location is.
fn location_depth(
    cfg: &ConfigFile,
    project_id: Option<&str>,
    parent_id: Option<&str>,
) -> Result<usize, ConfigError> {
    if let Some(p) = project_id
        && cfg.project(p).is_none()
    {
        return Err(ConfigError::NotFound("project"));
    }
    let Some(parent) = parent_id else {
        return Ok(0);
    };
    let node = cfg
        .node(parent)
        .ok_or(ConfigError::NotFound("collection"))?;
    if !node.is_collection() {
        return Err(ConfigError::InvalidInput(
            "the parent must be a collection".into(),
        ));
    }
    if node.project_id() != project_id {
        return Err(ConfigError::InvalidInput(
            "the parent collection belongs to another scope".into(),
        ));
    }
    collection_chain(&by_id(cfg), Some(parent))
        .map(|c| c.len())
        .ok_or(ConfigError::Corrupt)
}

fn too_deep() -> ConfigError {
    ConfigError::InvalidInput(format!(
        "collections can be nested {MAX_DEPTH} levels deep at most"
    ))
}

fn check_room(cfg: &ConfigFile) -> Result<(), ConfigError> {
    if cfg.nodes.len() >= MAX_NODES {
        return Err(ConfigError::InvalidInput(format!(
            "the configuration holds at most {MAX_NODES} hosts and collections"
        )));
    }
    Ok(())
}

fn collection_taken(
    cfg: &ConfigFile,
    project_id: Option<&str>,
    parent_id: Option<&str>,
    name: &str,
    except: Option<&str>,
) -> bool {
    cfg.nodes.iter().any(|n| {
        n.is_collection()
            && Some(n.id()) != except
            && n.project_id() == project_id
            && n.parent_id() == parent_id
            && same_name(n.name(), name)
    })
}

/// Host names are unique in the whole scope, at any depth.
fn host_taken<'a>(
    cfg: &'a ConfigFile,
    project_id: Option<&str>,
    name: &str,
    except: &dyn Fn(&str) -> bool,
) -> Option<&'a Host> {
    cfg.nodes.iter().filter_map(Node::as_host).find(|h| {
        h.project_id.as_deref() == project_id && !except(&h.id) && same_name(&h.name, name)
    })
}

fn collection_mut<'a>(
    cfg: &'a mut ConfigFile,
    id: &str,
) -> Result<&'a mut Collection, ConfigError> {
    cfg.nodes
        .iter_mut()
        .find_map(|n| match n {
            Node::Collection(c) if c.id == id => Some(c),
            _ => None,
        })
        .ok_or(ConfigError::NotFound("collection"))
}

fn host_mut<'a>(cfg: &'a mut ConfigFile, id: &str) -> Result<&'a mut Host, ConfigError> {
    cfg.nodes
        .iter_mut()
        .find_map(|n| match n {
            Node::Host(h) if h.id == id => Some(h),
            _ => None,
        })
        .ok_or(ConfigError::NotFound("host"))
}

/// Applies the move to `cfg`; the bool is false for a move to the current location.
fn apply_move(
    cfg: &mut ConfigFile,
    node_id: &str,
    project_id: Option<&str>,
    parent_id: Option<&str>,
) -> Result<(Moved, bool), ConfigError> {
    let node = cfg
        .node(node_id)
        .ok_or(ConfigError::NotFound("node"))?
        .clone();
    let depth = location_depth(cfg, project_id, parent_id)?;
    let subtree: Vec<Node> = cfg.subtree(node_id).into_iter().cloned().collect();
    if node.project_id() == project_id && node.parent_id() == parent_id {
        let moved = Moved {
            nodes: subtree,
            scope_changed: false,
            old_environments: Vec::new(),
        };
        return Ok((moved, false));
    }
    let ids: HashSet<&str> = subtree.iter().map(Node::id).collect();
    let map = by_id(cfg);
    let target_chain = collection_chain(&map, parent_id).ok_or(ConfigError::Corrupt)?;
    if target_chain.iter().any(|c| c.id() == node_id) {
        return Err(ConfigError::InvalidInput(
            "a collection cannot be moved into itself or one of its collections".into(),
        ));
    }
    let height = subtree
        .iter()
        .filter(|n| n.is_collection())
        .filter_map(|n| collection_chain(&map, Some(n.id())))
        .filter_map(|chain| chain.iter().position(|c| c.id() == node_id).map(|i| i + 1))
        .max()
        .unwrap_or(0);
    if depth + height > MAX_DEPTH {
        return Err(too_deep());
    }
    if let Node::Collection(c) = &node
        && collection_taken(cfg, project_id, parent_id, &c.name, Some(node_id))
    {
        let target = match parent_id.and_then(|p| map.get(p)) {
            Some(parent) => parent.name().to_string(),
            None => scope_label(cfg, project_id),
        };
        return Err(ConfigError::NameTaken(format!(
            "a collection named \"{}\" already exists in {target}",
            c.name
        )));
    }
    let scope_changed = node.project_id() != project_id;
    if scope_changed {
        for h in subtree.iter().filter_map(Node::as_host) {
            if host_taken(cfg, project_id, &h.name, &|id| ids.contains(id)).is_some() {
                return Err(ConfigError::NameTaken(format!(
                    "a host named \"{}\" already exists in {}",
                    h.name,
                    scope_label(cfg, project_id)
                )));
            }
        }
    }
    let old_environments = if scope_changed {
        environments_of(cfg, node.project_id())
    } else {
        Vec::new()
    };
    let ids: HashSet<String> = ids.into_iter().map(str::to_owned).collect();
    let target_project = project_id.map(str::to_owned);
    for n in &mut cfg.nodes {
        if n.id() == node_id {
            n.set_location(target_project.clone(), parent_id.map(str::to_owned));
        } else if ids.contains(n.id()) {
            let parent = n.parent_id().map(str::to_owned);
            n.set_location(target_project.clone(), parent);
        }
    }
    let nodes = cfg.subtree(node_id).into_iter().cloned().collect();
    let moved = Moved {
        nodes,
        scope_changed,
        old_environments,
    };
    Ok((moved, true))
}

impl ConfigStore {
    pub fn create_collection(
        &self,
        project_id: Option<&str>,
        parent_id: Option<&str>,
        name: &str,
    ) -> Result<Collection, ConfigError> {
        let name = validate::name(name)?;
        self.mutate(|cfg| {
            let depth = location_depth(cfg, project_id, parent_id)?;
            if depth + 1 > MAX_DEPTH {
                return Err(too_deep());
            }
            check_room(cfg)?;
            if collection_taken(cfg, project_id, parent_id, &name, None) {
                return Err(ConfigError::Conflict("collection"));
            }
            let c = Collection {
                id: new_id(),
                name,
                project_id: project_id.map(str::to_owned),
                parent_id: parent_id.map(str::to_owned),
            };
            cfg.nodes.push(Node::Collection(c.clone()));
            Ok(c)
        })
    }

    /// Renaming to the exact current name changes nothing and does not rewrite the file.
    pub fn rename_collection(
        &self,
        collection_id: &str,
        name: &str,
    ) -> Result<Collection, ConfigError> {
        let name = validate::name(name)?;
        self.transact(|cfg| {
            let c = collection_mut(cfg, collection_id)?.clone();
            if c.name == name {
                return Ok((c, false));
            }
            if collection_taken(
                cfg,
                c.project_id.as_deref(),
                c.parent_id.as_deref(),
                &name,
                Some(collection_id),
            ) {
                return Err(ConfigError::Conflict("collection"));
            }
            let c = collection_mut(cfg, collection_id)?;
            c.name = name;
            Ok((c.clone(), true))
        })
    }

    /// Removes the collection and everything below it.
    pub fn delete_collection(&self, collection_id: &str) -> Result<Removed, ConfigError> {
        self.mutate(|cfg| {
            let c = collection_mut(cfg, collection_id)?.clone();
            let ids: HashSet<String> = cfg
                .subtree(collection_id)
                .into_iter()
                .map(|n| n.id().to_owned())
                .collect();
            let environments = environments_of(cfg, c.project_id.as_deref());
            let (gone, kept): (Vec<Node>, Vec<Node>) = std::mem::take(&mut cfg.nodes)
                .into_iter()
                .partition(|n| ids.contains(n.id()));
            cfg.nodes = kept;
            let mut removed = Removed {
                collections: Vec::new(),
                hosts: Vec::new(),
                environments,
            };
            for n in gone {
                match n {
                    Node::Collection(c) => removed.collections.push(c),
                    Node::Host(h) => removed.hosts.push(h),
                }
            }
            Ok(removed)
        })
    }

    pub fn create_host(
        &self,
        project_id: Option<&str>,
        parent_id: Option<&str>,
        input: &HostInput,
    ) -> Result<Host, ConfigError> {
        let v = validate::host(input)?;
        self.mutate(|cfg| {
            location_depth(cfg, project_id, parent_id)?;
            check_room(cfg)?;
            if host_taken(cfg, project_id, &v.name, &|_| false).is_some() {
                return Err(ConfigError::Conflict("host"));
            }
            let host = Host {
                id: new_id(),
                name: v.name,
                project_id: project_id.map(str::to_owned),
                parent_id: parent_id.map(str::to_owned),
                hostname: v.hostname,
                port: v.port,
                username: v.username,
                auth: v.auth,
            };
            cfg.nodes.push(Node::Host(host.clone()));
            Ok(host)
        })
    }

    pub fn update_host(&self, host_id: &str, input: &HostInput) -> Result<Host, ConfigError> {
        let v = validate::host(input)?;
        self.mutate(|cfg| {
            let scope = host_mut(cfg, host_id)?.project_id.clone();
            if host_taken(cfg, scope.as_deref(), &v.name, &|id| id == host_id).is_some() {
                return Err(ConfigError::Conflict("host"));
            }
            let host = host_mut(cfg, host_id)?;
            host.name = v.name;
            host.hostname = v.hostname;
            host.port = v.port;
            host.username = v.username;
            host.auth = v.auth;
            Ok(host.clone())
        })
    }

    /// Returns the removed host and the environment ids of its project at that moment.
    pub fn delete_host(&self, host_id: &str) -> Result<(Host, Vec<String>), ConfigError> {
        self.mutate(|cfg| {
            let i = cfg
                .nodes
                .iter()
                .position(|n| n.as_host().is_some_and(|h| h.id == host_id))
                .ok_or(ConfigError::NotFound("host"))?;
            let Node::Host(h) = cfg.nodes.remove(i) else {
                return Err(ConfigError::NotFound("host"));
            };
            let envs = environments_of(cfg, h.project_id.as_deref());
            Ok((h, envs))
        })
    }

    /// Validates a move without saving it.
    pub fn plan_move(
        &self,
        node_id: &str,
        project_id: Option<&str>,
        parent_id: Option<&str>,
    ) -> Result<Moved, ConfigError> {
        let _guard = self.guard()?;
        let mut cfg = self.load()?;
        apply_move(&mut cfg, node_id, project_id, parent_id).map(|(m, _)| m)
    }

    /// Moves a node with its subtree. `before_save` runs under the store lock once the move is
    /// known to be valid and only if something changes; the file is written after it returns.
    pub fn move_node(
        &self,
        node_id: &str,
        project_id: Option<&str>,
        parent_id: Option<&str>,
        before_save: impl FnOnce(&Moved),
    ) -> Result<Moved, ConfigError> {
        let _guard = self.guard()?;
        let mut cfg = self.load()?;
        let (moved, changed) = apply_move(&mut cfg, node_id, project_id, parent_id)?;
        if changed {
            validate::structure(&cfg).map_err(ConfigError::InvalidInput)?;
            before_save(&moved);
            self.save(&cfg)?;
        }
        Ok(moved)
    }
}

#[cfg(test)]
mod tests;
