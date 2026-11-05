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

/// `project_id: None` is Home; `parent_id: None` is the root of the scope, otherwise a
/// collection of the same scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub parent_id: Option<String>,
    pub hostname: Template,
    pub port: Template,
    pub username: Template,
    pub auth: AuthMethod,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub parent_id: Option<String>,
}

/// Entry of the flat node list; the tree is given by `parent_id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Node {
    Collection(Collection),
    Host(Host),
}

impl Node {
    pub fn id(&self) -> &str {
        match self {
            Node::Collection(c) => &c.id,
            Node::Host(h) => &h.id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Node::Collection(c) => &c.name,
            Node::Host(h) => &h.name,
        }
    }

    pub fn project_id(&self) -> Option<&str> {
        match self {
            Node::Collection(c) => c.project_id.as_deref(),
            Node::Host(h) => h.project_id.as_deref(),
        }
    }

    pub fn parent_id(&self) -> Option<&str> {
        match self {
            Node::Collection(c) => c.parent_id.as_deref(),
            Node::Host(h) => h.parent_id.as_deref(),
        }
    }

    pub fn set_location(&mut self, project_id: Option<String>, parent_id: Option<String>) {
        let (p, q) = match self {
            Node::Collection(c) => (&mut c.project_id, &mut c.parent_id),
            Node::Host(h) => (&mut h.project_id, &mut h.parent_id),
        };
        *p = project_id;
        *q = parent_id;
    }

    pub fn as_host(&self) -> Option<&Host> {
        match self {
            Node::Host(h) => Some(h),
            Node::Collection(_) => None,
        }
    }

    pub fn is_collection(&self) -> bool {
        matches!(self, Node::Collection(_))
    }
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
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<Variable>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub version: u32,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub keys: Vec<KeyEntry>,
}

/// How remote files are opened outside the app. `appPath` is kept while `mode` is `system` so
/// switching back restores it; it is only used with `custom`. Missing or malformed means the
/// system default with the notice still shown.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditor {
    pub mode: EditorMode,
    #[serde(default)]
    pub app_path: Option<String>,
    #[serde(default)]
    pub notice_seen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorMode {
    #[default]
    System,
    Custom,
}

/// Usage analytics choices, one per category, kept in `settings.toml`. Missing, or written by a
/// hand edit in a shape we do not know, means unset: a bad value must never turn a category on,
/// nor make the whole file corrupt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSettings {
    pub categories: CategoryChoices,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Launch,
    Features,
    Connections,
}

impl Category {
    pub const ALL: [Category; 3] = [Category::Launch, Category::Features, Category::Connections];

    pub fn index(self) -> usize {
        self as usize
    }
}

/// An unset category is not written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct CategoryChoices {
    #[serde(skip_serializing_if = "CategoryChoice::is_unset")]
    pub launch: CategoryChoice,
    #[serde(skip_serializing_if = "CategoryChoice::is_unset")]
    pub features: CategoryChoice,
    #[serde(skip_serializing_if = "CategoryChoice::is_unset")]
    pub connections: CategoryChoice,
}

impl CategoryChoices {
    pub fn get(&self, category: Category) -> CategoryChoice {
        match category {
            Category::Launch => self.launch,
            Category::Features => self.features,
            Category::Connections => self.connections,
        }
    }

    pub fn set(&mut self, category: Category, choice: CategoryChoice) {
        match category {
            Category::Launch => self.launch = choice,
            Category::Features => self.features = choice,
            Category::Connections => self.connections = choice,
        }
    }

    pub fn all(choice: CategoryChoice) -> Self {
        Self {
            launch: choice,
            features: choice,
            connections: choice,
        }
    }
}

/// `version` is the catalogue version the answer was given for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CategoryChoice {
    pub consent: Consent,
    pub version: u32,
}

impl CategoryChoice {
    pub fn is_unset(&self) -> bool {
        self.consent == Consent::Unset
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Consent {
    #[default]
    Unset,
    Granted,
    Denied,
}

impl ConfigFile {
    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id() == id)
    }

    pub fn host(&self, id: &str) -> Option<&Host> {
        self.node(id).and_then(Node::as_host)
    }

    /// The node and every node below it, the node first.
    pub fn subtree(&self, id: &str) -> Vec<&Node> {
        let mut out: Vec<&Node> = self.node(id).into_iter().collect();
        let mut i = 0;
        // Bounded so a cycle in an unvalidated list cannot loop forever.
        while i < out.len() && out.len() <= self.nodes.len() {
            let node: &Node = out[i];
            if node.is_collection() {
                out.extend(
                    self.nodes
                        .iter()
                        .filter(|n| n.parent_id() == Some(node.id())),
                );
            }
            i += 1;
        }
        out
    }

    pub fn key(&self, id: &str) -> Option<&KeyEntry> {
        self.keys.iter().find(|k| k.id == id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyAlgorithm {
    Ed25519,
    Rsa,
}

/// Who created the key files. Only generated keys may have their files deleted. Entries
/// written before the field existed are fixed up on load (see `ConfigStore`); the default is the
/// safe one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyOrigin {
    Generated,
    #[default]
    Imported,
}

/// A registered SSH key: public data and where the private key file is. `managed` keys live in
/// the app's keys directory; `origin` says whether the app generated the files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub managed: bool,
    #[serde(default)]
    pub origin: KeyOrigin,
    pub algorithm: KeyAlgorithm,
    pub bits: Option<u32>,
    pub public_key: String,
    pub fingerprint: String,
    pub comment: String,
    pub encrypted: bool,
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            version: super::store::VERSION,
            variables: Vec::new(),
            projects: Vec::new(),
            nodes: Vec::new(),
            keys: Vec::new(),
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
    Project { project_id: String },
}
