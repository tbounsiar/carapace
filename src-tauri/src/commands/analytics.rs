use tauri::State;

use super::error::CommandError;
use crate::analytics::{
    Analytics, AnalyticsChoices, AnalyticsState, Auth, Category, Counts, Recent, Theme,
};
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

/// The dialog answers for all four categories, so it is refused while the stored choices are
/// unknown: it could only have been built without them, and saving it would overwrite answers
/// the user never saw. The file is read again instead.
pub(crate) fn set_choices(
    store: &ConfigStore,
    analytics: &Analytics,
    choices: AnalyticsChoices,
) -> Res<AnalyticsState> {
    if analytics.is_unread() {
        let stored = store.analytics()?;
        analytics.reload(|| Ok::<_, ()>(stored));
        return Err(CommandError::new(
            "conflict",
            "the analytics choices were not known; check them again",
        ));
    }
    analytics
        .set_choices(choices, |w| store.update_analytics(w), || counts(store))
        .map_err(CommandError::from)
}

pub(crate) fn set_category(
    store: &ConfigStore,
    analytics: &Analytics,
    category: Category,
    granted: bool,
) -> Res<AnalyticsState> {
    analytics
        .set_category(
            category,
            granted,
            |w| store.update_analytics(w),
            || counts(store),
        )
        .map_err(CommandError::from)
}

/// While the startup read of the choices has not succeeded, each call tries again.
pub(crate) fn state_of(store: &ConfigStore, analytics: &Analytics) -> AnalyticsState {
    analytics.reload(|| store.analytics());
    analytics.status()
}

#[tauri::command]
pub async fn analytics_state(
    store: State<'_, ConfigStore>,
    analytics: State<'_, Analytics>,
) -> Res<AnalyticsState> {
    Ok(state_of(&store, &analytics))
}

/// The first-launch dialog: all four categories in one write.
#[tauri::command]
pub async fn set_analytics_choices(
    store: State<'_, ConfigStore>,
    analytics: State<'_, Analytics>,
    choices: AnalyticsChoices,
) -> Res<AnalyticsState> {
    set_choices(&store, &analytics, choices)
}

