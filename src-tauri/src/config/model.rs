use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    #[serde(rename_all = "camelCase")]
    Key {
        key_path: String,
    },
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub name: String,
    pub hostname: String,
    pub port: i64,
    pub username: String,
    pub auth: AuthMethod,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub hosts: Vec<Host>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub environments: Vec<Environment>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct ConfigFile {
    pub version: u32,
    pub projects: Vec<Project>,
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            version: 1,
            projects: Vec::new(),
        }
    }
}
