use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::error::CommandError;
use crate::config::{
    ConfigStore, DEFAULT_FONT_SIZE, KeyType, Settings, SettingsPatch, ThemeMode, check_key_folder,
    is_font_size,
};

type Res<T> = Result<T, CommandError>;

/// The user preferences with their defaults filled in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: ThemeMode,
    pub default_key_type: KeyType,
    pub terminal_font_size: u8,
    pub key_folder: Option<String>,
}

impl From<Settings> for AppSettings {
    fn from(s: Settings) -> Self {
        Self {
            theme: s.theme.unwrap_or_default(),
            default_key_type: s.default_key_type.unwrap_or_default(),
            terminal_font_size: s.terminal_font_size.unwrap_or(DEFAULT_FONT_SIZE),
            key_folder: s.key_folder,
        }
    }
}

fn invalid(message: &str) -> CommandError {
    CommandError::new("invalid_input", message)
}

/// `{ theme?, defaultKeyType?, terminalFontSize?, keyFolder?: string | null }`. An unknown field
/// is always refused. `skip_invalid` drops a bad value instead of refusing the call: the
/// one-time import must not fail forever on a stale value the webview kept.
pub(crate) fn parse_patch(value: &Value, skip_invalid: bool) -> Res<SettingsPatch> {
    let map = value
        .as_object()
        .ok_or_else(|| invalid("the settings must be an object"))?;
    let mut patch = SettingsPatch::default();
    for (key, v) in map {
        let parsed = match key.as_str() {
            "theme" => v
                .as_str()
                .and_then(ThemeMode::from_name)
                .map(|t| patch.theme = Some(t))
                .ok_or_else(|| invalid("theme must be system, light or dark")),
            "defaultKeyType" => v
                .as_str()
                .and_then(KeyType::from_name)
                .map(|k| patch.default_key_type = Some(k))
                .ok_or_else(|| invalid("defaultKeyType must be ed25519 or rsa4096")),
            "terminalFontSize" => v
                .as_i64()
                .filter(|&n| is_font_size(n))
                .and_then(|n| u8::try_from(n).ok())
                .map(|n| patch.terminal_font_size = Some(n))
                .ok_or_else(|| invalid("terminalFontSize must be a whole number from 10 to 24")),
            "keyFolder" => match v {
                Value::Null => {
                    patch.key_folder = Some(None);
                    Ok(())
                }
                Value::String(s) => check_key_folder(s)
                    .map(|()| patch.key_folder = Some(Some(s.clone())))
                    .map_err(CommandError::from),
                _ => Err(invalid("keyFolder must be a path or null")),
            },
            _ => return Err(invalid("unknown setting")),
        };
        if let Err(e) = parsed
            && !skip_invalid
        {
            return Err(e);
        }
    }
    Ok(patch)
}

pub(crate) fn settings_in(store: &ConfigStore) -> Res<AppSettings> {
    Ok(store.settings()?.into())
}

pub(crate) fn update_in(store: &ConfigStore, patch: &Value) -> Res<AppSettings> {
    let patch = parse_patch(patch, false)?;
    Ok(store.update_settings(&patch)?.into())
}

pub(crate) fn import_in(store: &ConfigStore, values: &Value) -> Res<AppSettings> {
    let values = parse_patch(values, true)?;
    Ok(store.import_legacy_settings(&values)?.into())
}

/// `corrupt_config` when `settings.toml` is not TOML: the frontend then uses the defaults, and
/// the file is replaced (after a backup) by the next change.
#[tauri::command]
pub async fn app_settings(store: State<'_, ConfigStore>) -> Res<AppSettings> {
    settings_in(&store)
}

#[tauri::command]
pub async fn update_app_settings(store: State<'_, ConfigStore>, patch: Value) -> Res<AppSettings> {
    update_in(&store, &patch)
}

#[tauri::command]
pub async fn import_legacy_settings(
    store: State<'_, ConfigStore>,
    values: Value,
) -> Res<AppSettings> {
    import_in(&store, &values)
}

#[cfg(test)]
mod tests;
