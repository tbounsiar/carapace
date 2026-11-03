use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;

use super::migrate;
use super::model::{
    ConfigFile, Environment, Host, KeyEntry, Node, Project, Variable, VariableScope,
};
use super::validate::{self, same_name};

mod nodes;
pub use nodes::Moved;

const FILE_NAME: &str = "config.json";
const TMP_NAME: &str = "config.json.tmp";
const V1_BACKUP: &str = "config.json.v1.bak";
const V2_BACKUP: &str = "config.json.v2.bak";
const MAX_BACKUPS: usize = 1000;
/// Far above 5000 nodes and 200 variables per scope; a larger file is not ours.
pub(super) const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub(super) const VERSION: u32 = 3;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0} already exists")]
    Conflict(&'static str),
    /// A conflict whose message names the item and where it clashes.
    #[error("{0}")]
    NameTaken(String),
    #[error("{0} already exists")]
    Exists(&'static str),
    #[error("could not read or write the configuration file")]
    Io,
    #[error("the configuration file is unreadable or has an unsupported format")]
    Corrupt,
}

/// Each operation reloads the file, so a corrupt file is reported on every call and is never
/// overwritten. Reads take the lock too: loading may move a version 1 file aside.
#[derive(Debug)]
pub struct ConfigStore {
    dir: PathBuf,
    lock: Mutex<()>,
    legacy: Mutex<Vec<LegacyHost>>,
}

/// A host of a version 1 file that was moved aside; its keychain entries are cleaned up by
/// the command layer (`take_legacy_hosts`), since this module never touches the keychain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyHost {
    pub project_id: String,
    pub environment_id: String,
    pub host_id: String,
}

/// Lenient: anything that does not look like an id is skipped.
fn legacy_hosts(raw: &[u8]) -> Vec<LegacyHost> {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let list = |v: &serde_json::Value, key: &str| -> Vec<serde_json::Value> {
        v.get(key)
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default()
    };
    let id = |v: &serde_json::Value| v.get("id").and_then(|x| x.as_str()).map(str::to_owned);
    let mut out = Vec::new();
    for p in list(&v, "projects") {
        let Some(pid) = id(&p) else { continue };
        for e in list(&p, "environments") {
            let Some(eid) = id(&e) else { continue };
            for h in list(&e, "hosts") {
                if let Some(hid) = id(&h) {
                    out.push(LegacyHost {
                        project_id: pid.clone(),
                        environment_id: eid.clone(),
                        host_id: hid,
                    });
                }
            }
        }
    }
    out
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn project_mut<'a>(cfg: &'a mut ConfigFile, id: &str) -> Result<&'a mut Project, ConfigError> {
    cfg.projects
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or(ConfigError::NotFound("project"))
}

fn env_mut<'a>(p: &'a mut Project, id: &str) -> Result<&'a mut Environment, ConfigError> {
    p.environments
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or(ConfigError::NotFound("environment"))
}

fn key_mut<'a>(cfg: &'a mut ConfigFile, id: &str) -> Result<&'a mut KeyEntry, ConfigError> {
    cfg.keys
        .iter_mut()
        .find(|k| k.id == id)
        .ok_or(ConfigError::NotFound("key"))
}

fn key_name_taken(cfg: &ConfigFile, name: &str, except: Option<&str>) -> bool {
    cfg.keys
        .iter()
        .any(|k| Some(k.id.as_str()) != except && same_name(&k.name, name))
}

/// Paths are stored canonical; Windows paths compare case-insensitively.
fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        same_name(a, b)
    } else {
        a == b
    }
}

#[derive(Deserialize)]
struct Probe {
    version: u32,
}

