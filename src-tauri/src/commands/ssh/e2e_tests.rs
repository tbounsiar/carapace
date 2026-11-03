//! Templated hosts and environments against the disposable sshd in `e2e/sshd` (published on
//! 127.0.0.1:2222 and :2223). Run only with `CARAPACE_E2E=1` after `node e2e/sshd/setup.mjs up`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use secrecy::SecretString;
use tokio::sync::mpsc;

use super::*;
use crate::config::model::AuthMethod;
use crate::config::{HostInput, Variable, VariableKind, VariableScope};
use crate::secrets::{MemoryBackend, SecretStore, VarKey};
use crate::ssh::test_server::{E2E_SERVER, isolated_manager_with};
use crate::ssh::{SshError, Target};

fn enabled() -> bool {
    let on = std::env::var("CARAPACE_E2E").is_ok_and(|v| v == "1");
    if !on {
        eprintln!("skipped: set CARAPACE_E2E=1 to run the sshd e2e tests");
    }
    on
}

fn work_dir() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/.work");
    assert!(path.exists(), "missing {path:?}, run setup.mjs up");
    let canonical = std::fs::canonicalize(path).unwrap();
    let s = canonical.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned()
}

fn work_file(name: &str) -> String {
    let path = PathBuf::from(work_dir()).join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("missing {path:?}, run setup.mjs up"))
        .trim()
        .to_owned()
}

fn plain(name: &str, value: &str) -> Variable {
    Variable {
        name: name.into(),
        kind: VariableKind::Plain,
        value: Some(value.into()),
    }
}

struct World {
    _dir: tempfile::TempDir,
    store: ConfigStore,
    secrets: SecretStore,
    ssh: Arc<SshManager>,
    project: String,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().join("home"));
        let (secrets, _) = MemoryBackend::store();
        let ssh = Arc::new(isolated_manager_with(dir.path(), secrets.clone()));
        let project = store.create_project("e2e").unwrap().id;
        store
            .set_variables(
                &VariableScope::Global,
                &[plain("user", "carapace"), plain("keys", &work_dir())],
            )
            .unwrap();
        Self {
            _dir: dir,
            store,
            secrets,
            ssh,
            project,
        }
    }

    fn env(&self, name: &str, vars: &[Variable]) -> String {
        let id = self
            .store
            .create_environment(&self.project, name)
            .unwrap()
            .id;
        self.store
            .set_variables(
                &VariableScope::Environment {
                    project_id: self.project.clone(),
                    environment_id: id.clone(),
                },
                vars,
            )
            .unwrap();
        id
    }

    fn host(&self, name: &str, auth: AuthMethod) -> String {
        self.store
            .create_host(
                Some(&self.project),
                None,
                &HostInput {
                    name: name.into(),
                    hostname: "${host}".into(),
                    port: "${port}".into(),
                    username: "${user}".into(),
                    auth,
                },
            )
            .unwrap()
            .id
    }

    fn target(&self, host: &str, env: &str) -> Target {
        resolve::target(&self.store, host, Some(env)).unwrap()
    }

    /// Connects and accepts the host key if asked, like a user trusting it on first use.
    async fn connect(&self, target: Target) -> Result<ConnectionInfo, SshError> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let emit: Arc<dyn Fn(ConnectEvent) + Send + Sync> = Arc::new(move |e| {
            let _ = tx.send(e);
        });
        let ssh = self.ssh.clone();
        let mut task =
            tokio::spawn(async move { ssh.connect(&target, None, &|| true, emit).await });
        loop {
            tokio::select! {
                done = &mut task => return done.unwrap(),
                Some(event) = rx.recv() => {
                    if let ConnectEvent::HostKeyPrompt { request_id, .. } = event {
                        self.ssh.answer_host_key(&request_id, true).unwrap();
                    }
                }
            }
        }
    }
}

fn key_auth() -> AuthMethod {
    AuthMethod::Key {
        key_path: "${keys}/id_ed25519".into(),
        passphrase: None,
    }
}

#[tokio::test]
async fn templated_host_connects_with_the_environment_variables() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = World::new();
    let dev = w.env("Dev", &[plain("host", "127.0.0.1"), plain("port", "2222")]);
    let host = w.host("ui", key_auth());
    let target = w.target(&host, &dev);
    assert_eq!(target.port, 2222);
    let info = w.connect(target).await.unwrap();
    assert_eq!(info.connection_id, format!("{host}@{dev}"));
    assert_eq!(info.environment_id.as_deref(), Some(dev.as_str()));
    assert_eq!(w.ssh.list().await, vec![info]);
}

#[tokio::test]
async fn two_environments_give_two_concurrent_connections_of_one_host() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = World::new();
    let dev = w.env("Dev", &[plain("host", "127.0.0.1"), plain("port", "2222")]);
    let alt = w.env("Alt", &[plain("host", "127.0.0.1"), plain("port", "2223")]);
    let broken = w.env("Broken", &[plain("host", "127.0.0.1"), plain("port", "1")]);
    let host = w.host("ui", key_auth());

    let (a, b) = tokio::join!(
        w.connect(w.target(&host, &dev)),
        w.connect(w.target(&host, &alt))
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a.connection_id, b.connection_id);
    assert_eq!(w.ssh.list().await.len(), 2);

    let err = w.connect(w.target(&host, &broken)).await.unwrap_err();
    assert_eq!(err, SshError::Network);
    assert_eq!(w.ssh.list().await.len(), 2);

    w.ssh.disconnect(&b.connection_id).await.unwrap();
    assert!(w.ssh.session(&a.connection_id).await.is_some());
    assert_eq!(w.ssh.list().await, vec![a]);

    let missing = resolve::target(&w.store, &host, None).unwrap_err();
    assert_eq!(missing.code, "missing_variables");
}

#[tokio::test]
async fn password_from_a_secret_environment_variable() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = World::new();
    let dev = w.env(
        "Dev",
        &[
            plain("host", "127.0.0.1"),
            plain("port", "2222"),
            Variable {
                name: "pw".into(),
                kind: VariableKind::Secret,
                value: None,
            },
        ],
    );
    w.secrets
        .set_var(
            &VarKey::environment(&dev, "pw").unwrap(),
            &SecretString::from(work_file("password")),
        )
        .unwrap();
    let host = w.host(
        "pw",
        AuthMethod::Password {
            password: Some("${pw}".into()),
        },
    );
    let info = w.connect(w.target(&host, &dev)).await.unwrap();
    assert_eq!(info.connection_id, format!("{host}@{dev}"));
}

#[tokio::test]
async fn home_host_connects_with_global_variables_and_no_environment() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = World::new();
    w.store
        .set_variables(
            &VariableScope::Global,
            &[
                plain("user", "carapace"),
                plain("keys", &work_dir()),
                plain("host", "127.0.0.1"),
                plain("port", "2222"),
            ],
        )
        .unwrap();
    let host = w
        .store
        .create_host(
            None,
            None,
            &HostInput {
                name: "home".into(),
                hostname: "${host}".into(),
                port: "${port}".into(),
                username: "${user}".into(),
                auth: key_auth(),
            },
        )
        .unwrap()
        .id;
    let target = resolve::target(&w.store, &host, None).unwrap();
    let info = w.connect(target).await.unwrap();
    assert_eq!(info.connection_id, format!("{host}@none"));
    assert!(info.environment_id.is_none());
    let dev = w.env("Dev", &[]);
    let err = resolve::target(&w.store, &host, Some(&dev)).unwrap_err();
    assert_eq!(err.code, "invalid_input");
}
