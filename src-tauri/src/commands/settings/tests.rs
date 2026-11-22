use serde_json::json;

use super::*;

fn store() -> (tempfile::TempDir, ConfigStore) {
    let dir = tempfile::tempdir().unwrap();
    let s = ConfigStore::new(dir.path().to_path_buf());
    (dir, s)
}

fn folder() -> &'static str {
    if cfg!(windows) { "C:\\keys" } else { "/keys" }
}

#[test]
fn the_view_has_the_frontend_shape_and_defaults() {
    let (_d, s) = store();
    assert_eq!(
        serde_json::to_value(settings_in(&s).unwrap()).unwrap(),
        json!({"theme": "system", "language": "system", "palette": "default", "accentColor": null, "defaultKeyType": "ed25519", "terminalFontSize": 13, "keyFolder": null})
    );
    let v = update_in(
        &s,
        &json!({"theme": "dark", "language": "fr", "palette": "high-contrast", "accentColor": "#A0B1C2", "defaultKeyType": "rsa4096", "terminalFontSize": 24, "keyFolder": folder()}),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(v).unwrap(),
        json!({"theme": "dark", "language": "fr", "palette": "high-contrast", "accentColor": "#a0b1c2", "defaultKeyType": "rsa4096", "terminalFontSize": 24, "keyFolder": folder()})
    );
    assert_eq!(settings_in(&s).unwrap().theme, ThemeMode::Dark);
    assert_eq!(settings_in(&s).unwrap().language, Language::Fr);
}

#[test]
fn a_patch_changes_only_its_fields_and_null_clears_the_folder() {
    let (_d, s) = store();
    update_in(&s, &json!({"keyFolder": "~/keys", "terminalFontSize": 10})).unwrap();
    let v = update_in(&s, &json!({"theme": "light"})).unwrap();
    assert_eq!(v.language, Language::System);
    let v = update_in(&s, &json!({"language": "en"})).unwrap();
    assert_eq!((v.theme, v.language), (ThemeMode::Light, Language::En));
    assert_eq!(v.key_folder.as_deref(), Some("~/keys"));
    assert_eq!(v.terminal_font_size, 10);
    let v = update_in(&s, &json!({"keyFolder": null})).unwrap();
    assert_eq!(v.key_folder, None);
    assert_eq!(v.theme, ThemeMode::Light);
    assert_eq!(update_in(&s, &json!({})).unwrap(), v);
}

#[test]
fn the_accent_is_stored_lowercase_and_null_removes_it() {
    let (d, s) = store();
    let v = update_in(&s, &json!({"palette": "pine", "accentColor": "#FF00aa"})).unwrap();
    assert_eq!(
        (v.palette, v.accent_color.as_deref()),
        (Palette::Pine, Some("#ff00aa"))
    );
    let raw = std::fs::read_to_string(d.path().join("settings.toml")).unwrap();
    assert!(raw.contains("accent_color = \"#ff00aa\""), "{raw}");
    assert!(raw.contains("palette = \"pine\""), "{raw}");
    assert_eq!(
        settings_in(&s).unwrap().accent_color.as_deref(),
        Some("#ff00aa")
    );

    let v = update_in(&s, &json!({"accentColor": "#ff00AA"})).unwrap();
    assert_eq!(v.accent_color.as_deref(), Some("#ff00aa"));
    assert_eq!(
        std::fs::read_to_string(d.path().join("settings.toml")).unwrap(),
        raw
    );

    let v = update_in(&s, &json!({"accentColor": null})).unwrap();
    assert_eq!(v.accent_color, None);
    assert_eq!(v.palette, Palette::Pine);
    let raw = std::fs::read_to_string(d.path().join("settings.toml")).unwrap();
    assert!(!raw.contains("accent_color"), "{raw}");
    let v = update_in(&s, &json!({"palette": "default"})).unwrap();
    assert_eq!(v.palette, Palette::Default);
    assert!(
        std::fs::read_to_string(d.path().join("settings.toml"))
            .unwrap()
            .contains("palette = \"default\"")
    );
}

#[test]
fn values_from_a_newer_version_read_as_defaults_and_survive_other_changes() {
    let (d, s) = store();
    let mine = "palette = \"aurora\"\naccent_color = \"#ff00aa80\"\n";
    std::fs::write(d.path().join("settings.toml"), mine).unwrap();
    let v = settings_in(&s).unwrap();
    assert_eq!((v.palette, v.accent_color), (Palette::Default, None));
    update_in(&s, &json!({"theme": "dark", "accentColor": null})).unwrap();
    let out = std::fs::read_to_string(d.path().join("settings.toml")).unwrap();
    assert_eq!(out, format!("{mine}theme = \"dark\"\n"));
    update_in(&s, &json!({"palette": "plum"})).unwrap();
    let out = std::fs::read_to_string(d.path().join("settings.toml")).unwrap();
    assert!(
        out.starts_with("palette = \"plum\"\naccent_color = \"#ff00aa80\"\n"),
        "{out}"
    );
}

