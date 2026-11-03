//! Templated hosts and variable layers against the disposable sshd in `e2e/sshd` (published on
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
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().join("home"));
        let (secrets, _) = MemoryBackend::store();
        let ssh = Arc::new(isolated_manager_with(dir.path(), secrets.clone()));
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
        }
    }

    fn project(&self, name: &str, vars: &[Variable]) -> String {
        let id = self.store.create_project(name).unwrap().id;
        self.store
            .set_variables(
                &VariableScope::Project {
                    project_id: id.clone(),
                },
                vars,
            )
            .unwrap();
        id
    }

    fn host(&self, project: Option<&str>, name: &str, auth: AuthMethod) -> String {
        self.store
            .create_host(
                project,
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

    fn target(&self, host: &str) -> Target {
        resolve::target(&self.store, host).unwrap()
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

fn endpoint(port: &str) -> [Variable; 2] {
    [plain("host", "127.0.0.1"), plain("port", port)]
}

#[tokio::test]
async fn templated_host_connects_with_the_project_variables() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = World::new();
    let p = w.project("e2e", &endpoint("2222"));
    let host = w.host(Some(&p), "ui", key_auth());
    let target = w.target(&host);
    assert_eq!(target.port, 2222);
    let info = w.connect(target).await.unwrap();
    assert_eq!(info.connection_id, host);
    assert_eq!(info.host_id, host);
    assert_eq!(w.ssh.list().await, vec![info]);
}

#[tokio::test]
async fn project_variables_win_over_global_ones() {
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
                plain("port", "1"),
            ],
        )
        .unwrap();
    let p = w.project("e2e", &[plain("port", "2223")]);
    let host = w.host(Some(&p), "ui", key_auth());
    let info = w.connect(w.target(&host)).await.unwrap();
    assert_eq!(info.connection_id, host);
    let home = w.host(None, "home", key_auth());
    let err = w.connect(w.target(&home)).await.unwrap_err();
    assert_eq!(err, SshError::Network);
}

#[tokio::test]
async fn hosts_of_two_projects_connect_concurrently() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = World::new();
    let a = w.project("a", &endpoint("2222"));
    let b = w.project("b", &endpoint("2223"));
    let broken = w.project("broken", &endpoint("1"));
    let (ha, hb) = (
        w.host(Some(&a), "ui", key_auth()),
        w.host(Some(&b), "ui", key_auth()),
    );

    let (ca, cb) = tokio::join!(w.connect(w.target(&ha)), w.connect(w.target(&hb)));
    let (ca, cb) = (ca.unwrap(), cb.unwrap());
    assert_eq!(
        (ca.connection_id.as_str(), cb.connection_id.as_str()),
        (ha.as_str(), hb.as_str())
    );
    assert_eq!(w.ssh.list().await.len(), 2);

    let hx = w.host(Some(&broken), "ui", key_auth());
    let err = w.connect(w.target(&hx)).await.unwrap_err();
    assert_eq!(err, SshError::Network);
    assert_eq!(w.ssh.list().await.len(), 2);

    w.ssh.disconnect(&cb.connection_id).await.unwrap();
    assert!(w.ssh.session(&ca.connection_id).await.is_some());
    assert_eq!(w.ssh.list().await, vec![ca]);

    let bare = w.project("bare", &[]);
    let hm = w.host(Some(&bare), "ui", key_auth());
    let missing = resolve::target(&w.store, &hm).unwrap_err();
    assert_eq!(missing.code, "missing_variables");
}

#[tokio::test]
async fn password_from_a_secret_project_variable() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = World::new();
    let [h, port] = endpoint("2222");
    let p = w.project(
        "e2e",
        &[
            h,
            port,
            Variable {
                name: "pw".into(),
                kind: VariableKind::Secret,
                value: None,
            },
        ],
    );
    w.secrets
        .set_var(
            &VarKey::project(&p, "pw").unwrap(),
            &SecretString::from(work_file("password")),
        )
        .unwrap();
    let host = w.host(
        Some(&p),
        "pw",
        AuthMethod::Password {
            password: Some("${pw}".into()),
        },
    );
    let info = w.connect(w.target(&host)).await.unwrap();
    assert_eq!(info.connection_id, host);
}

#[tokio::test]
async fn home_host_connects_with_global_variables_only() {
    if !enabled() {
        return;
    }
    let _g = E2E_SERVER.read().await;
    let w = World::new();
    w.project("e2e", &endpoint("1"));
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
    let host = w.host(None, "home", key_auth());
    let target = w.target(&host);
    assert_eq!(target.port, 2222);
    let info = w.connect(target).await.unwrap();
    assert_eq!(info.connection_id, host);
}