/// Settings: that category only, so a pending one is not stamped as answered.
#[tauri::command]
pub async fn set_analytics_category(
    store: State<'_, ConfigStore>,
    analytics: State<'_, Analytics>,
    category: Category,
    granted: bool,
) -> Res<AnalyticsState> {
    set_category(&store, &analytics, category, granted)
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
    use crate::analytics::SystemProps;
    use crate::config::{AnalyticsSettings, CategoryChoice, CategoryChoices, Consent};

    fn system() -> SystemProps {
        SystemProps {
            app_version: "0".into(),
            os: "os".into(),
            os_version: "1".into(),
            locale: String::new(),
        }
    }

    fn stored(store: &ConfigStore) -> Option<AnalyticsSettings> {
        store.analytics().unwrap()
    }

    /// `settings.toml` as JSON.
    fn raw(dir: &std::path::Path) -> serde_json::Value {
        let text = std::fs::read_to_string(dir.join("settings.toml")).unwrap();
        serde_json::to_value(text.parse::<toml::Table>().unwrap()).unwrap()
    }

    fn all(consent: Consent, version: u32) -> Option<AnalyticsSettings> {
        Some(AnalyticsSettings {
            categories: CategoryChoices::all(CategoryChoice { consent, version }),
        })
    }

    /// The first release's grant: the three categories it covered, crash reports unset.
    fn v1_granted() -> Option<AnalyticsSettings> {
        let mut s = all(Consent::Granted, 2)?;
        s.categories.crashes = CategoryChoice::default();
        Some(s)
    }

    fn read(analytics: &str) -> Option<AnalyticsSettings> {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            format!(r#"{{"version":3,"analytics":{analytics}}}"#),
        )
        .unwrap();
        stored(&ConfigStore::new(dir.path().to_path_buf()))
    }

    #[test]
    fn the_first_release_consent_is_migrated() {
        let cases = [
            (
                r#"{"consent":"granted","catalogueVersion":1}"#,
                v1_granted(),
            ),
            (
                r#"{"consent":"granted","catalogueVersion":7}"#,
                v1_granted(),
            ),
            (
                r#"{"consent":"denied","catalogueVersion":1}"#,
                all(Consent::Denied, 2),
            ),
            (
                r#"{"consent":"denied","catalogueVersion":0}"#,
                all(Consent::Denied, 2),
            ),
            (r#"{"consent":"unset","catalogueVersion":1}"#, None),
            // Asked again by the first release, so never in effect.
            (r#"{"consent":"granted","catalogueVersion":0}"#, None),
            (r#"{"consent":"granted"}"#, None),
            (r#"{"consent":"yes","catalogueVersion":1}"#, None),
            (r#"{"consent":"granted","catalogueVersion":-1}"#, None),
            (r#""granted""#, None),
            ("null", None),
            ("[]", None),
        ];
        for (v1, expected) in cases {
            assert_eq!(read(v1), expected, "{v1}");
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), r#"{"version":3}"#).unwrap();
        assert_eq!(stored(&ConfigStore::new(dir.path().to_path_buf())), None);
    }

    #[test]
    fn a_migrated_grant_asks_only_about_crash_reports_and_starts_the_session() {
        let a = Analytics::new(
            read(r#"{"consent":"granted","catalogueVersion":1}"#),
            system(),
            None,
            false,
        );
        a.launched();
        let s = a.status();
        assert!(s.ask_needed);
        assert_eq!(s.pending, [Category::Crashes]);
        assert!(!s.categories.crashes);
        assert_eq!(a.recorded(), [("session_started", serde_json::json!({}))]);
        let a = Analytics::new(
            read(r#"{"consent":"denied","catalogueVersion":1}"#),
            system(),
            None,
            false,
        );
        a.launched();
        assert!(!a.status().ask_needed);
        assert!(a.recorded().is_empty());
    }

    /// What each earlier answer becomes once crash reports exist. The frontend starts the
    /// crash switch off when the three other categories are stored denied (all false, none
    /// pending); everyone else sees it on.
    #[test]
    fn earlier_answers_ask_about_crash_reports_once() {
        let v2 = |l: &str, f: &str, c: &str| {
            let cat = |consent: &str| format!(r#"{{"consent":"{consent}","version":2}}"#);
            format!(
                r#"{{"categories":{{"launch":{},"features":{},"connections":{}}}}}"#,
                cat(l),
                cat(f),
                cat(c)
            )
        };
        let cases: Vec<(String, AnalyticsChoices, Vec<Category>)> = vec![
            (
                v2("granted", "granted", "granted"),
                AnalyticsChoices {
                    launch: true,
                    features: true,
                    connections: true,
                    crashes: false,
                },
                vec![Category::Crashes],
            ),
            (
                v2("denied", "denied", "denied"),
                AnalyticsChoices::default(),
                vec![Category::Crashes],
            ),
            (
                v2("granted", "denied", "granted"),
                AnalyticsChoices {
                    launch: true,
                    features: false,
                    connections: true,
                    crashes: false,
                },
                vec![Category::Crashes],
            ),
            (
                r#"{"consent":"granted","catalogueVersion":1}"#.into(),
                AnalyticsChoices {
                    launch: true,
                    features: true,
                    connections: true,
                    crashes: false,
                },
                vec![Category::Crashes],
            ),
            // A first-release refusal covers crash reports too: nothing is asked.
            (
                r#"{"consent":"denied","catalogueVersion":1}"#.into(),
                AnalyticsChoices::default(),
                vec![],
            ),
            (
                r#"{"consent":"unset","catalogueVersion":1}"#.into(),
                AnalyticsChoices::default(),
                Category::ALL.to_vec(),
            ),
        ];
        for (file, categories, pending) in cases {
            let s = Analytics::new(read(&file), system(), None, false).status();
            assert_eq!(s.categories, categories, "{file}");
            assert_eq!(s.pending, pending, "{file}");
            assert_eq!(s.ask_needed, !pending.is_empty(), "{file}");
        }
        let denied = read(r#"{"consent":"denied","catalogueVersion":1}"#).unwrap();
        assert_eq!(denied.categories.crashes.consent, Consent::Denied);
        // DO_NOT_TRACK: never asked, whatever is pending.
        let s = Analytics::new(
            read(&v2("granted", "granted", "granted")),
            system(),
            None,
            true,
        )
        .status();
        assert!(!s.ask_needed && s.pending == [Category::Crashes]);
    }

    #[test]
    fn the_crash_answer_is_stored_on_its_own() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.toml"),
            "[analytics.launch]\nconsent = \"granted\"\nversion = 2\n",
        )
        .unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let analytics = Analytics::new(stored(&store), system(), None, false);
        let s = set_category(&store, &analytics, Category::Crashes, false).unwrap();
        assert!(s.pending.contains(&Category::Features) && !s.pending.contains(&Category::Crashes));
        assert_eq!(
            raw(dir.path())["analytics"],
            serde_json::json!({
                "launch": {"consent": "granted", "version": 2},
                "crashes": {"consent": "denied", "version": 3},
            })
        );
    }

    #[test]
    fn categories_are_read_one_by_one_and_unknown_shapes_are_unset() {
        let granted = CategoryChoice {
            consent: Consent::Granted,
            version: 2,
        };
        let s = read(
            r#"{"categories":{
                "launch":{"consent":"granted","version":2},
                "features":{"consent":"granted","version":-1},
                "connections":{"consent":"maybe","version":2},
                "extra":{"consent":"granted","version":2}
            }}"#,
        )
        .unwrap()
        .categories;
        assert_eq!(s.launch, granted);
        assert!(s.features.is_unset() && s.connections.is_unset());
        for odd in [
            r#"{"categories":{"launch":true,"features":"granted","connections":[]}}"#,
            r#"{"categories":{"launch":{"consent":"granted"}}}"#,
            r#"{"categories":{}}"#,
        ] {
            // No category set: nothing is written to settings.toml, which reads as `None`.
            assert_eq!(
                read(odd).unwrap_or_default().categories,
                CategoryChoices::default(),
                "{odd}"
            );
        }
        for odd in [
            r#"{"categories":true}"#,
            r#"{"categories":null,"consent":"granted","catalogueVersion":1}"#,
        ] {
            assert_eq!(read(odd), None, "{odd}");
        }
        let both = read(
            r#"{"consent":"granted","catalogueVersion":1,"categories":{"launch":{"consent":"denied","version":2}}}"#,
        )
        .unwrap()
        .categories;
        assert_eq!(both.launch.consent, Consent::Denied);
        assert!(both.features.is_unset() && both.connections.is_unset());
    }

    #[test]
    fn choices_are_saved_in_the_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        store.create_project("p").unwrap();
        let analytics = Analytics::new(None, system(), None, false);
        analytics.app_started(Theme::Dark, || counts(&store));
        let s = set_choices(
            &store,
            &analytics,
            AnalyticsChoices {
                launch: true,
                features: true,
                connections: false,
                crashes: false,
            },
        )
        .unwrap();
        assert!(!s.ask_needed && !s.available && s.persisted);
        let file = raw(dir.path());
        assert_eq!(
            file["analytics"],
            serde_json::json!({
                "launch": {"consent": "granted", "version": 3},
                "features": {"consent": "granted", "version": 3},
                "connections": {"consent": "denied", "version": 3},
                "crashes": {"consent": "denied", "version": 3},
            })
        );
        let events = analytics.recorded();
        assert_eq!(events[0], ("session_started", serde_json::json!({})));
        assert_eq!(
            events[1],
            (
                "app_started",
                serde_json::json!({"theme": "dark", "hosts": "0", "projects": "1", "keys": "0"})
            )
        );

        set_category(&store, &analytics, Category::Launch, false).unwrap();
        assert_eq!(
            raw(dir.path())["analytics"]["launch"],
            serde_json::json!({"consent": "denied", "version": 3})
        );
        assert_eq!(
            analytics.recorded().iter().map(|e| e.0).collect::<Vec<_>>(),
            ["app_started"]
        );
        let reloaded = Analytics::new(stored(&store), system(), None, false);
        let s = reloaded.status();
        assert!(!s.categories.launch && s.categories.features && !s.categories.connections);
        assert!(!s.ask_needed);
    }

    #[test]
    fn a_category_change_keeps_a_pending_category_pending() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"version":3,"analytics":{"categories":{"launch":{"consent":"granted","version":1}}}}"#,
        )
        .unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let analytics = Analytics::new(stored(&store), system(), None, false);
        let s = set_category(&store, &analytics, Category::Connections, true).unwrap();
        assert_eq!(
            s.pending,
            [Category::Launch, Category::Features, Category::Crashes]
        );
        assert_eq!(
            raw(dir.path())["analytics"],
            serde_json::json!({
                "launch": {"consent": "granted", "version": 1},
                "connections": {"consent": "granted", "version": 3},
            })
        );
    }

    #[test]
    fn a_first_release_file_is_split_in_the_new_shape() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"version":3,"analytics":{"consent":"granted","catalogueVersion":1}}"#,
        )
        .unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        store.snapshot().unwrap();
        let file = raw(dir.path());
        assert_eq!(
            file["analytics"]["features"],
            serde_json::json!({"consent": "granted", "version": 2})
        );
        assert!(file["analytics"].get("consent").is_none());
        let data = std::fs::read_to_string(dir.path().join("data.json")).unwrap();
        assert!(!data.contains("analytics"));
    }

    #[test]
    fn a_config_without_the_field_is_written_without_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), r#"{"version":3}"#).unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        store.create_project("p").unwrap();
        let raw = std::fs::read_to_string(dir.path().join("settings.toml")).unwrap();
        assert!(!raw.contains("analytics"));
        let raw = std::fs::read_to_string(dir.path().join("data.json")).unwrap();
        assert!(!raw.contains("analytics"));
    }

    #[test]
    fn an_unreadable_settings_file_closes_every_gate_and_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.toml"), "analytics = [").unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let analytics = Analytics::for_app(store.analytics(), "0");
        assert!(analytics.is_unread());
        let s = state_of(&store, &analytics);
        assert!(!s.ask_needed && s.pending.is_empty());
        assert_eq!(s.categories, AnalyticsChoices::default());
        let e = set_category(&store, &analytics, Category::Launch, true).unwrap_err();
        assert_eq!(e.code, "corrupt_config");
        assert!(analytics.recorded().is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("settings.toml")).unwrap(),
            "analytics = ["
        );
        assert!(!dir.path().join("settings.toml.bak").exists());
        // A fixed file is read on the next try.
        std::fs::write(
            dir.path().join("settings.toml"),
            "[analytics.launch]
consent = \"denied\"
version = 2
",
        )
        .unwrap();
        state_of(&store, &analytics);
        assert!(!analytics.is_unread());
    }

    #[test]
    fn a_corrupt_config_refuses_the_grant() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{").unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let analytics = Analytics::new(None, system(), None, false);
        let e = set_category(&store, &analytics, Category::Launch, true).unwrap_err();
        assert_eq!(e.code, "corrupt_config");
        let e = set_choices(
            &store,
            &analytics,
            AnalyticsChoices {
                launch: true,
                features: true,
                connections: true,
                crashes: true,
            },
        )
        .unwrap_err();
        assert_eq!(e.code, "corrupt_config");
        assert_eq!(analytics.status().pending.len(), 4);
        assert!(analytics.recorded().is_empty());
    }

    #[test]
    fn arguments_deserialize_from_the_frontend_shapes() {
        let c: AnalyticsChoices = serde_json::from_str(
            r#"{"launch":true,"features":false,"connections":true,"crashes":true}"#,
        )
        .unwrap();
        assert_eq!(
            c,
            AnalyticsChoices {
                launch: true,
                features: false,
                connections: true,
                crashes: true,
            }
        );
        assert!(serde_json::from_str::<AnalyticsChoices>(r#"{"launch":true}"#).is_err());
        assert!(
            serde_json::from_str::<AnalyticsChoices>(
                r#"{"launch":true,"features":false,"connections":true}"#
            )
            .is_err()
        );
        for (raw, cat) in [
            ("launch", Category::Launch),
            ("features", Category::Features),
            ("connections", Category::Connections),
            ("crashes", Category::Crashes),
        ] {
            assert_eq!(serde_json::from_value::<Category>(raw.into()).unwrap(), cat);
        }
        for odd in ["Launch", "all", "", "crash", "Crashes"] {
            assert!(
                serde_json::from_value::<Category>(odd.into()).is_err(),
                "{odd}"
            );
        }
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

    fn unread_with(dir: &std::path::Path, analytics: &str) -> (ConfigStore, Analytics) {
        std::fs::write(
            dir.join("config.json"),
            format!(r#"{{"version":3,"analytics":{analytics}}}"#),
        )
        .unwrap();
        let store = ConfigStore::new(dir.to_path_buf());
        store.snapshot().unwrap();
        (store, Analytics::new(None, system(), None, false).unread())
    }

    const ALL_DENIED: &str = r#"{"categories":{"launch":{"consent":"denied","version":2},"features":{"consent":"denied","version":2},"connections":{"consent":"denied","version":2},"crashes":{"consent":"denied","version":3}}}"#;

    #[test]
    fn an_unread_startup_never_overwrites_a_stored_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let (store, analytics) = unread_with(dir.path(), ALL_DENIED);
        let before = raw(dir.path());
        let s = analytics.status();
        assert!(!s.ask_needed && s.pending.is_empty());
        let e = set_choices(
            &store,
            &analytics,
            AnalyticsChoices {
                launch: true,
                features: false,
                connections: false,
                crashes: false,
            },
        )
        .unwrap_err();
        assert_eq!(e.code, "conflict");
        assert_eq!(raw(dir.path()), before);
        assert!(analytics.recorded().is_empty());
        let s = analytics.status();
        assert_eq!(
            (s.categories, s.ask_needed),
            (AnalyticsChoices::default(), false)
        );
        assert!(s.pending.is_empty());

        set_category(&store, &analytics, Category::Features, true).unwrap();
        let file = raw(dir.path());
        assert_eq!(
            file["analytics"]["launch"],
            serde_json::json!({"consent": "denied", "version": 2})
        );
        assert_eq!(
            file["analytics"]["connections"],
            serde_json::json!({"consent": "denied", "version": 2})
        );
        assert_eq!(file["analytics"]["features"]["consent"], "granted");
        assert!(analytics.recorded().is_empty());
    }

    #[test]
    fn a_category_change_from_settings_keeps_what_another_category_has_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) = unread_with(
            dir.path(),
            r#"{"categories":{"launch":{"consent":"denied","version":2}}}"#,
        );
        // Started without the file's answers, as after a failed read that was not detected.
        let analytics = Analytics::new(None, system(), None, false);
        set_category(&store, &analytics, Category::Features, true).unwrap();
        let file = raw(dir.path());
        assert_eq!(
            file["analytics"]["launch"],
            serde_json::json!({"consent": "denied", "version": 2})
        );
        assert!(!analytics.status().categories.launch);
    }

    #[test]
    fn a_failed_read_refuses_every_change() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{").unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let analytics = Analytics::new(None, system(), None, false).unread();
        let e = set_category(&store, &analytics, Category::Launch, true).unwrap_err();
        assert_eq!(e.code, "corrupt_config");
        let e = set_choices(
            &store,
            &analytics,
            AnalyticsChoices {
                launch: true,
                features: true,
                connections: true,
                crashes: true,
            },
        )
        .unwrap_err();
        assert_eq!(e.code, "corrupt_config");
        assert_eq!(std::fs::read(dir.path().join("config.json")).unwrap(), b"{");
        assert!(analytics.is_unread());
        assert!(!analytics.status().ask_needed);
    }

    #[test]
    fn the_state_command_reads_again_until_it_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{").unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        let analytics = Analytics::for_app(store.analytics(), "0");
        assert!(analytics.is_unread());
        assert!(!state_of(&store, &analytics).ask_needed);
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"version":3,"analytics":{"consent":"granted","catalogueVersion":1}}"#,
        )
        .unwrap();
        let s = state_of(&store, &analytics);
        assert!(!analytics.is_unread());
        if !s.do_not_track {
            assert_eq!(
                s.categories,
                AnalyticsChoices {
                    launch: true,
                    features: true,
                    connections: true,
                    crashes: false,
                }
            );
            assert_eq!(
                analytics.recorded(),
                [("session_started", serde_json::json!({}))]
            );
        }
    }

    #[test]
    fn an_empty_update_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path().to_path_buf());
        store.create_project("p").unwrap();
        assert_eq!(
            store.update_analytics(&[]).unwrap(),
            AnalyticsSettings::default()
        );
        assert!(!dir.path().join("settings.toml").exists());
    }
}
