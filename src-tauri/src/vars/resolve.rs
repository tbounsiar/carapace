use std::fmt;

use serde::{Serialize, Serializer};
use thiserror::Error;

use super::template::{Segment, parse, single_reference};
use crate::config::model::{
    AuthMethod, ConfigFile, Host, Project, Template, Variable, VariableKind,
};
use crate::config::validate;
use crate::text::{Localized, Text};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Level {
    Global,
    Project(String),
}

/// Variable layers, lowest priority first: global < project. A host outside a project (Home)
/// has no project layer.
#[derive(Debug, Clone, Copy)]
pub struct Layers<'a> {
    pub global: &'a [Variable],
    pub project: Option<(&'a str, &'a [Variable])>,
}

impl<'a> Layers<'a> {
    pub fn of(config: &'a ConfigFile, project: Option<&'a Project>) -> Self {
        Self {
            global: &config.variables,
            project: project.map(|p| (p.id.as_str(), p.variables.as_slice())),
        }
    }

    /// The winning definition of `name` (case-sensitive) and the layer it comes from.
    pub fn lookup(&self, name: &str) -> Option<(Level, &'a Variable)> {
        let find = |list: &'a [Variable]| list.iter().find(|v| v.name == name);
        if let Some((id, list)) = self.project
            && let Some(v) = find(list)
        {
            return Some((Level::Project(id.into()), v));
        }
        find(self.global).map(|v| (Level::Global, v))
    }
}

/// A secret field pointing at a secret variable; its value is read from the keychain later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretRef {
    pub level: Level,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedAuth {
    Password {
        password: Option<SecretRef>,
    },
    Key {
        key_path: String,
        passphrase: Option<SecretRef>,
    },
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedHost {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: ResolvedAuth,
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum ResolveError {
    #[error("missing variables: {}", .0.join(", "))]
    Missing(Vec<String>),
    #[error("{}", Joined(.0))]
    Invalid(Vec<Text>),
}

/// Texts shown as one, separated by `; `; sent as a list of texts.
struct Joined<'a>(&'a [Text]);

impl fmt::Display for Joined<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, t) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str("; ")?;
            }
            f.write_str(&t.message)?;
        }
        Ok(())
    }
}

impl Serialize for Joined<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

/// Everything that could be resolved; fields stay `None` when they depend on a problem
/// listed in `missing` or `errors`. Never holds a secret value.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolution {
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub key_path: Option<String>,
    pub missing: Vec<String>,
    pub errors: Vec<Text>,
    auth: Option<ResolvedAuth>,
}

impl Resolution {
    pub fn complete(self) -> Result<ResolvedHost, ResolveError> {
        if !self.missing.is_empty() {
            return Err(ResolveError::Missing(self.missing));
        }
        if !self.errors.is_empty() {
            return Err(ResolveError::Invalid(self.errors));
        }
        match (self.hostname, self.port, self.username, self.auth) {
            (Some(hostname), Some(port), Some(username), Some(auth)) => Ok(ResolvedHost {
                hostname,
                port,
                username,
                auth,
            }),
            _ => Err(ResolveError::Invalid(vec![crate::text!(
                "errors.config.hostUnresolved",
                "the host could not be resolved"
            )])),
        }
    }
}

struct Resolver<'a> {
    layers: Layers<'a>,
    missing: Vec<String>,
    errors: Vec<Text>,
}

impl Resolver<'_> {
    fn error(&mut self, msg: Text) {
        if !self.errors.contains(&msg) {
            self.errors.push(msg);
        }
    }

    fn missing(&mut self, name: &str) {
        if !self.missing.iter().any(|m| m == name) {
            self.missing.push(name.into());
        }
    }

    /// Plain fields only take plain variables: a secret value must never reach a field that is
    /// displayed, logged or put in an error.
    fn plain(&mut self, label: &'static str, template: &str) -> Option<String> {
        let segments = match parse(template) {
            Ok(s) => s,
            Err(e) => {
                self.error(e.of_field(label));
                return None;
            }
        };
        let mut out = String::new();
        let mut complete = true;
        for segment in segments {
            match segment {
                Segment::Literal(l) => out.push_str(&l),
                Segment::Reference(name) => match self.layers.lookup(name) {
                    None => {
                        self.missing(name);
                        complete = false;
                    }
                    Some((_, v)) if v.kind == VariableKind::Secret => {
                        self.error(crate::text!(
                            "errors.config.secretInPlainField",
                            "secret variable {name} used in a non-secret field",
                            name = name
                        ));
                        complete = false;
                    }
                    Some((_, v)) => out.push_str(v.value.as_deref().unwrap_or("")),
                },
            }
        }
        complete.then_some(out)
    }

    fn checked<T>(
        &mut self,
        value: Option<String>,
        check: impl Fn(&str) -> Result<T, Text>,
    ) -> Option<T> {
        let value = value?;
        match check(&value) {
            Ok(v) => Some(v),
            Err(msg) => {
                self.error(msg);
                None
            }
        }
    }

    /// `Err` means the problem was recorded.
    fn secret(
        &mut self,
        label: &'static str,
        template: &Option<Template>,
    ) -> Result<Option<SecretRef>, ()> {
        let Some(template) = template else {
            return Ok(None);
        };
        let Some(name) = single_reference(template) else {
            self.error(validate::not_a_secret_reference(label));
            return Err(());
        };
        match self.layers.lookup(name) {
            None => {
                self.missing(name);
                Err(())
            }
            Some((_, v)) if v.kind == VariableKind::Plain => {
                self.error(crate::text!(
                    "errors.config.plainInSecretField",
                    "plain variable {name} used in a secret field",
                    name = name
                ));
                Err(())
            }
            Some((level, _)) => Ok(Some(SecretRef {
                level,
                name: name.into(),
            })),
        }
    }
}

