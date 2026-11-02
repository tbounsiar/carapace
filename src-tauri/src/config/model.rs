use serde::{Deserialize, Deserializer, Serialize};

/// A `${name}` template; see the `vars` module.
pub type Template = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VariableKind {
    Plain,
    Secret,
}

/// `value` is the plain value; it is always `None` for a secret, whose value lives in the keychain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub kind: VariableKind,
    #[serde(default)]
    pub value: Option<String>,
}

/// Secret fields are `None` (ask or use a saved connection secret) or a single `${name}` reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuthMethod {
    Password {
        #[serde(default)]
        password: Option<Template>,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        key_path: Template,
        #[serde(default)]
        passphrase: Option<Template>,
    },
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub hostname: Template,
    pub port: Template,
    pub username: Template,
    pub auth: AuthMethod,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub name: String,
    pub hostname: Template,
    #[serde(deserialize_with = "port_template")]
    pub port: Template,
    pub username: Template,
    pub auth: AuthMethod,
}

/// Accepts a number too, so a literal port typed as a number is not a deserialization error.
fn port_template<'de, D: Deserializer<'de>>(d: D) -> Result<Template, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Port {
        Text(String),
        Number(i64),
    }
    Ok(match Port::deserialize(d)? {
        Port::Text(s) => s,
        Port::Number(n) => n.to_string(),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<Variable>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub environments: Vec<Environment>,
    #[serde(default)]
    pub hosts: Vec<Host>,
    #[serde(default)]
    pub active_environment_id: Option<String>,
}

impl Project {
    pub fn environment(&self, id: &str) -> Option<&Environment> {
        self.environments.iter().find(|e| e.id == id)
    }

    pub fn host(&self, id: &str) -> Option<&Host> {
        self.hosts.iter().find(|h| h.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub version: u32,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub projects: Vec<Project>,
}

impl ConfigFile {
    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            version: super::store::VERSION,
            variables: Vec::new(),
            projects: Vec::new(),
        }
    }
}

/// Where a list of variables lives.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum VariableScope {
    Global,
    Project {
        project_id: String,
    },
    Environment {
        project_id: String,
        environment_id: String,
    },
}