#[test]
fn bad_palettes_and_accents_carry_their_keys_and_never_the_value() {
    let (_d, s) = store();
    for (bad, key, message) in [
        (
            json!({"palette": "secret-palette"}),
            "errors.settings.palette",
            "palette must be default, high-contrast, pine or plum",
        ),
        (
            json!({"palette": null}),
            "errors.settings.palette",
            "palette must be default, high-contrast, pine or plum",
        ),
        (
            json!({"accentColor": "#secret"}),
            "errors.settings.accentColor",
            "accentColor must be a #rrggbb color or null",
        ),
        (
            json!({"accentColor": 7}),
            "errors.settings.accentColor",
            "accentColor must be a #rrggbb color or null",
        ),
    ] {
        let e = update_in(&s, &bad).unwrap_err();
        assert_eq!(e.code, "invalid_input", "{bad}");
        assert_eq!(e.key, Some(key), "{bad}");
        assert_eq!(e.message, message, "{bad}");
        assert!(e.params.is_empty(), "{bad}");
    }
}

#[test]
fn every_bad_patch_is_invalid_input_and_writes_nothing() {
    let (d, s) = store();
    for bad in [
        json!({"theme": "blue"}),
        json!({"theme": null}),
        json!({"theme": 1}),
        json!({"language": "DE"}),
        json!({"language": "FR"}),
        json!({"language": "pt-br"}),
        json!({"language": "pt_BR"}),
        json!({"language": "pt"}),
        json!({"language": "zh"}),
        json!({"language": "zh-TW"}),
        json!({"language": null}),
        json!({"language": 1}),
        json!({"theme": "dark", "language": "relative"}),
        json!({"palette": "relative"}),
        json!({"palette": "Pine"}),
        json!({"palette": "high_contrast"}),
        json!({"palette": null}),
        json!({"palette": 1}),
        json!({"palette": ["pine"]}),
        json!({"accentColor": "#abc"}),
        json!({"accentColor": "#aabbccdd"}),
        json!({"accentColor": "aabbcc"}),
        json!({"accentColor": "red"}),
        json!({"accentColor": "relative"}),
        json!({"accentColor": "#aabbcg"}),
        json!({"accentColor": " #aabbcc"}),
        json!({"accentColor": ""}),
        json!({"accentColor": 11189196}),
        json!({"accentColor": false}),
        json!({"accentColor": {"hex": "#aabbcc"}}),
        json!({"palette": "pine", "accentColor": "#abc"}),
        json!({"accent_color": "#aabbcc"}),
        json!({"defaultKeyType": "rsa"}),
        json!({"defaultKeyType": "dsa"}),
        json!({"terminalFontSize": 9}),
        json!({"terminalFontSize": 25}),
        json!({"terminalFontSize": 13.5}),
        json!({"terminalFontSize": "13"}),
        json!({"keyFolder": "relative"}),
        json!({"keyFolder": " ~/keys"}),
        json!({"keyFolder": 3}),
        json!({"theme": "dark", "keyFolder": "relative"}),
        json!({"analytics": true}),
        json!({"theme": "dark", "legacyImported": true}),
        json!({"key_folder": "~/keys"}),
        json!("dark"),
        json!(null),
        json!([]),
    ] {
        let e = update_in(&s, &bad).unwrap_err();
        assert_eq!(e.code, "invalid_input", "{bad}");
        assert!(!e.message.contains("relative"), "{}", e.message);
    }
    assert!(!d.path().join("settings.toml").exists());
}

#[test]
fn the_legacy_import_skips_bad_values_and_runs_once() {
    let (d, s) = store();
    update_in(&s, &json!({"theme": "dark"})).unwrap();
    let v = import_in(
        &s,
        &json!({"theme": "light", "defaultKeyType": "dsa", "terminalFontSize": 18, "keyFolder": "nope"}),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&v).unwrap(),
        json!({"theme": "dark", "language": "system", "palette": "default", "accentColor": null, "defaultKeyType": "ed25519", "terminalFontSize": 18, "keyFolder": null})
    );
    let raw = std::fs::read_to_string(d.path().join("settings.toml")).unwrap();
    assert!(raw.contains("legacy_imported = true"));
    assert!(!raw.contains("default_key_type"));
    let again = import_in(
        &s,
        &json!({"defaultKeyType": "rsa4096", "keyFolder": "~/k"}),
    )
    .unwrap();
    assert_eq!(again, v);
    assert_eq!(
        std::fs::read_to_string(d.path().join("settings.toml")).unwrap(),
        raw
    );
    let e = import_in(&s, &json!({"fontSize": 12})).unwrap_err();
    assert_eq!(e.code, "invalid_input");
}