pub fn resolve_host(host: &Host, layers: Layers<'_>) -> Resolution {
    let mut r = Resolver {
        layers,
        missing: Vec::new(),
        errors: Vec::new(),
    };
    let hostname = r.plain("hostname", &host.hostname);
    let hostname = r.checked(hostname, |v| validate::hostname(v).map(|_| v.to_owned()));
    let port = r.plain("port", &host.port);
    let port = r.checked(port, validate::port);
    let username = r.plain("username", &host.username);
    let username = r.checked(username, |v| validate::username(v).map(|_| v.to_owned()));
    let mut key_path = None;
    let auth = match &host.auth {
        AuthMethod::Agent => Some(ResolvedAuth::Agent),
        AuthMethod::Password { password } => r
            .secret("password", password)
            .ok()
            .map(|password| ResolvedAuth::Password { password }),
        AuthMethod::Key {
            key_path: path,
            passphrase,
        } => {
            let path = r.plain("key path", path);
            key_path = r.checked(path, |v| validate::key_path(v).map(|_| v.to_owned()));
            let passphrase = r.secret("passphrase", passphrase);
            match (&key_path, passphrase) {
                (Some(k), Ok(passphrase)) => Some(ResolvedAuth::Key {
                    key_path: k.clone(),
                    passphrase,
                }),
                _ => None,
            }
        }
    };
    Resolution {
        hostname,
        port,
        username,
        key_path,
        missing: r.missing,
        errors: r.errors,
        auth,
    }
}

