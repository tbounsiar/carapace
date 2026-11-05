use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::super::{FILE_NAME, Held, KeychainMigration, LEGACY_NAME, MigrationPlan};
use super::*;
use crate::config::model::{CategoryChoices, Consent, EditorMode};
use crate::config::{KeyType, ThemeMode};

const V3_LEGACY: &str = r#"{"version":3,
  "projects":[{"id":"00000000-0000-4000-8000-000000000001","name":"P","variables":[]}],
  "analytics":{"categories":{"launch":{"consent":"denied","version":2},
    "features":{"consent":"granted","version":2}}},
  "externalEditor":{"mode":"custom","appPath":"/usr/bin/vi","noticeSeen":true}}"#;

/// Fails the keychain step while `fail` is set.
#[derive(Default)]
struct Keychain {
    fail: AtomicBool,
}

impl KeychainMigration for Keychain {
    fn enter(&self) -> Box<dyn Held + '_> {
        Box::new(())
    }

    fn before_save(&self, _: &MigrationPlan) -> Result<(), ()> {
        if self.fail.load(Ordering::SeqCst) {
            Err(())
        } else {
            Ok(())
        }
    }
}

fn store() -> (tempfile::TempDir, ConfigStore) {
    let dir = tempfile::tempdir().unwrap();
    let s = ConfigStore::new(dir.path().to_path_buf());
    (dir, s)
}

fn text(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join(name)).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

fn choice(consent: Consent) -> CategoryChoice {
    CategoryChoice {
        consent,
        version: 2,
    }
}

fn theme(theme: ThemeMode) -> SettingsPatch {
    SettingsPatch {
        theme: Some(theme),
        ..SettingsPatch::default()
    }
}

#[test]
fn a_fresh_install_writes_nothing_until_a_change() {
    let (d, s) = store();
    assert_eq!(s.settings().unwrap(), Settings::default());
    assert_eq!(s.snapshot().unwrap().projects.len(), 0);
    assert!(names(d.path()).is_empty());
    s.update_settings(&theme(ThemeMode::Dark)).unwrap();
    assert_eq!(names(d.path()), [SETTINGS_NAME]);
    assert_eq!(text(d.path(), SETTINGS_NAME), "theme = \"dark\"\n");
}

#[test]
fn a_config_json_is_split_and_moved_aside() {
    let (d, s) = store();
    fs::write(d.path().join(LEGACY_NAME), V3_LEGACY).unwrap();
    let settings = s.settings().unwrap();
    assert_eq!(
        names(d.path()),
        ["config.json.v4.bak", "data.json", "settings.toml"]
    );
    assert_eq!(text(d.path(), "config.json.v4.bak"), V3_LEGACY);
    let c = settings.analytics.unwrap().categories;
    assert_eq!(
        (c.launch, c.features, c.connections),
        (
            choice(Consent::Denied),
            choice(Consent::Granted),
            CategoryChoice::default()
        )
    );
    assert_eq!(
        settings.external_editor,
        Some(ExternalEditor {
            mode: EditorMode::Custom,
            app_path: Some("/usr/bin/vi".into()),
            notice_seen: true,
        })
    );
    assert!(!settings.legacy_imported);
    assert_eq!(settings.theme, None);
    let data: serde_json::Value = serde_json::from_str(&text(d.path(), FILE_NAME)).unwrap();
    let mut keys: Vec<&str> = data
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["keys", "nodes", "projects", "variables", "version"]);
    assert_eq!(data["version"], 3);
    assert_eq!(data["projects"][0]["name"], "P");
    let toml = text(d.path(), SETTINGS_NAME);
    assert!(
        !toml.contains("theme") && !toml.contains("connections"),
        "{toml}"
    );
}

#[test]
fn the_split_backup_is_numbered_when_taken() {
    let (d, s) = store();
    fs::write(d.path().join("config.json.v4.bak"), "older").unwrap();
    fs::write(d.path().join(LEGACY_NAME), V3_LEGACY).unwrap();
    s.snapshot().unwrap();
    assert_eq!(text(d.path(), "config.json.v4.bak"), "older");
    assert_eq!(text(d.path(), "config.json.v4.2.bak"), V3_LEGACY);
}

#[test]
fn a_config_json_without_preferences_gives_an_empty_settings_file() {
    let (d, s) = store();
    fs::write(d.path().join(LEGACY_NAME), r#"{"version":3}"#).unwrap();
    s.snapshot().unwrap();
    assert_eq!(text(d.path(), SETTINGS_NAME), "");
    assert_eq!(s.settings().unwrap(), Settings::default());
}

#[test]
fn malformed_legacy_preferences_are_left_out() {
    let (d, s) = store();
    fs::write(
        d.path().join(LEGACY_NAME),
        r#"{"version":3,"analytics":{"categories":{"launch":{"consent":"granted"}}},
            "externalEditor":{"mode":"shell"}}"#,
    )
    .unwrap();
    let settings = s.settings().unwrap();
    assert_eq!(
        settings.analytics.unwrap_or_default().categories,
        CategoryChoices::default()
    );
    assert_eq!(settings.external_editor, None);
}