#[test]
fn the_legacy_import_treats_palette_and_accent_like_any_field() {
    let (_d, s) = store();
    let v = import_in(&s, &json!({"palette": "ocean", "accentColor": "#ABCDEF"})).unwrap();
    assert_eq!(
        (v.palette, v.accent_color.as_deref()),
        (Palette::Default, Some("#abcdef"))
    );
    let (_d, s) = store();
    let v = import_in(&s, &json!({"palette": "plum", "accentColor": "#abc"})).unwrap();
    assert_eq!((v.palette, v.accent_color), (Palette::Plum, None));
}

#[test]
fn a_corrupt_settings_file_maps_to_corrupt_config() {
    let (d, s) = store();
    std::fs::write(d.path().join("settings.toml"), "theme = [").unwrap();
    let e = settings_in(&s).unwrap_err();
    assert_eq!(e.code, "corrupt_config");
    assert!(!e.message.contains("theme"));
    assert_eq!(
        import_in(&s, &json!({"theme": "dark"})).unwrap_err().code,
        "corrupt_config"
    );
    let v = update_in(&s, &json!({"theme": "dark"})).unwrap();
    assert_eq!(v.theme, ThemeMode::Dark);
    assert_eq!(
        std::fs::read_to_string(d.path().join("settings.toml.bak")).unwrap(),
        "theme = ["
    );
}

#[derive(serde::Deserialize)]
struct PermissionFile {
    permission: Vec<Permission>,
}

#[derive(serde::Deserialize)]
struct Permission {
    identifier: String,
    commands: Commands,
}

#[derive(serde::Deserialize)]
struct Commands {
    allow: Vec<String>,
}

#[test]
fn each_settings_command_has_its_own_granted_permission() {
    let file: PermissionFile =
        toml::from_str(include_str!("../../../permissions/settings.toml")).unwrap();
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../../../capabilities/default.json")).unwrap();
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p.as_str())
        .collect();
    assert_eq!(capability["windows"], json!(["main"]));
    assert!(
        granted
            .iter()
            .all(|p| !p.contains('*') && !p.ends_with(":default"))
    );
    let commands = [
        "app_settings",
        "update_app_settings",
        "import_legacy_settings",
    ];
    assert_eq!(file.permission.len(), commands.len());
    for (p, command) in file.permission.iter().zip(commands) {
        assert_eq!(p.commands.allow, [command]);
        assert_eq!(p.identifier, format!("allow-{}", command.replace('_', "-")));
        assert!(granted.contains(&p.identifier.as_str()), "{}", p.identifier);
    }
}

#[test]
fn update_app_settings_and_analytics_keep_the_users_comments() {
    use crate::analytics::{Analytics, Category, SystemProps};
    let (d, s) = store();
    let mine = "# hand written\nmy_key = 1 # keep\n";
    std::fs::write(d.path().join("settings.toml"), mine).unwrap();
    update_in(&s, &json!({"terminalFontSize": 15})).unwrap();
    let system = SystemProps {
        app_version: "0".into(),
        os: "os".into(),
        os_version: "1".into(),
        locale: String::new(),
    };
    let analytics = Analytics::new(None, system, None, false);
    crate::commands::analytics::set_category(&s, &analytics, Category::Launch, false).unwrap();
    let out = std::fs::read_to_string(d.path().join("settings.toml")).unwrap();
    assert!(out.starts_with(mine), "{out}");
    assert!(out.contains("terminal_font_size = 15"), "{out}");
    assert!(out.contains("[analytics.launch]"), "{out}");
}

#[test]
fn every_language_travels_as_its_stored_code() {
    let (d, s) = store();
    for code in ["en", "fr", "de", "es", "pt-BR", "zh-CN", "system"] {
        let v = update_in(&s, &json!({ "language": code })).unwrap();
        assert_eq!(serde_json::to_value(v).unwrap()["language"], code);
        assert_eq!(
            serde_json::to_value(settings_in(&s).unwrap()).unwrap()["language"],
            code
        );
        let raw = std::fs::read_to_string(d.path().join("settings.toml")).unwrap();
        assert!(raw.contains(&format!("language = \"{code}\"")), "{raw}");
    }
}

#[test]
fn a_bad_language_names_the_allowed_values_only() {
    let (_d, s) = store();
    let e = update_in(&s, &json!({"language": "klingon"})).unwrap_err();
    assert_eq!(e.code, "invalid_input");
    assert_eq!(
        e.message,
        "language must be system, en, fr, de, es, pt-BR or zh-CN"
    );
}

#[test]
fn bad_patches_carry_keys_and_params() {
    let (_d, s) = store();
    let e = update_in(&s, &json!({"terminalFontSize": 99})).unwrap_err();
    assert_eq!(e.key, Some("errors.settings.terminalFontSize"));
    assert_eq!(e.params["min"], 10);
    assert_eq!(e.params["max"], 24);
    let e = update_in(&s, &json!({"keyFolder": "relative"})).unwrap_err();
    assert_eq!(e.key, Some("errors.settings.keyFolderNotLocal"));
    assert!(e.params.is_empty());
    let e = update_in(&s, &json!({"nope": 1})).unwrap_err();
    assert_eq!(e.key, Some("errors.settings.unknownSetting"));
}
