mod home;
mod migrate;
pub(crate) mod model;
mod settings;
mod store;
pub(crate) mod validate;

pub use home::resolve_home;
#[cfg(test)]
pub use migrate::LegacyEnvironment;
pub use migrate::{LegacyProject, MigrationPlan};
pub use model::{
    AnalyticsSettings, Category, CategoryChoice, CategoryChoices, ConfigFile, Consent, EditorMode,
    ExternalEditor, Host, HostInput, KeyAlgorithm, KeyEntry, KeyOrigin, Node, Project, Variable,
    VariableKind, VariableScope,
};
pub use settings::{
    DEFAULT_FONT_SIZE, FONT_SIZE_MAX, FONT_SIZE_MIN, KeyType, Language, Settings, SettingsPatch,
    ThemeMode, check_key_folder, is_font_size,
};
pub(crate) use store::same_path;
pub use store::{ConfigError, ConfigStore, Held, KeychainMigration, Moved, Revision};
pub(crate) use validate::is_local_absolute;