#[test]
fn once_both_files_exist_a_config_json_is_never_read() {
    let (d, s) = store();
    s.create_project("Kept").unwrap();
    s.update_settings(&theme(ThemeMode::Light)).unwrap();
    fs::write(d.path().join(LEGACY_NAME), V3_LEGACY).unwrap();
    assert_eq!(s.snapshot().unwrap().projects[0].name, "Kept");
    assert_eq!(s.settings().unwrap().analytics, None);
    s.create_project("More").unwrap();
    assert_eq!(text(d.path(), LEGACY_NAME), V3_LEGACY);
    assert!(!d.path().join("config.json.v4.bak").exists());
}

#[test]
fn a_crash_after_the_settings_file_keeps_it_and_finishes_the_split() {
    let (d, s) = store();
    let earlier = "theme = \"dark\"\n\n[analytics.launch]\nconsent = \"granted\"\nversion = 2\n";
    fs::write(d.path().join(SETTINGS_NAME), earlier).unwrap();
    fs::write(d.path().join(LEGACY_NAME), V3_LEGACY).unwrap();
    assert_eq!(s.snapshot().unwrap().projects[0].name, "P");
    assert_eq!(text(d.path(), SETTINGS_NAME), earlier);
    assert_eq!(
        names(d.path()),
        ["config.json.v4.bak", "data.json", "settings.toml"]
    );
}

#[test]
fn a_failed_write_leaves_config_json_and_is_retried() {
    let (d, s) = store();
    fs::write(d.path().join(LEGACY_NAME), V3_LEGACY).unwrap();
    fs::create_dir(d.path().join("data.json.tmp")).unwrap();
    assert!(matches!(s.snapshot(), Err(ConfigError::Io)));
    assert!(matches!(s.settings(), Err(ConfigError::Io)));
    assert!(matches!(
        s.update_settings(&theme(ThemeMode::Dark)),
        Err(ConfigError::Io)
    ));
    assert_eq!(text(d.path(), LEGACY_NAME), V3_LEGACY);
    assert!(!d.path().join(FILE_NAME).exists());
    let half = text(d.path(), SETTINGS_NAME);
    assert!(!half.contains("theme"));

    fs::remove_dir(d.path().join("data.json.tmp")).unwrap();
    assert_eq!(s.settings().unwrap().theme, None);
    assert_eq!(text(d.path(), SETTINGS_NAME), half);
    assert_eq!(
        names(d.path()),
        ["config.json.v4.bak", "data.json", "settings.toml"]
    );
}

#[test]
fn a_failed_keychain_step_writes_neither_file() {
    let dir = tempfile::tempdir().unwrap();
    let keychain = Arc::new(Keychain::default());
    keychain.fail.store(true, Ordering::SeqCst);
    let s = ConfigStore::with_migration(dir.path().to_path_buf(), keychain.clone());
    let raw = r#"{"version":3,"projects":[{"id":"00000000-0000-4000-8000-000000000001","name":"P",
        "variables":[],"environments":[{"id":"00000000-0000-4000-8000-000000000002","name":"e",
        "variables":[{"name":"pw","kind":"secret","value":null}]}],
        "activeEnvironmentId":"00000000-0000-4000-8000-000000000002"}],
        "analytics":{"categories":{"launch":{"consent":"denied","version":2}}}}"#;
    fs::write(dir.path().join(LEGACY_NAME), raw).unwrap();
    assert!(matches!(s.analytics(), Err(ConfigError::Keychain)));
    assert!(matches!(
        s.update_analytics(&[(Category::Launch, choice(Consent::Granted))]),
        Err(ConfigError::Keychain)
    ));
    assert!(matches!(
        s.update_settings(&theme(ThemeMode::Dark)),
        Err(ConfigError::Keychain)
    ));
    assert_eq!(names(dir.path()), [LEGACY_NAME]);
    keychain.fail.store(false, Ordering::SeqCst);
    let a = s.analytics().unwrap().unwrap();
    assert_eq!(a.categories.launch, choice(Consent::Denied));
}

