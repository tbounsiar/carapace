//! The event catalogue. Every property value is a `&'static str` taken from an enum below or a
//! bool, so no name, path, address, message or exact number can reach an event.

use std::time::Duration;

use serde::ser::{Serialize, SerializeMap, Serializer};

pub use crate::config::Category;

/// Stamped on every answer. Bump it with the `changed_in` of each category that gains a new
/// kind of data; dropping data bumps nothing.
pub const CATALOGUE_VERSION: u32 = 2;

/// A `granted` answer older than this is asked again, for that category only.
pub fn changed_in(category: Category) -> u32 {
    match category {
        Category::Launch => 2,
        Category::Features => 1,
        Category::Connections => 1,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prop {
    Str(&'static str),
    Bool(bool),
}

impl Serialize for Prop {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Prop::Str(v) => s.serialize_str(v),
            Prop::Bool(v) => s.serialize_bool(*v),
        }
    }
}

/// Properties in catalogue order, serialized as a JSON object.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Props(pub Vec<(&'static str, Prop)>);

impl Serialize for Props {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

macro_rules! str_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($variant),+ }

        impl $name {
            #[allow(dead_code)]
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
        }
    };
}

str_enum!(
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "lowercase")]
    Theme { Light => "light", Dark => "dark", System => "system" }
);
str_enum!(Auth { Password => "password", Key => "key", Agent => "agent" });
str_enum!(Count {
    Zero => "0",
    One => "1",
    Few => "2-5",
    Some => "6-20",
    Many => "21-50",
    Lots => "51+",
});
str_enum!(Files { One => "1", Few => "2-10", Many => "11-100", Lots => "101+" });
str_enum!(Took { UnderOne => "<1s", OneToThree => "1-3s", ThreeToTen => "3-10s", Long => "10s+" });
str_enum!(TestResult { Success => "success", Failure => "failure", Cancelled => "cancelled" });
str_enum!(TransferDirection { Upload => "upload", Download => "download" });
str_enum!(Outcome { Done => "done", Failed => "failed", Cancelled => "cancelled" });
str_enum!(GeneratedType { Ed25519 => "ed25519", Rsa4096 => "rsa4096" });
str_enum!(ImportedType { Ed25519 => "ed25519", Rsa => "rsa", Ecdsa => "ecdsa", Other => "other" });
str_enum!(Scope { Global => "global", Project => "project" });
str_enum!(
    /// The frontend's `IpcErrorCode`: every `CommandError` code, plus `unknown`.
    ErrorCode {
        NotFound => "not_found",
        InvalidInput => "invalid_input",
        Conflict => "conflict",
        Io => "io",
        CorruptConfig => "corrupt_config",
        HostKeyRejected => "host_key_rejected",
        AuthFailed => "auth_failed",
        Unsupported => "unsupported",
        Timeout => "timeout",
        Network => "network",
        HostKeyChanged => "host_key_changed",
        HostKeyRevoked => "host_key_revoked",
        SecretRequired => "secret_required",
        InvalidPassphrase => "invalid_passphrase",
        KeychainUnavailable => "keychain_unavailable",
        NotConnected => "not_connected",
        Busy => "busy",
        PermissionDenied => "permission_denied",
        AlreadyExists => "already_exists",
        NotEmpty => "not_empty",
        TooLarge => "too_large",
        MissingVariables => "missing_variables",
        Cancelled => "cancelled",
        Unknown => "unknown",
    }
);

impl ErrorCode {
    pub fn from_code(code: &str) -> Self {
        Self::ALL
            .iter()
            .copied()
            .find(|c| *c != Self::Unknown && c.as_str() == code)
            .unwrap_or(Self::Unknown)
    }
}

impl Count {
    pub fn of(n: usize) -> Self {
        match n {
            0 => Self::Zero,
            1 => Self::One,
            2..=5 => Self::Few,
            6..=20 => Self::Some,
            21..=50 => Self::Many,
            _ => Self::Lots,
        }
    }
}

impl Files {
    /// Zero counts as one: a job always names at least one source.
    pub fn of(n: u64) -> Self {
        match n {
            0 | 1 => Self::One,
            2..=10 => Self::Few,
            11..=100 => Self::Many,
            _ => Self::Lots,
        }
    }
}