impl ConfigStore {
    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }

    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
            legacy: Mutex::default(),
        }
    }

    /// Hosts of version 1 files moved aside since the last call.
    pub fn take_legacy_hosts(&self) -> Vec<LegacyHost> {
        self.legacy
            .lock()
            .map(|mut l| std::mem::take(&mut *l))
            .unwrap_or_default()
    }

    fn guard(&self) -> Result<MutexGuard<'_, ()>, ConfigError> {
        self.lock.lock().map_err(|_| ConfigError::Io)
    }

    /// Must be called with the lock held.
    fn load(&self) -> Result<ConfigFile, ConfigError> {
        let path = self.dir.join(FILE_NAME);
        let file = match fs::File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(ConfigFile::default()),
            Err(_) => return Err(ConfigError::Io),
        };
        let mut raw = Vec::new();
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut raw)
            .map_err(|_| ConfigError::Io)?;
        if raw.len() as u64 > MAX_FILE_BYTES {
            return Err(ConfigError::Corrupt);
        }
        let probe: Probe = serde_json::from_slice(&raw).map_err(|_| ConfigError::Corrupt)?;
        match probe.version {
            VERSION => {
                let cfg: ConfigFile =
                    serde_json::from_slice(&raw).map_err(|_| ConfigError::Corrupt)?;
                validate::structure(&cfg).map_err(|_| ConfigError::Corrupt)?;
                Ok(cfg)
            }
            2 => {
                let cfg = migrate::from_v2(&raw, VERSION).map_err(|_| ConfigError::Corrupt)?;
                validate::structure(&cfg).map_err(|_| ConfigError::Corrupt)?;
                self.back_up_v2(&raw)?;
                self.save(&cfg)?;
                log::info!("configuration migrated from version 2 to version 3");
                Ok(cfg)
            }
            1 => {
                let hosts = legacy_hosts(&raw);
                self.back_up_v1()?;
                if let Ok(mut l) = self.legacy.lock() {
                    l.extend(hosts);
                }
                Ok(ConfigFile::default())
            }
            _ => Err(ConfigError::Corrupt),
        }
    }

    /// Version 1 is not migrated: the file is moved aside (never overwritten) and the app
    /// starts empty.
    fn back_up_v1(&self) -> Result<(), ConfigError> {
        let target = std::iter::once(V1_BACKUP.to_string())
            .chain((2..=MAX_BACKUPS).map(|n| format!("config.json.v1.{n}.bak")))
            .map(|name| self.dir.join(name))
            .find(|p| !p.exists())
            .ok_or(ConfigError::Io)?;
        fs::rename(self.dir.join(FILE_NAME), target).map_err(|_| ConfigError::Io)?;
        log::info!("configuration version 1 moved aside; starting with an empty configuration");
        Ok(())
    }

    /// A byte-identical copy, created with `create_new` so an earlier backup is never replaced.
    fn back_up_v2(&self, raw: &[u8]) -> Result<(), ConfigError> {
        let names = std::iter::once(V2_BACKUP.to_string())
            .chain((2..=MAX_BACKUPS).map(|n| format!("config.json.v2.{n}.bak")));
        for name in names {
            let path = self.dir.join(name);
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            match options.open(&path) {
                Ok(mut f) => {
                    if f.write_all(raw).and_then(|()| f.sync_all()).is_err() {
                        drop(f);
                        let _ = fs::remove_file(&path);
                        return Err(ConfigError::Io);
                    }
                    return Ok(());
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(ConfigError::Io),
            }
        }
        Err(ConfigError::Io)
    }

    fn save(&self, cfg: &ConfigFile) -> Result<(), ConfigError> {
        let json = serde_json::to_vec_pretty(cfg).map_err(|_| ConfigError::Io)?;
        fs::create_dir_all(&self.dir).map_err(|_| ConfigError::Io)?;
        let tmp = self.dir.join(TMP_NAME);
        let write = || -> std::io::Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut f = options.open(&tmp)?;
            f.write_all(&json)?;
            f.sync_all()?;
            fs::rename(&tmp, self.dir.join(FILE_NAME))
        };
        write().map_err(|_| {
            let _ = fs::remove_file(&tmp);
            ConfigError::Io
        })
    }

    fn mutate<T>(
        &self,
        f: impl FnOnce(&mut ConfigFile) -> Result<T, ConfigError>,
    ) -> Result<T, ConfigError> {
        self.transact(|cfg| f(cfg).map(|out| (out, true)))
    }

    /// `f` returns whether it changed anything; the file is rewritten only then, after the
    /// structural invariants were checked again.
    fn transact<T>(
        &self,
        f: impl FnOnce(&mut ConfigFile) -> Result<(T, bool), ConfigError>,
    ) -> Result<T, ConfigError> {
        let _guard = self.guard()?;
        let mut cfg = self.load()?;
        let (out, changed) = f(&mut cfg)?;
        if changed {
            validate::structure(&cfg).map_err(ConfigError::InvalidInput)?;
            self.save(&cfg)?;
        }
        Ok(out)
    }

    pub fn snapshot(&self) -> Result<ConfigFile, ConfigError> {
        let _guard = self.guard()?;
        self.load()
    }

    pub fn create_project(&self, name: &str) -> Result<Project, ConfigError> {
        let name = validate::name(name)?;
        self.mutate(|cfg| {
            if cfg.projects.iter().any(|p| same_name(&p.name, &name)) {
                return Err(ConfigError::Conflict("project"));
            }
            let project = Project {
                id: new_id(),
                name,
                variables: Vec::new(),
                environments: Vec::new(),
                active_environment_id: None,
            };
            cfg.projects.push(project.clone());
            Ok(project)
        })
    }

    pub fn rename_project(&self, project_id: &str, name: &str) -> Result<Project, ConfigError> {
        let name = validate::name(name)?;
        self.mutate(|cfg| {
            project_mut(cfg, project_id)?;
            if cfg
                .projects
                .iter()
                .any(|p| p.id != project_id && same_name(&p.name, &name))
            {
                return Err(ConfigError::Conflict("project"));
            }
            let project = project_mut(cfg, project_id)?;
            project.name = name;
            Ok(project.clone())
        })
    }

    /// Removes the project and every node of it. Returns the project and its hosts, so their
    /// keychain entries can be cleaned up.
    pub fn delete_project(&self, project_id: &str) -> Result<(Project, Vec<Host>), ConfigError> {
        self.mutate(|cfg| {
            let i = cfg
                .projects
                .iter()
                .position(|p| p.id == project_id)
                .ok_or(ConfigError::NotFound("project"))?;
            let (gone, kept): (Vec<Node>, Vec<Node>) = std::mem::take(&mut cfg.nodes)
                .into_iter()
                .partition(|n| n.project_id() == Some(project_id));
            cfg.nodes = kept;
            let hosts = gone
                .into_iter()
                .filter_map(|n| match n {
                    Node::Host(h) => Some(h),
                    Node::Collection(_) => None,
                })
                .collect();
            Ok((cfg.projects.remove(i), hosts))
        })
    }

    pub fn create_environment(
        &self,
        project_id: &str,
        name: &str,
    ) -> Result<Environment, ConfigError> {
        let name = validate::name(name)?;
        self.mutate(|cfg| {
            let project = project_mut(cfg, project_id)?;
            if project
                .environments
                .iter()
                .any(|e| same_name(&e.name, &name))
            {
                return Err(ConfigError::Conflict("environment"));
            }
            let env = Environment {
                id: new_id(),
                name,
                variables: Vec::new(),
            };
            project.environments.push(env.clone());
            Ok(env)
        })
    }

    pub fn rename_environment(
        &self,
        project_id: &str,
        environment_id: &str,
        name: &str,
    ) -> Result<Environment, ConfigError> {
        let name = validate::name(name)?;
        self.mutate(|cfg| {
            let project = project_mut(cfg, project_id)?;
            env_mut(project, environment_id)?;
            if project
                .environments
                .iter()
                .any(|e| e.id != environment_id && same_name(&e.name, &name))
            {
                return Err(ConfigError::Conflict("environment"));
            }
            let env = env_mut(project, environment_id)?;
            env.name = name;
            Ok(env.clone())
        })
    }

    /// Returns the removed environment and the ids of the project's hosts at that moment.
    pub fn delete_environment(
        &self,
        project_id: &str,
        environment_id: &str,
    ) -> Result<(Environment, Vec<String>), ConfigError> {
        self.mutate(|cfg| {
            let project = project_mut(cfg, project_id)?;
            let i = project
                .environments
                .iter()
                .position(|e| e.id == environment_id)
                .ok_or(ConfigError::NotFound("environment"))?;
            if project.active_environment_id.as_deref() == Some(environment_id) {
                project.active_environment_id = None;
            }
            let env = project.environments.remove(i);
            let hosts = cfg
                .nodes
                .iter()
                .filter_map(Node::as_host)
                .filter(|h| h.project_id.as_deref() == Some(project_id))
                .map(|h| h.id.clone())
                .collect();
            Ok((env, hosts))
        })
    }

    pub fn set_active_environment(
        &self,
        project_id: &str,
        environment_id: Option<&str>,
    ) -> Result<Project, ConfigError> {
        self.mutate(|cfg| {
            let project = project_mut(cfg, project_id)?;
            if let Some(id) = environment_id {
                env_mut(project, id)?;
            }
            project.active_environment_id = environment_id.map(str::to_owned);
            Ok(project.clone())
        })
    }

    /// Replaces the whole list of a scope. Returns the previous list and the saved one.
    pub fn set_variables(
        &self,
        scope: &VariableScope,
        variables: &[Variable],
    ) -> Result<(Vec<Variable>, Vec<Variable>), ConfigError> {
        let new = validate::variables(variables)?;
        self.mutate(|cfg| {
            let slot = match scope {
                VariableScope::Global => &mut cfg.variables,
                VariableScope::Project { project_id } => {
                    &mut project_mut(cfg, project_id)?.variables
                }
                VariableScope::Environment {
                    project_id,
                    environment_id,
                } => &mut env_mut(project_mut(cfg, project_id)?, environment_id)?.variables,
            };
            let old = std::mem::replace(slot, new.clone());
            Ok((old, new))
        })
    }

    /// `entry.name` is validated and trimmed; names and paths must be unique.
    pub fn add_key(&self, mut entry: KeyEntry) -> Result<KeyEntry, ConfigError> {
        entry.name = validate::key_name(&entry.name)?;
        self.mutate(|cfg| {
            if key_name_taken(cfg, &entry.name, None) {
                return Err(ConfigError::Exists("a key with this name"));
            }
            if cfg.keys.iter().any(|k| same_path(&k.path, &entry.path)) {
                return Err(ConfigError::Exists("a key with this file"));
            }
            cfg.keys.push(entry.clone());
            Ok(entry)
        })
    }

    pub fn rename_key(&self, key_id: &str, name: &str) -> Result<KeyEntry, ConfigError> {
        let name = validate::key_name(name)?;
        self.mutate(|cfg| {
            key_mut(cfg, key_id)?;
            if key_name_taken(cfg, &name, Some(key_id)) {
                return Err(ConfigError::Exists("a key with this name"));
            }
            let key = key_mut(cfg, key_id)?;
            key.name = name;
            Ok(key.clone())
        })
    }

    pub fn delete_key(&self, key_id: &str) -> Result<KeyEntry, ConfigError> {
        self.mutate(|cfg| {
            let i = cfg
                .keys
                .iter()
                .position(|k| k.id == key_id)
                .ok_or(ConfigError::NotFound("key"))?;
            Ok(cfg.keys.remove(i))
        })
    }
}

#[cfg(test)]
mod tests;
