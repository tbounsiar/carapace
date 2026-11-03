use std::fs;
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;

use super::model::{
    ConfigFile, Environment, Host, HostInput, KeyEntry, Project, Variable, VariableScope,
};
use super::validate::{self, same_name};

const FILE_NAME: &str = "config.json";
const TMP_NAME: &str = "config.json.tmp";
const V1_BACKUP: &str = "config.json.v1.bak";
pub(super) const VERSION: u32 = 2;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0} already exists")]
    Conflict(&'static str),
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

fn host_name_taken(p: &Project, name: &str, except: Option<&str>) -> bool {
    p.hosts
        .iter()
        .any(|h| Some(h.id.as_str()) != except && same_name(&h.name, name))
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
        let raw = match fs::read(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(ConfigFile::default()),
            Err(_) => return Err(ConfigError::Io),
        };
        let probe: Probe = serde_json::from_slice(&raw).map_err(|_| ConfigError::Corrupt)?;
        match probe.version {
            VERSION => serde_json::from_slice(&raw).map_err(|_| ConfigError::Corrupt),
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
            .chain((2..=1000).map(|n| format!("config.json.v1.{n}.bak")))
            .map(|name| self.dir.join(name))
            .find(|p| !p.exists())
            .ok_or(ConfigError::Io)?;
        fs::rename(self.dir.join(FILE_NAME), target).map_err(|_| ConfigError::Io)?;
        log::info!("configuration version 1 moved aside; starting with an empty configuration");
        Ok(())
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
        let _guard = self.guard()?;
        let mut cfg = self.load()?;
        let out = f(&mut cfg)?;
        self.save(&cfg)?;
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
                hosts: Vec::new(),
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

    /// Returns what was removed, so its keychain entries can be cleaned up.
    pub fn delete_project(&self, project_id: &str) -> Result<Project, ConfigError> {
        self.mutate(|cfg| {
            let i = cfg
                .projects
                .iter()
                .position(|p| p.id == project_id)
                .ok_or(ConfigError::NotFound("project"))?;
            Ok(cfg.projects.remove(i))
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

    /// Returns the removed environment and the project's host ids at that moment.
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
            let hosts = project.hosts.iter().map(|h| h.id.clone()).collect();
            Ok((project.environments.remove(i), hosts))
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

    pub fn create_host(&self, project_id: &str, input: &HostInput) -> Result<Host, ConfigError> {
        let v = validate::host(input)?;
        self.mutate(|cfg| {
            let project = project_mut(cfg, project_id)?;
            if host_name_taken(project, &v.name, None) {
                return Err(ConfigError::Conflict("host"));
            }
            let host = Host {
                id: new_id(),
                name: v.name,
                hostname: v.hostname,
                port: v.port,
                username: v.username,
                auth: v.auth,
            };
            project.hosts.push(host.clone());
            Ok(host)
        })
    }

    pub fn update_host(
        &self,
        project_id: &str,
        host_id: &str,
        input: &HostInput,
    ) -> Result<Host, ConfigError> {
        let v = validate::host(input)?;
        self.mutate(|cfg| {
            let project = project_mut(cfg, project_id)?;
            if project.host(host_id).is_none() {
                return Err(ConfigError::NotFound("host"));
            }
            if host_name_taken(project, &v.name, Some(host_id)) {
                return Err(ConfigError::Conflict("host"));
            }
            let host = project
                .hosts
                .iter_mut()
                .find(|h| h.id == host_id)
                .ok_or(ConfigError::NotFound("host"))?;
            host.name = v.name;
            host.hostname = v.hostname;
            host.port = v.port;
            host.username = v.username;
            host.auth = v.auth;
            Ok(host.clone())
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

    /// Returns the removed host and the project's environment ids at that moment.
    pub fn delete_host(
        &self,
        project_id: &str,
        host_id: &str,
    ) -> Result<(Host, Vec<String>), ConfigError> {
        self.mutate(|cfg| {
            let project = project_mut(cfg, project_id)?;
            let i = project
                .hosts
                .iter()
                .position(|h| h.id == host_id)
                .ok_or(ConfigError::NotFound("host"))?;
            let envs = project.environments.iter().map(|e| e.id.clone()).collect();
            Ok((project.hosts.remove(i), envs))
        })
    }
}

#[cfg(test)]
mod tests;
