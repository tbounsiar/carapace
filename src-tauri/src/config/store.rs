use std::fs;
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use thiserror::Error;
use uuid::Uuid;

use super::model::{ConfigFile, Environment, Host, HostInput, Project};
use super::validate;

const FILE_NAME: &str = "config.json";
const TMP_NAME: &str = "config.json.tmp";
const VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0} already exists")]
    Conflict(&'static str),
    #[error("could not read or write the configuration file")]
    Io,
    #[error("the configuration file is unreadable or has an unsupported format")]
    Corrupt,
}

/// Each operation reloads the file, so a corrupt file is reported on every
/// call and is never overwritten.
#[derive(Debug)]
pub struct ConfigStore {
    dir: PathBuf,
    lock: Mutex<()>,
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
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

impl ConfigStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
        }
    }

    fn load(&self) -> Result<ConfigFile, ConfigError> {
        let raw = match fs::read(self.dir.join(FILE_NAME)) {
            Ok(raw) => raw,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(ConfigFile::default()),
            Err(_) => return Err(ConfigError::Io),
        };
        let cfg: ConfigFile = serde_json::from_slice(&raw).map_err(|_| ConfigError::Corrupt)?;
        if cfg.version != VERSION {
            return Err(ConfigError::Corrupt);
        }
        Ok(cfg)
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
        let _guard = self.lock.lock().map_err(|_| ConfigError::Io)?;
        let mut cfg = self.load()?;
        let out = f(&mut cfg)?;
        self.save(&cfg)?;
        Ok(out)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, ConfigError> {
        Ok(self.load()?.projects)
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
                environments: Vec::new(),
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

    pub fn delete_project(&self, project_id: &str) -> Result<(), ConfigError> {
        self.mutate(|cfg| {
            let before = cfg.projects.len();
            cfg.projects.retain(|p| p.id != project_id);
            if cfg.projects.len() == before {
                return Err(ConfigError::NotFound("project"));
            }
            Ok(())
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
                hosts: Vec::new(),
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

    pub fn delete_environment(
        &self,
        project_id: &str,
        environment_id: &str,
    ) -> Result<(), ConfigError> {
        self.mutate(|cfg| {
            let project = project_mut(cfg, project_id)?;
            let before = project.environments.len();
            project.environments.retain(|e| e.id != environment_id);
            if project.environments.len() == before {
                return Err(ConfigError::NotFound("environment"));
            }
            Ok(())
        })
    }

    pub fn create_host(
        &self,
        project_id: &str,
        environment_id: &str,
        input: &HostInput,
    ) -> Result<Host, ConfigError> {
        let v = validate::host(input)?;
        self.mutate(|cfg| {
            let env = env_mut(project_mut(cfg, project_id)?, environment_id)?;
            if env.hosts.iter().any(|h| same_name(&h.name, &v.name)) {
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
            env.hosts.push(host.clone());
            Ok(host)
        })
    }

    pub fn update_host(
        &self,
        project_id: &str,
        environment_id: &str,
        host_id: &str,
        input: &HostInput,
    ) -> Result<Host, ConfigError> {
        let v = validate::host(input)?;
        self.mutate(|cfg| {
            let env = env_mut(project_mut(cfg, project_id)?, environment_id)?;
            if !env.hosts.iter().any(|h| h.id == host_id) {
                return Err(ConfigError::NotFound("host"));
            }
            if env
                .hosts
                .iter()
                .any(|h| h.id != host_id && same_name(&h.name, &v.name))
            {
                return Err(ConfigError::Conflict("host"));
            }
            let host = env
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

    pub fn delete_host(
        &self,
        project_id: &str,
        environment_id: &str,
        host_id: &str,
    ) -> Result<(), ConfigError> {
        self.mutate(|cfg| {
            let env = env_mut(project_mut(cfg, project_id)?, environment_id)?;
            let before = env.hosts.len();
            env.hosts.retain(|h| h.id != host_id);
            if env.hosts.len() == before {
                return Err(ConfigError::NotFound("host"));
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::model::AuthMethod;

    fn store() -> (tempfile::TempDir, ConfigStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = ConfigStore::new(dir.path().to_path_buf());
        (dir, s)
    }

    fn abs_key() -> String {
        if cfg!(windows) {
            "C:\\keys\\id_ed25519".into()
        } else {
            "/home/u/.ssh/id_ed25519".into()
        }
    }

    fn input(name: &str) -> HostInput {
        HostInput {
            name: name.into(),
            hostname: "example.com".into(),
            port: 22,
            username: "deploy".into(),
            auth: AuthMethod::Agent,
        }
    }

    fn setup() -> (tempfile::TempDir, ConfigStore, Project, Environment) {
        let (d, s) = store();
        let p = s.create_project("Alpha").unwrap();
        let e = s.create_environment(&p.id, "dev").unwrap();
        (d, s, p, e)
    }

    fn invalid<T: std::fmt::Debug>(r: Result<T, ConfigError>) {
        assert!(matches!(r, Err(ConfigError::InvalidInput(_))), "{r:?}");
    }

    #[test]
    fn missing_file_is_empty() {
        let (_d, s) = store();
        assert!(s.list_projects().unwrap().is_empty());
    }

    #[test]
    fn corrupt_file_is_reported_and_preserved() {
        let (d, s) = store();
        let path = d.path().join(FILE_NAME);
        fs::write(&path, "{ not json").unwrap();
        assert!(matches!(s.list_projects(), Err(ConfigError::Corrupt)));
        assert!(matches!(s.create_project("x"), Err(ConfigError::Corrupt)));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn unsupported_version_is_corrupt() {
        let (d, s) = store();
        fs::write(d.path().join(FILE_NAME), r#"{"version":2,"projects":[]}"#).unwrap();
        assert!(matches!(s.list_projects(), Err(ConfigError::Corrupt)));
    }

    #[test]
    fn round_trip_and_disk_format() {
        let (d, s, p, e) = setup();
        let mut i = input("web");
        i.auth = AuthMethod::Key {
            key_path: abs_key(),
        };
        let h = s.create_host(&p.id, &e.id, &i).unwrap();
        let fresh = ConfigStore::new(d.path().to_path_buf());
        let projects = fresh.list_projects().unwrap();
        assert_eq!(projects[0].environments[0].hosts[0], h);
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(d.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(raw["version"], 1);
        let auth = &raw["projects"][0]["environments"][0]["hosts"][0]["auth"];
        assert_eq!(auth["kind"], "key");
        assert_eq!(auth["keyPath"], abs_key());
        assert!(!d.path().join(TMP_NAME).exists());
    }

    #[test]
    fn project_crud_and_conflicts() {
        let (_d, s) = store();
        let p = s.create_project("  Alpha  ").unwrap();
        assert_eq!(p.name, "Alpha");
        assert!(matches!(
            s.create_project("alpha"),
            Err(ConfigError::Conflict(_))
        ));
        let q = s.create_project("Beta").unwrap();
        assert!(matches!(
            s.rename_project(&q.id, "ALPHA"),
            Err(ConfigError::Conflict(_))
        ));
        assert_eq!(s.rename_project(&p.id, "ALPHA").unwrap().name, "ALPHA");
        s.delete_project(&p.id).unwrap();
        assert_eq!(s.list_projects().unwrap().len(), 1);
        assert!(matches!(
            s.delete_project(&p.id),
            Err(ConfigError::NotFound(_))
        ));
        assert!(matches!(
            s.rename_project("nope", "x"),
            Err(ConfigError::NotFound(_))
        ));
    }

    #[test]
    fn name_rules() {
        let (_d, s) = store();
        invalid(s.create_project("   "));
        invalid(s.create_project(&"a".repeat(101)));
        assert!(s.create_project(&"a".repeat(100)).is_ok());
    }

    #[test]
    fn environment_crud_and_conflicts() {
        let (_d, s, p, e) = setup();
        assert!(matches!(
            s.create_environment(&p.id, "DEV"),
            Err(ConfigError::Conflict(_))
        ));
        let other = s.create_project("Beta").unwrap();
        assert!(s.create_environment(&other.id, "dev").is_ok());
        let prod = s.create_environment(&p.id, "prod").unwrap();
        assert!(matches!(
            s.rename_environment(&p.id, &prod.id, "dev"),
            Err(ConfigError::Conflict(_))
        ));
        assert_eq!(
            s.rename_environment(&p.id, &e.id, "Dev").unwrap().name,
            "Dev"
        );
        assert!(matches!(
            s.create_environment("nope", "x"),
            Err(ConfigError::NotFound(_))
        ));
        assert!(matches!(
            s.rename_environment(&p.id, "nope", "x"),
            Err(ConfigError::NotFound(_))
        ));
        s.delete_environment(&p.id, &e.id).unwrap();
        assert!(matches!(
            s.delete_environment(&p.id, &e.id),
            Err(ConfigError::NotFound(_))
        ));
    }

    #[test]
    fn host_crud_and_conflicts() {
        let (_d, s, p, e) = setup();
        let h = s.create_host(&p.id, &e.id, &input("web")).unwrap();
        assert!(matches!(
            s.create_host(&p.id, &e.id, &input("WEB")),
            Err(ConfigError::Conflict(_))
        ));
        let db = s.create_host(&p.id, &e.id, &input("db")).unwrap();
        assert!(matches!(
            s.update_host(&p.id, &e.id, &db.id, &input("web")),
            Err(ConfigError::Conflict(_))
        ));
        let mut upd = input("web");
        upd.port = 2222;
        upd.auth = AuthMethod::Password;
        let out = s.update_host(&p.id, &e.id, &h.id, &upd).unwrap();
        assert_eq!((out.id.as_str(), out.port), (h.id.as_str(), 2222));
        assert_eq!(out.auth, AuthMethod::Password);
        assert!(matches!(
            s.update_host(&p.id, &e.id, "nope", &upd),
            Err(ConfigError::NotFound(_))
        ));
        assert!(matches!(
            s.create_host(&p.id, "nope", &upd),
            Err(ConfigError::NotFound(_))
        ));
        s.delete_host(&p.id, &e.id, &h.id).unwrap();
        assert!(matches!(
            s.delete_host(&p.id, &e.id, &h.id),
            Err(ConfigError::NotFound(_))
        ));
    }

    #[test]
    fn host_validation() {
        let (_d, s, p, e) = setup();
        let try_with = |f: &dyn Fn(&mut HostInput)| {
            let mut i = input("h");
            f(&mut i);
            s.create_host(&p.id, &e.id, &i)
        };
        invalid(try_with(&|i| i.port = 0));
        invalid(try_with(&|i| i.port = 65536));
        invalid(try_with(&|i| i.port = -1));
        invalid(try_with(&|i| i.hostname = String::new()));
        invalid(try_with(&|i| i.hostname = "a b".into()));
        invalid(try_with(&|i| i.hostname = "a\u{7}b".into()));
        invalid(try_with(&|i| i.hostname = "a".repeat(254)));
        invalid(try_with(&|i| i.username = String::new()));
        invalid(try_with(&|i| i.username = "a b".into()));
        invalid(try_with(&|i| i.username = "a".repeat(65)));
        invalid(try_with(&|i| i.name = " ".into()));
        invalid(try_with(&|i| {
            i.auth = AuthMethod::Key {
                key_path: "relative/key".into(),
            }
        }));
        invalid(try_with(&|i| {
            i.auth = AuthMethod::Key {
                key_path: String::new(),
            }
        }));
        invalid(try_with(&|i| {
            i.auth = AuthMethod::Key {
                key_path: format!("{}{}", abs_key(), "a".repeat(4096)),
            }
        }));
        for bad in ["a/b", "a_b", "a@b", "[::1]", "h\u{e9}ost", "a;b"] {
            invalid(try_with(&|i| i.hostname = bad.into()));
        }
        for bad in [
            r"\\server\share\key",
            r"\\?\UNC\server\share\key",
            r"\\?\C:\keys\key",
            r"\\.\pipe\x",
            "//server/share/key",
            "~",
            "~user/key",
        ] {
            invalid(try_with(&|i| {
                i.auth = AuthMethod::Key {
                    key_path: bad.into(),
                }
            }));
        }
        for (n, good) in ["a.example", "10.0.0.1", "fe80::1", "my-host.local"]
            .iter()
            .enumerate()
        {
            let ok = try_with(&|i| {
                i.name = format!("good{n}");
                i.hostname = (*good).into();
            });
            assert!(ok.is_ok(), "{good}");
        }
        assert!(
            try_with(&|i| {
                i.name = "tilde".into();
                i.auth = AuthMethod::Key {
                    key_path: "~/.ssh/id_ed25519".into(),
                }
            })
            .is_ok()
        );
        assert!(try_with(&|i| i.port = 65535).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn config_temp_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let s = ConfigStore::new(dir.path().to_path_buf());
        s.create_project("p").unwrap();
        let mode = fs::metadata(dir.path().join(FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn wire_format_is_camel_case() {
        let json = serde_json::to_value(AuthMethod::Key {
            key_path: "/k".into(),
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({"kind":"key","keyPath":"/k"}));
        let a: AuthMethod = serde_json::from_str(r#"{"kind":"password"}"#).unwrap();
        assert_eq!(a, AuthMethod::Password);
    }
}