impl Took {
    pub fn of(d: Duration) -> Self {
        match d.as_millis() {
            0..1000 => Self::UnderOne,
            1000..3000 => Self::OneToThree,
            3000..10_000 => Self::ThreeToTen,
            _ => Self::Long,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub hosts: usize,
    pub projects: usize,
    pub keys: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    AppStarted {
        theme: Theme,
        hosts: Count,
        projects: Count,
        keys: Count,
    },
    SessionStarted,
    HostCreated {
        auth: Auth,
    },
    ConnectSucceeded {
        auth: Auth,
        duration: Took,
    },
    ConnectFailed {
        auth: Auth,
        code: ErrorCode,
    },
    /// `code` is sent only with `Failure`.
    HostTestRun {
        result: TestResult,
        code: Option<ErrorCode>,
    },
    TerminalOpened,
    FilesOpened,
    TransferFinished {
        direction: TransferDirection,
        outcome: Outcome,
        files: Files,
    },
    KeyGenerated {
        key_type: GeneratedType,
        custom_folder: bool,
    },
    KeyImported {
        key_type: ImportedType,
    },
    VariablesSaved {
        scope: Scope,
        count: Count,
    },
}

impl Event {
    pub fn app_started(theme: Theme, counts: Counts) -> Self {
        Self::AppStarted {
            theme,
            hosts: Count::of(counts.hosts),
            projects: Count::of(counts.projects),
            keys: Count::of(counts.keys),
        }
    }

    pub fn test_failed(code: ErrorCode) -> Self {
        Self::HostTestRun {
            result: TestResult::Failure,
            code: Some(code),
        }
    }

    pub fn test_ended(result: TestResult) -> Self {
        Self::HostTestRun { result, code: None }
    }

    pub fn category(&self) -> Category {
        match self {
            Self::SessionStarted => Category::Launch,
            Self::AppStarted { .. }
            | Self::HostCreated { .. }
            | Self::TerminalOpened
            | Self::FilesOpened
            | Self::TransferFinished { .. }
            | Self::KeyGenerated { .. }
            | Self::KeyImported { .. }
            | Self::VariablesSaved { .. } => Category::Features,
            Self::ConnectSucceeded { .. }
            | Self::ConnectFailed { .. }
            | Self::HostTestRun { .. } => Category::Connections,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::AppStarted { .. } => "app_started",
            Self::SessionStarted => "session_started",
            Self::HostCreated { .. } => "host_created",
            Self::ConnectSucceeded { .. } => "connect_succeeded",
            Self::ConnectFailed { .. } => "connect_failed",
            Self::HostTestRun { .. } => "host_test_run",
            Self::TerminalOpened => "terminal_opened",
            Self::FilesOpened => "files_opened",
            Self::TransferFinished { .. } => "transfer_finished",
            Self::KeyGenerated { .. } => "key_generated",
            Self::KeyImported { .. } => "key_imported",
            Self::VariablesSaved { .. } => "variables_saved",
        }
    }

    pub fn props(&self) -> Props {
        let s = Prop::Str;
        Props(match *self {
            Self::AppStarted {
                theme,
                hosts,
                projects,
                keys,
            } => vec![
                ("theme", s(theme.as_str())),
                ("hosts", s(hosts.as_str())),
                ("projects", s(projects.as_str())),
                ("keys", s(keys.as_str())),
            ],
            Self::SessionStarted | Self::TerminalOpened | Self::FilesOpened => Vec::new(),
            Self::HostCreated { auth } => vec![("auth", s(auth.as_str()))],
            Self::ConnectSucceeded { auth, duration } => vec![
                ("auth", s(auth.as_str())),
                ("duration", s(duration.as_str())),
            ],
            Self::ConnectFailed { auth, code } => {
                vec![("auth", s(auth.as_str())), ("code", s(code.as_str()))]
            }
            Self::HostTestRun { result, code } => {
                let mut props = vec![("result", s(result.as_str()))];
                if let (TestResult::Failure, Some(code)) = (result, code) {
                    props.push(("code", s(code.as_str())));
                }
                props
            }
            Self::TransferFinished {
                direction,
                outcome,
                files,
            } => vec![
                ("direction", s(direction.as_str())),
                ("outcome", s(outcome.as_str())),
                ("files", s(files.as_str())),
            ],
            Self::KeyGenerated {
                key_type,
                custom_folder,
            } => vec![
                ("type", s(key_type.as_str())),
                ("custom_folder", Prop::Bool(custom_folder)),
            ],
            Self::KeyImported { key_type } => vec![("type", s(key_type.as_str()))],
            Self::VariablesSaved { scope, count } => {
                vec![("scope", s(scope.as_str())), ("count", s(count.as_str()))]
            }
        })
    }
}