#[test]
fn a_version_2_file_is_split_into_its_v2_backup() {
    let (d, s) = store();
    let raw = r#"{"version":2,"projects":[{"id":"00000000-0000-4000-8000-000000000001","name":"P",
        "hosts":[]}]}"#;
    fs::write(d.path().join(LEGACY_NAME), raw).unwrap();
    assert_eq!(s.snapshot().unwrap().projects[0].name, "P");
    assert_eq!(
        names(d.path()),
        ["config.json.v2.bak", "data.json", "settings.toml"]
    );
    assert_eq!(text(d.path(), "config.json.v2.bak"), raw);
}

#[test]
fn a_corrupt_settings_file_is_reported_and_kept_until_a_user_change() {
    let (d, s) = store();
    s.create_project("P").unwrap();
    let bad = "theme = \"dark\"\n[[[";
    fs::write(d.path().join(SETTINGS_NAME), bad).unwrap();
    assert!(matches!(s.settings(), Err(ConfigError::Corrupt)));
    assert!(matches!(s.analytics(), Err(ConfigError::Corrupt)));
    assert!(matches!(s.external_editor(), Err(ConfigError::Corrupt)));
    assert_eq!(s.snapshot().unwrap().projects[0].name, "P");
    assert!(matches!(
        s.update_analytics(&[(Category::Launch, choice(Consent::Granted))]),
        Err(ConfigError::Corrupt)
    ));
    assert!(matches!(
        s.import_legacy_settings(&theme(ThemeMode::Light)),
        Err(ConfigError::Corrupt)
    ));
    s.update_settings(&SettingsPatch::default()).unwrap();
    assert_eq!(text(d.path(), SETTINGS_NAME), bad);
    assert!(!d.path().join("settings.toml.bak").exists());

    let after = s.update_settings(&theme(ThemeMode::Light)).unwrap();
    assert_eq!(
        after,
        Settings {
            theme: Some(ThemeMode::Light),
            ..Settings::default()
        }
    );
    assert_eq!(text(d.path(), "settings.toml.bak"), bad);
    assert_eq!(s.settings().unwrap(), after);

    fs::write(d.path().join(SETTINGS_NAME), "\u{0}garbage = ").unwrap();
    s.set_external_editor(ExternalEditor::default()).unwrap();
    assert_eq!(text(d.path(), "settings.toml.bak"), bad);
    assert_eq!(text(d.path(), "settings.toml.2.bak"), "\u{0}garbage = ");
}

#[test]
fn a_settings_file_that_is_not_utf8_or_too_large_is_corrupt() {
    let (d, s) = store();
    fs::write(d.path().join(SETTINGS_NAME), [0xff, 0xfe, b'a']).unwrap();
    assert!(matches!(s.settings(), Err(ConfigError::Corrupt)));
    let big = format!("# {}\n", "x".repeat(MAX_SETTINGS_BYTES as usize));
    fs::write(d.path().join(SETTINGS_NAME), &big).unwrap();
    assert!(matches!(s.settings(), Err(ConfigError::Corrupt)));
}

#[test]
fn analytics_changes_are_merged_onto_the_file() {
    let (d, s) = store();
    s.update_settings(&theme(ThemeMode::Dark)).unwrap();
    s.update_analytics(&[(Category::Launch, choice(Consent::Denied))])
        .unwrap();
    // A hand edit between two changes is kept.
    let edited = text(d.path(), SETTINGS_NAME).replace("dark", "light");
    fs::write(d.path().join(SETTINGS_NAME), edited).unwrap();
    let a = s
        .update_analytics(&[(Category::Features, choice(Consent::Granted))])
        .unwrap();
    assert_eq!(a.categories.launch, choice(Consent::Denied));
    assert_eq!(a.categories.features, choice(Consent::Granted));
    let read = s.settings().unwrap();
    assert_eq!(read.theme, Some(ThemeMode::Light));
    assert_eq!(read.analytics, Some(a));
    assert!(!d.path().join(SETTINGS_TMP).exists());
}

#[test]
fn unchanged_values_write_nothing() {
    let (d, s) = store();
    fs::write(
        d.path().join(SETTINGS_NAME),
        "[external_editor]\nmode = \"system\"\n# mine\n",
    )
    .unwrap();
    s.set_external_editor(ExternalEditor::default()).unwrap();
    s.update_analytics(&[]).unwrap();
    s.update_settings(&SettingsPatch::default()).unwrap();
    assert!(text(d.path(), SETTINGS_NAME).contains("# mine"));
}