/// One invalid field gives its own text; several give a list of texts in `errors`.
impl Localized for ResolveError {
    fn text(&self) -> Text {
        match self {
            Self::Missing(names) => crate::text!(
                "errors.config.missingVariables",
                "missing variables: {names}",
                names = names.join(", ")
            ),
            Self::Invalid(list) if list.len() == 1 => list[0].clone(),
            Self::Invalid(list) => {
                crate::text!(
                    "errors.config.invalidFields",
                    "{errors}",
                    errors = Joined(list)
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(name: &str, value: &str) -> Variable {
        Variable {
            name: name.into(),
            kind: VariableKind::Plain,
            value: Some(value.into()),
        }
    }

    fn secret(name: &str) -> Variable {
        Variable {
            name: name.into(),
            kind: VariableKind::Secret,
            value: None,
        }
    }

    fn host(hostname: &str, port: &str, username: &str, auth: AuthMethod) -> Host {
        Host {
            id: "h".into(),
            name: "h".into(),
            project_id: Some("p".into()),
            parent_id: None,
            hostname: hostname.into(),
            port: port.into(),
            username: username.into(),
            auth,
        }
    }

    fn messages(r: &Resolution) -> Vec<&str> {
        r.errors.iter().map(|t| t.message.as_str()).collect()
    }

    fn templated(auth: AuthMethod) -> Host {
        host("${host}", "${port}", "${user}", auth)
    }

    struct World {
        global: Vec<Variable>,
        project: Vec<Variable>,
    }

    impl World {
        fn layers(&self) -> Layers<'_> {
            Layers {
                global: &self.global,
                project: Some(("p", &self.project)),
            }
        }

        fn resolve(&self, h: &Host) -> Resolution {
            resolve_host(h, self.layers())
        }
    }

    fn world() -> World {
        World {
            global: vec![plain("user", "carapace"), plain("port", "22")],
            project: vec![
                plain("host", "project.example"),
                plain("port", "2223"),
                secret("pw"),
            ],
        }
    }

    #[test]
    fn project_beats_global() {
        let w = world();
        let r = w.resolve(&templated(AuthMethod::Agent));
        assert_eq!(r.hostname.as_deref(), Some("project.example"));
        assert_eq!(r.port, Some(2223));
        assert_eq!(r.username.as_deref(), Some("carapace"));
        assert!(r.missing.is_empty() && r.errors.is_empty());
        assert_eq!(
            w.layers().lookup("pw").unwrap().0,
            Level::Project("p".into())
        );
        assert_eq!(w.layers().lookup("user").unwrap().0, Level::Global);
    }

    #[test]
    fn home_hosts_see_global_variables_only() {
        let w = world();
        let layers = Layers {
            project: None,
            ..w.layers()
        };
        assert_eq!(layers.lookup("user").unwrap().0, Level::Global);
        assert!(layers.lookup("host").is_none() && layers.lookup("pw").is_none());
        let r = resolve_host(&templated(AuthMethod::Agent), layers);
        assert_eq!(r.missing, vec!["host".to_string()]);
        assert_eq!(r.port, Some(22));
    }

    #[test]
    fn lookup_is_case_sensitive() {
        let w = world();
        assert!(w.layers().lookup("User").is_none());
        let r = w.resolve(&host("${Host}", "22", "me", AuthMethod::Agent));
        assert_eq!(r.missing, vec!["Host".to_string()]);
    }

    #[test]
    fn literals_and_escapes_mix_with_references() {
        let w = World {
            global: vec![plain("dom", "example"), plain("n", "2")],
            project: vec![],
        };
        let r = w.resolve(&host(
            "web${n}.${dom}.com",
            "22${n}",
            "u$$x",
            AuthMethod::Agent,
        ));
        assert_eq!(r.hostname.as_deref(), Some("web2.example.com"));
        assert_eq!(r.port, Some(222));
        assert_eq!(r.username.as_deref(), Some("u$x"));
    }

    #[test]
    fn values_are_not_resolved_recursively() {
        let w = World {
            global: vec![plain("a", "${b}"), plain("b", "x")],
            project: vec![],
        };
        let r = w.resolve(&host("h", "22", "${a}", AuthMethod::Agent));
        assert_eq!(r.username.as_deref(), Some("${b}"));
    }

    #[test]
    fn missing_variables_are_listed_once_in_order() {
        let w = World {
            global: vec![],
            project: vec![],
        };
        let r = w.resolve(&host(
            "${host}.${zone}",
            "${port}",
            "${host}",
            AuthMethod::Password {
                password: Some("${pw}".into()),
            },
        ));
        assert_eq!(r.missing, vec!["host", "zone", "port", "pw"]);
        assert_eq!((&r.hostname, r.port, &r.username), (&None, None, &None));
        assert_eq!(
            r.clone().complete().unwrap_err().to_string(),
            "missing variables: host, zone, port, pw"
        );
        assert!(matches!(r.complete(), Err(ResolveError::Missing(_))));
    }

    #[test]
    fn port_must_resolve_to_a_valid_port() {
        for bad in ["0", "65536", "-1", "", "2 2", "+22", "0x16", "99999999"] {
            let w = World {
                global: vec![plain("port", bad)],
                project: vec![],
            };
            let r = w.resolve(&host("h", "${port}", "u", AuthMethod::Agent));
            assert_eq!(r.port, None, "{bad}");
            assert_eq!(messages(&r), vec!["port must be between 1 and 65535"]);
            assert_eq!(r.errors[0].key, Some("errors.config.portRange"));
        }
        let w = World {
            global: vec![plain("port", "65535")],
            project: vec![],
        };
        assert_eq!(
            w.resolve(&host("h", "${port}", "u", AuthMethod::Agent))
                .port,
            Some(65535)
        );
    }

    #[test]
    fn resolved_values_are_validated_without_quoting_them() {
        let w = World {
            global: vec![plain("h", "a b"), plain("k", "relative/key")],
            project: vec![],
        };
        let r = w.resolve(&host(
            "${h}",
            "22",
            "u",
            AuthMethod::Key {
                key_path: "${k}".into(),
                passphrase: None,
            },
        ));
        assert_eq!(r.hostname, None);
        assert_eq!(r.key_path, None);
        assert_eq!(r.errors.len(), 2);
        assert!(
            r.errors
                .iter()
                .all(|e| !e.message.contains("a b") && !e.message.contains("relative"))
        );
        assert!(matches!(r.complete(), Err(ResolveError::Invalid(_))));
    }

    #[test]
    fn secret_variable_in_a_plain_field_is_an_error() {
        let w = world();
        let r = w.resolve(&host("${pw}", "22", "${pw}", AuthMethod::Agent));
        assert_eq!(r.hostname, None);
        assert_eq!(r.username, None);
        assert_eq!(
            messages(&r),
            vec!["secret variable pw used in a non-secret field"]
        );
        let err = r.complete().unwrap_err();
        assert_eq!(
            err.to_string(),
            "secret variable pw used in a non-secret field"
        );
        let text = err.text();
        assert_eq!(text.key, Some("errors.config.secretInPlainField"));
        assert_eq!(text.params["name"], "pw");
    }

    #[test]
    fn misuse_depends_on_the_winning_layer() {
        let w = World {
            global: vec![plain("x", "u")],
            project: vec![secret("x")],
        };
        let h = host("h", "22", "${x}", AuthMethod::Agent);
        assert_eq!(w.resolve(&h).errors.len(), 1);
        let without_project = World {
            project: vec![],
            ..w
        };
        assert_eq!(without_project.resolve(&h).username.as_deref(), Some("u"));
    }

    #[test]
    fn plain_variable_in_a_secret_field_is_an_error() {
        let w = world();
        let r = w.resolve(&templated(AuthMethod::Password {
            password: Some("${user}".into()),
        }));
        assert_eq!(
            messages(&r),
            vec!["plain variable user used in a secret field"]
        );
        assert!(r.complete().is_err());
    }

    #[test]
    fn secret_fields_resolve_to_a_reference_never_a_value() {
        let w = world();
        let r = w.resolve(&templated(AuthMethod::Password {
            password: Some("${pw}".into()),
        }));
        let resolved = r.complete().unwrap();
        assert_eq!(
            resolved.auth,
            ResolvedAuth::Password {
                password: Some(SecretRef {
                    level: Level::Project("p".into()),
                    name: "pw".into()
                })
            }
        );
        let r = w.resolve(&templated(AuthMethod::Password { password: None }));
        assert_eq!(
            r.complete().unwrap().auth,
            ResolvedAuth::Password { password: None }
        );
    }

    #[test]
    fn secret_field_must_be_a_single_reference() {
        let w = world();
        for bad in ["hunter2", "${pw}x", "${pw}${pw}"] {
            let r = w.resolve(&templated(AuthMethod::Password {
                password: Some(bad.into()),
            }));
            assert_eq!(r.errors.len(), 1, "{bad}");
            assert!(!r.errors[0].message.contains("hunter2"));
            assert!(
                !serde_json::to_string(&r.errors)
                    .unwrap()
                    .contains("hunter2")
            );
        }
    }

    #[test]
    fn key_auth_resolves_the_path_and_passphrase_reference() {
        let w = World {
            global: vec![plain("keys", "~/.ssh"), secret("pp")],
            project: vec![],
        };
        let r = w.resolve(&host(
            "h",
            "22",
            "u",
            AuthMethod::Key {
                key_path: "${keys}/id_ed25519".into(),
                passphrase: Some("${pp}".into()),
            },
        ));
        assert_eq!(r.key_path.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_eq!(
            r.complete().unwrap().auth,
            ResolvedAuth::Key {
                key_path: "~/.ssh/id_ed25519".into(),
                passphrase: Some(SecretRef {
                    level: Level::Global,
                    name: "pp".into()
                })
            }
        );
    }

    #[test]
    fn malformed_template_is_an_error() {
        let w = world();
        let r = w.resolve(&host("${host", "22", "u", AuthMethod::Agent));
        assert_eq!(r.errors.len(), 1);
        assert!(r.errors[0].message.starts_with("hostname "));
        assert_eq!(r.errors[0].key, Some("errors.config.templateMalformed"));
        assert_eq!(r.errors[0].params["field"], "hostname");
        let r = w.resolve(&host(
            "h",
            "22",
            "u",
            AuthMethod::Key {
                key_path: "${k".into(),
                passphrase: None,
            },
        ));
        assert_eq!(r.errors[0].key, Some("errors.config.keyPathMalformed"));
        assert!(
            r.errors[0]
                .message
                .starts_with("key path has a malformed ${...}")
        );
    }

    #[test]
    fn errors_carry_keys_and_params() {
        let missing = ResolveError::Missing(vec!["a".into(), "b".into()]).text();
        assert_eq!(missing.key, Some("errors.config.missingVariables"));
        assert_eq!(missing.params["names"], "a, b");
        assert_eq!(missing.message, "missing variables: a, b");

        let w = World {
            global: vec![plain("h", "a b"), plain("p", "0")],
            project: vec![],
        };
        let err = w
            .resolve(&host("${h}", "${p}", "u", AuthMethod::Agent))
            .complete()
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "hostname must not contain whitespace or control characters; port must be between 1 and 65535"
        );
        let text = err.text();
        assert_eq!(text.key, Some("errors.config.invalidFields"));
        assert_eq!(text.message, err.to_string());
        let list = text.params["errors"].as_array().unwrap();
        assert_eq!(list[0]["key"], "errors.config.fieldWhitespace");
        assert_eq!(list[0]["params"]["field"], "hostname");
        assert_eq!(list[1]["key"], "errors.config.portRange");
        assert_eq!(list[1]["params"]["max"], 65535);
    }
}
