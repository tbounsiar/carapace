use tauri::State;

use super::error::CommandError;
use crate::analytics::{Analytics, AnalyticsState, Auth, Counts, Recent, Theme};
use crate::config::model::AuthMethod;
use crate::config::{ConfigFile, ConfigStore};

type Res<T> = Result<T, CommandError>;

pub const PRIVACY_URL: &str = "https://github.com/tbounsiar/carapace/blob/main/PRIVACY.md";

pub fn auth_of(auth: &AuthMethod) -> Auth {
    match auth {
        AuthMethod::Password { .. } => Auth::Password,
        AuthMethod::Key { .. } => Auth::Key,
        AuthMethod::Agent => Auth::Agent,
    }
}

pub fn counts_of(cfg: &ConfigFile) -> Counts {
    Counts {
        hosts: cfg.nodes.iter().filter(|n| n.as_host().is_some()).count(),
        projects: cfg.projects.len(),
        keys: cfg.keys.len(),
    }
}

/// Read when the event is built; an unreadable config counts as empty.
pub fn counts(store: &ConfigStore) -> Counts {
    store.snapshot().map(|c| counts_of(&c)).unwrap_or(Counts {
        hosts: 0,
        projects: 0,
        keys: 0,
    })
}

pub(crate) fn set_consent(
    store: &ConfigStore,
    analytics: &Analytics,
    granted: bool,
) -> Res<AnalyticsState> {
    analytics
        .set_consent(granted, |v| store.set_analytics(v), || counts(store))
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn analytics_state(analytics: State<'_, Analytics>) -> AnalyticsState {
    analytics.status()
}

#[tauri::command]
pub async fn set_analytics_consent(
    store: State<'_, ConfigStore>,
    analytics: State<'_, Analytics>,
    granted: bool,
) -> Res<AnalyticsState> {
    set_consent(&store, &analytics, granted)
}

#[tauri::command]
pub fn analytics_recent(analytics: State<'_, Analytics>) -> Recent {
    analytics.recent()
}

#[tauri::command]
pub async fn analytics_app_started(
    store: State<'_, ConfigStore>,
    analytics: State<'_, Analytics>,
    theme: Theme,
) -> Res<()> {
    analytics.app_started(theme, || counts(&store));
    Ok(())
}

/// Opens the fixed privacy page in the system browser; the webview never navigates there.
#[tauri::command]
pub async fn open_privacy_page() -> Res<()> {
    tauri::async_runtime::spawn_blocking(|| open::that_detached(PRIVACY_URL))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| CommandError::new("io", "the browser could not be opened"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::{CATALOGUE_VERSION, SystemProps};
    use crate::config::{AnalyticsConsent, Consent};

    fn system() -> SystemProps {
        SystemProps {
            app_version: "0".into(),
            os: "os".into(),
            os_version: "1".into(),
            locale: String::new(),
        }
    }

    fn stored(store: &ConfigStore) -> Option<AnalyticsConsent> {
        store.snapshot().unwrap().analytics
    }

    #[test]
    fn missing_or_unknown_consent_is_unset() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        let store = ConfigStore::new(dir.path().to_path_buf());
        std::fs::write(&file, r#"{"version":3}"#).unwrap();
        assert_eq!(stored(&store), None);
        for odd in [
            r#""granted""#,
            r#"{"consent":"yes","catalogueVersion":1}"#,
            r#"{"consent":"granted"}"#,
            r#"{"consent":"granted","catalogueVersion":-1}"#,
            "null",
        ] {
            std::fs::write(&file, format!(r#"{{"version":3,"analytics":{odd}}}"#)).unwrap();
            assert_eq!(stored(&store), None, "{odd}");
        }
        std::fs::write(
            &file,
            r#"{"version":3,"analytics":{"consent":"denied","catalogueVersion":1}}"#,
        )
        .unwrap();
        assert_eq!(
            stored(&store),
            Some(AnalyticsConsent {
                consent: Consent::Denied,
                catalogue_version: 1
            })
        );
    }

    #[test]
    fn consent_is_saved_in_the_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        store.create_project("p").unwrap();
        let analytics = Analytics::new(None, system(), None);
        let s = set_consent(&store, &analytics, true).unwrap();
        assert_eq!(
            (s.consent, s.ask_needed, s.available),
            (Consent::Granted, false, false)
        );
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("config.json")).unwrap())
                .unwrap();
        assert_eq!(
            raw["analytics"],
            serde_json::json!({"consent": "granted", "catalogueVersion": CATALOGUE_VERSION})
        );
        assert_eq!(raw["version"], 3);
        let names: Vec<_> = analytics.recent().events.iter().map(|e| e.name).collect();
        assert_eq!(names, ["consent_granted"]);
        analytics.app_started(Theme::Dark, || counts(&store));
        let props = serde_json::to_value(&analytics.recent().events[0].props).unwrap();
        assert_eq!(
            props,
            serde_json::json!({"theme": "dark", "hosts": "0", "projects": "1", "keys": "0"})
        );

        set_consent(&store, &analytics, false).unwrap();
        assert_eq!(stored(&store).unwrap().consent, Consent::Denied);
        assert!(analytics.recent().events.is_empty());
        let reloaded = Analytics::new(stored(&store), system(), None);
        assert_eq!(reloaded.status().consent, Consent::Denied);
        assert!(!reloaded.status().ask_needed);
    }

    #[test]
    fn a_config_without_the_field_is_written_without_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        store.create_project("p").unwrap();
        let raw = std::fs::read_to_string(dir.path().join("config.json")).unwrap();
        assert!(!raw.contains("analytics"));
    }

    #[test]
    fn a_corrupt_config_refuses_the_grant() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{").unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let analytics = Analytics::new(None, system(), None);
        let e = set_consent(&store, &analytics, true).unwrap_err();
        assert_eq!(e.code, "corrupt_config");
        assert_eq!(analytics.status().consent, Consent::Unset);
        assert!(analytics.recent().events.is_empty());
    }

    #[test]
    fn counts_come_from_the_config() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        assert_eq!(
            counts(&store),
            Counts {
                hosts: 0,
                projects: 0,
                keys: 0
            }
        );
        std::fs::write(dir.path().join("config.json"), "{").unwrap();
        assert_eq!(counts(&store).hosts, 0);
    }

    #[test]
    fn auth_kinds_map() {
        assert_eq!(auth_of(&AuthMethod::Agent), Auth::Agent);
        assert_eq!(
            auth_of(&AuthMethod::Password { password: None }),
            Auth::Password
        );
        assert_eq!(
            auth_of(&AuthMethod::Key {
                key_path: "~/k".into(),
                passphrase: None
            }),
            Auth::Key
        );
    }

    #[test]
    fn privacy_url_is_fixed_https() {
        assert!(PRIVACY_URL.starts_with("https://github.com/tbounsiar/carapace/"));
    }
}