#[test]
fn the_legacy_import_runs_once_and_keeps_what_the_file_holds() {
    let (d, s) = store();
    s.update_settings(&theme(ThemeMode::Dark)).unwrap();
    let values = SettingsPatch {
        theme: Some(ThemeMode::Light),
        default_key_type: Some(KeyType::Rsa4096),
        terminal_font_size: Some(16),
        key_folder: Some(Some("~/keys".into())),
    };
    let first = s.import_legacy_settings(&values).unwrap();
    assert_eq!(first.theme, Some(ThemeMode::Dark));
    assert_eq!(first.default_key_type, Some(KeyType::Rsa4096));
    assert_eq!(first.terminal_font_size, Some(16));
    assert_eq!(first.key_folder.as_deref(), Some("~/keys"));
    assert!(first.legacy_imported);
    assert!(text(d.path(), SETTINGS_NAME).contains("legacy_imported = true"));

    s.update_settings(&SettingsPatch {
        terminal_font_size: Some(12),
        key_folder: Some(None),
        ..SettingsPatch::default()
    })
    .unwrap();
    let raw = text(d.path(), SETTINGS_NAME);
    let again = s.import_legacy_settings(&values).unwrap();
    assert_eq!(again.terminal_font_size, Some(12));
    assert_eq!(again.key_folder, None);
    assert_eq!(text(d.path(), SETTINGS_NAME), raw);
}

#[test]
fn an_empty_import_still_marks_it_done() {
    let (d, s) = store();
    let done = s.import_legacy_settings(&SettingsPatch::default()).unwrap();
    assert_eq!(
        done,
        Settings {
            legacy_imported: true,
            ..Settings::default()
        }
    );
    assert_eq!(text(d.path(), SETTINGS_NAME), "legacy_imported = true\n");
}

#[cfg(unix)]
#[test]
fn both_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let (d, s) = store();
    fs::write(d.path().join(LEGACY_NAME), V3_LEGACY).unwrap();
    s.snapshot().unwrap();
    for name in [FILE_NAME, SETTINGS_NAME] {
        let mode = fs::metadata(d.path().join(name))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{name}");
    }
}

#[test]
fn an_oversized_settings_file_is_backed_up_whole() {
    let (d, s) = store();
    let mut big = b"# start\n".to_vec();
    big.extend(std::iter::repeat_n(
        b'x',
        MAX_SETTINGS_BYTES as usize + 4096,
    ));
    big.extend(b"\n# end\n");
    fs::write(d.path().join(SETTINGS_NAME), &big).unwrap();
    assert!(matches!(s.settings(), Err(ConfigError::Corrupt)));
    s.update_settings(&theme(ThemeMode::Dark)).unwrap();
    assert_eq!(fs::read(d.path().join("settings.toml.bak")).unwrap(), big);
    assert_eq!(text(d.path(), SETTINGS_NAME), "theme = \"dark\"\n");
}

#[test]
fn a_failed_replace_keeps_the_corrupt_file_in_place() {
    let (d, s) = store();
    fs::write(d.path().join(SETTINGS_NAME), "[[[").unwrap();
    fs::create_dir(d.path().join(SETTINGS_TMP)).unwrap();
    assert!(matches!(
        s.update_settings(&theme(ThemeMode::Dark)),
        Err(ConfigError::Io)
    ));
    assert_eq!(text(d.path(), SETTINGS_NAME), "[[[");
    assert!(!d.path().join("settings.toml.bak").exists());
    assert!(matches!(s.settings(), Err(ConfigError::Corrupt)));
}

#[test]
fn comments_order_and_unknown_keys_survive_every_change() {
    let (d, s) = store();
    let mine = "# kept on purpose\nzeta = \"unknown\"\ntheme = \"dark\" # night\n\n[analytics.launch] # first answer\nconsent = \"denied\"\nversion = 2\nnote = \"mine\"\n";
    fs::write(d.path().join(SETTINGS_NAME), mine).unwrap();
    s.update_settings(&theme(ThemeMode::Light)).unwrap();
    s.update_analytics(&[
        (Category::Features, choice(Consent::Granted)),
        (Category::Launch, choice(Consent::Granted)),
    ])
    .unwrap();
    s.set_external_editor(ExternalEditor::default()).unwrap();
    let out = text(d.path(), SETTINGS_NAME);
    assert!(
        out.starts_with("# kept on purpose\nzeta = \"unknown\"\ntheme = \"light\" # night\n"),
        "{out}"
    );
    assert!(
        out.contains("[analytics.launch] # first answer\nconsent = \"granted\""),
        "{out}"
    );
    assert!(out.contains("note = \"mine\""), "{out}");
    let read = s.settings().unwrap();
    assert_eq!(read.theme, Some(ThemeMode::Light));
    let c = read.analytics.unwrap().categories;
    assert_eq!(
        (c.launch, c.features),
        (choice(Consent::Granted), choice(Consent::Granted))
    );
    assert_eq!(read.external_editor, Some(ExternalEditor::default()));
}
