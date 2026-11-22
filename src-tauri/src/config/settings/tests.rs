use super::*;

fn granted(version: u32) -> CategoryChoice {
    CategoryChoice {
        consent: Consent::Granted,
        version,
    }
}

fn full() -> Settings {
    Settings {
        theme: Some(ThemeMode::Dark),
        language: Some(Language::Fr),
        palette: Some(Palette::HighContrast),
        accent_color: Some("#1a2b3c".into()),
        default_key_type: Some(KeyType::Rsa4096),
        terminal_font_size: Some(FONT_SIZE_MAX),
        key_folder: Some(if cfg!(windows) { "D:\\keys" } else { "/keys" }.into()),
        legacy_imported: true,
        external_editor: Some(ExternalEditor {
            mode: EditorMode::Custom,
            app_path: Some("/usr/bin/vi".into()),
            notice_seen: true,
        }),
        analytics: Some(AnalyticsSettings {
            categories: CategoryChoices {
                launch: granted(2),
                features: CategoryChoice {
                    consent: Consent::Denied,
                    version: 1,
                },
                connections: CategoryChoice::default(),
                crashes: granted(3),
            },
        }),
        updates: UpdateSettings {
            auto_check: Some(false),
            skipped_version: Some("0.3.0".into()),
        },
    }
}

#[test]
fn round_trip() {
    let s = full();
    let text = to_toml(&s);
    assert_eq!(parse(&text).unwrap(), s);
    assert!(!text.contains("connections"), "{text}");
    assert_eq!(
        parse(&to_toml(&Settings::default())).unwrap(),
        Settings::default()
    );
}

#[test]
fn keys_are_snake_case() {
    let text = to_toml(&full());
    let t: toml::Table = text.parse().unwrap();
    let mut keys: Vec<&str> = t.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "accent_color",
            "analytics",
            "default_key_type",
            "external_editor",
            "key_folder",
            "language",
            "legacy_imported",
            "palette",
            "terminal_font_size",
            "theme",
            "updates"
        ]
    );
    assert!(text.contains("palette = \"high-contrast\""), "{text}");
    assert!(text.contains("accent_color = \"#1a2b3c\""), "{text}");
    assert!(text.contains("[analytics.launch]"), "{text}");
    assert!(text.contains("[analytics.crashes]"), "{text}");
    let editor = t["external_editor"].as_table().unwrap();
    assert!(editor.contains_key("app_path") && editor.contains_key("notice_seen"));
}

#[test]
fn only_text_that_is_not_toml_is_refused() {
    for bad in [
        "theme = ",
        "[analytics",
        "= 1",
        "theme = \"a\"\ntheme = \"b\"",
    ] {
        assert!(parse(bad).is_err(), "{bad}");
    }
    assert_eq!(parse("").unwrap(), Settings::default());
    assert_eq!(
        parse("# nothing\nunknown = 3\n").unwrap(),
        Settings::default()
    );
}

#[test]
fn each_field_falls_back_on_its_own() {
    let s = parse(
        r##"
theme = "blue"
language = "ja"
palette = "solarized"
accent_color = "#abc"
default_key_type = "rsa4096"
terminal_font_size = 99
key_folder = "relative/dir"
legacy_imported = "yes"
"##,
    )
    .unwrap();
    assert_eq!(
        s,
        Settings {
            default_key_type: Some(KeyType::Rsa4096),
            ..Settings::default()
        }
    );
    for (text, expected) in [
        ("terminal_font_size = 10", Some(10)),
        ("terminal_font_size = 24", Some(24)),
        ("terminal_font_size = 9", None),
        ("terminal_font_size = 25", None),
        ("terminal_font_size = 13.0", None),
        ("terminal_font_size = \"13\"", None),
        ("terminal_font_size = -1", None),
    ] {
        assert_eq!(parse(text).unwrap().terminal_font_size, expected, "{text}");
    }
    for (text, expected) in [
        ("theme = \"light\"", Some(ThemeMode::Light)),
        ("theme = \"system\"", Some(ThemeMode::System)),
        ("theme = \"Dark\"", None),
        ("theme = 1", None),
    ] {
        assert_eq!(parse(text).unwrap().theme, expected, "{text}");
    }
    for (text, expected) in [
        ("language = \"en\"", Some(Language::En)),
        ("language = \"fr\"", Some(Language::Fr)),
        ("language = \"system\"", Some(Language::System)),
        ("language = \"de\"", Some(Language::De)),
        ("language = \"es\"", Some(Language::Es)),
        ("language = \"pt-BR\"", Some(Language::PtBr)),
        ("language = \"zh-CN\"", Some(Language::ZhCn)),
        ("language = \"FR\"", None),
        ("language = \"pt-br\"", None),
        ("language = \"pt\"", None),
        ("language = \"zh_CN\"", None),
        ("language = \"zh-TW\"", None),
        ("language = \"ja\"", None),
        ("language = \"fr-FR\"", None),
        ("language = 1", None),
        ("[language]\nvalue = \"fr\"", None),
    ] {
        assert_eq!(parse(text).unwrap().language, expected, "{text}");
    }
    for (text, expected) in [
        ("palette = \"default\"", Some(Palette::Default)),
        ("palette = \"high-contrast\"", Some(Palette::HighContrast)),
        ("palette = \"pine\"", Some(Palette::Pine)),
        ("palette = \"plum\"", Some(Palette::Plum)),
        ("palette = \"Pine\"", None),
        ("palette = \"high_contrast\"", None),
        ("palette = \"ocean\"", None),
        ("palette = 1", None),
        ("palette = true", None),
        ("[palette]\nname = \"pine\"", None),
    ] {
        assert_eq!(parse(text).unwrap().palette, expected, "{text}");
    }
    for (text, expected) in [
        ("accent_color = \"#00ff7f\"", Some("#00ff7f")),
        ("accent_color = \"#00FF7F\"", Some("#00ff7f")),
        ("accent_color = \"#AbCdEf\"", Some("#abcdef")),
        ("accent_color = \"#0f7\"", None),
        ("accent_color = \"#00ff7f80\"", None),
        ("accent_color = \"00ff7f\"", None),
        ("accent_color = \"red\"", None),
        ("accent_color = \"#00ff7g\"", None),
        ("accent_color = \"#00ff7f \"", None),
        ("accent_color = \"\"", None),
        ("accent_color = 16711680", None),
        ("accent_color = [\"#00ff7f\"]", None),
    ] {
        assert_eq!(
            parse(text).unwrap().accent_color.as_deref(),
            expected,
            "{text}"
        );
    }
    assert_eq!(
        parse("default_key_type = \"rsa\"")
            .unwrap()
            .default_key_type,
        None
    );
    assert_eq!(
        parse("default_key_type = \"dsa\"")
            .unwrap()
            .default_key_type,
        None
    );
}

#[test]
fn analytics_are_read_per_category_and_never_turned_on_by_a_bad_value() {
    let s = parse(
        r#"
[analytics.launch]
consent = "granted"
version = 2
[analytics.features]
consent = "granted"
[analytics.connections]
consent = "maybe"
version = 2
[analytics.extra]
consent = "granted"
version = 2
[analytics.crashes]
consent = "denied"
version = 3
"#,
    )
    .unwrap();
    let c = s.analytics.unwrap().categories;
    assert_eq!(c.launch, granted(2));
    assert!(c.features.is_unset() && c.connections.is_unset());
    assert_eq!(c.crashes.consent, Consent::Denied);
    for odd in [
        "analytics = \"granted\"",
        "analytics = true",
        "[analytics]\nlaunch = \"granted\"",
        "[analytics.launch]\nconsent = \"granted\"\nversion = -1",
        "[analytics.launch]\nconsent = \"granted\"\nversion = 5000000000",
        "[analytics.launch]\nconsent = \"granted\"\nversion = \"2\"",
        "[analytics.launch]\nconsent = true\nversion = 2",
        "[analytics.launch]\nconsent = \"Granted\"\nversion = 2",
    ] {
        let a = parse(odd).unwrap().analytics.unwrap_or_default();
        assert!(
            Category::ALL
                .iter()
                .all(|&c| a.categories.get(c).consent != Consent::Granted),
            "{odd}"
        );
    }
}

#[test]
fn a_malformed_editor_is_unset_as_a_whole() {
    for odd in [
        "[external_editor]\nmode = \"shell\"",
        "[external_editor]\napp_path = \"/x\"",
        "[external_editor]\nmode = \"custom\"\nnotice_seen = \"yes\"",
        "[external_editor]\nmode = \"custom\"\napp_path = false",
        "external_editor = \"custom\"",
    ] {
        assert_eq!(parse(odd).unwrap().external_editor, None, "{odd}");
    }
    assert_eq!(
        parse("[external_editor]\nmode = \"system\"")
            .unwrap()
            .external_editor,
        Some(ExternalEditor::default())
    );
}

#[test]
fn key_folders_follow_the_generation_rules() {
    let ok: &[&str] = if cfg!(windows) {
        &["C:\\keys", "c:/keys", "~/keys", "D:\\"]
    } else {
        &["/home/u/keys", "~/keys", "/"]
    };
    for f in ok {
        assert!(check_key_folder(f).is_ok(), "{f}");
    }
    let long = format!("~/{}", "a".repeat(KEY_FOLDER_MAX_CHARS));
    let mut bad = vec![
        "",
        " ~/keys",
        "~/keys ",
        "keys",
        "./keys",
        "~",
        "~user/keys",
        "\\\\server\\share",
        "//server/share",
        "~/a\nb",
        long.as_str(),
    ];
    if cfg!(windows) {
        bad.extend(["/keys", "\\\\?\\C:\\keys", "C:keys"]);
    } else {
        bad.push("C:\\keys");
    }
    for f in bad {
        let e = check_key_folder(f).unwrap_err();
        assert!(matches!(e, ConfigError::InvalidInput(_)), "{f}");
        assert!(f.len() < 4 || !e.to_string().contains(f), "{f}");
    }
}

#[test]
fn a_patch_applies_and_an_import_only_fills_gaps() {
    let patch = SettingsPatch {
        theme: Some(ThemeMode::Light),
        language: Some(Language::En),
        palette: Some(Palette::Pine),
        accent_color: Some(Some("#112233".into())),
        default_key_type: Some(KeyType::Rsa4096),
        terminal_font_size: Some(20),
        key_folder: Some(Some("~/k".into())),
    };
    let mut s = Settings {
        theme: Some(ThemeMode::Dark),
        accent_color: Some("#000000".into()),
        key_folder: Some("~/mine".into()),
        ..Settings::default()
    };
    s.fill(&patch);
    assert_eq!(s.theme, Some(ThemeMode::Dark));
    assert_eq!(s.language, Some(Language::En));
    assert_eq!(s.palette, Some(Palette::Pine));
    assert_eq!(s.accent_color.as_deref(), Some("#000000"));
    assert_eq!(s.key_folder.as_deref(), Some("~/mine"));
    assert_eq!(s.default_key_type, Some(KeyType::Rsa4096));
    assert_eq!(s.terminal_font_size, Some(20));
    s.language = Some(Language::Fr);
    s.apply(&patch);
    assert_eq!(s.theme, Some(ThemeMode::Light));
    assert_eq!(s.language, Some(Language::En));
    assert_eq!(s.key_folder.as_deref(), Some("~/k"));
    assert_eq!(s.accent_color.as_deref(), Some("#112233"));
    s.apply(&SettingsPatch {
        key_folder: Some(None),
        accent_color: Some(None),
        ..SettingsPatch::default()
    });
    assert_eq!(s.key_folder, None);
    assert_eq!(s.accent_color, None);
    assert_eq!(s.palette, Some(Palette::Pine));
    assert_eq!(s.theme, Some(ThemeMode::Light));

    let mut cleared = Settings::default();
    cleared.fill(&SettingsPatch {
        accent_color: Some(None),
        ..SettingsPatch::default()
    });
    assert_eq!(cleared.accent_color, None);
}

#[test]
fn accent_colors_are_six_hex_digits_lowercased() {
    assert_eq!(accent_color("#A1b2C3").as_deref(), Some("#a1b2c3"));
    assert_eq!(accent_color("#000000").as_deref(), Some("#000000"));
    for bad in [
        "",
        "#",
        "#fff",
        "#ffff",
        "#fffffff",
        "#ffffffff",
        "ffffff",
        "##fffff",
        "#gggggg",
        "red",
        " #ffffff",
        "#ffffff\n",
        "#ｆｆｆｆｆｆ",
        "#ff ff f",
    ] {
        assert_eq!(accent_color(bad), None, "{bad}");
    }
}

#[test]
fn an_unknown_palette_or_accent_survives_an_unrelated_write() {
    let text =
        "palette = \"aurora\" # from a newer version\naccent_color = \"#ABC\"\ntheme = \"dark\"\n";
    let mut doc = parse_document(text).unwrap();
    let before = read(&doc);
    assert_eq!(
        (before.palette, before.accent_color.as_deref()),
        (None, None)
    );
    let mut after = before.clone();
    after.theme = Some(ThemeMode::Light);
    write(&mut doc, &before, &after);
    let out = doc.to_string();
    assert_eq!(
        out,
        "palette = \"aurora\" # from a newer version\naccent_color = \"#ABC\"\ntheme = \"light\"\n"
    );

    let before = read(&doc);
    let mut after = before.clone();
    after.palette = Some(Palette::Plum);
    after.accent_color = Some("#0a0b0c".into());
    write(&mut doc, &before, &after);
    let out = doc.to_string();
    assert!(
        out.starts_with("palette = \"plum\" # from a newer version\naccent_color = \"#0a0b0c\"\n"),
        "{out}"
    );
    assert_eq!(read(&parse_document(&out).unwrap()), after);

    let before = after;
    let mut after = before.clone();
    after.accent_color = None;
    after.palette = None;
    write(&mut doc, &before, &after);
    let out = doc.to_string();
    assert!(
        !out.contains("accent_color") && !out.contains("palette"),
        "{out}"
    );
    assert!(out.contains("theme = \"light\""), "{out}");
}

/// Runs on a small stack, so a parse that recursed without a bound would abort the test run.
fn parses_on_a_small_stack(text: String) -> bool {
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || parse(&text).is_ok())
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn deep_nesting_is_refused_before_the_parser_sees_it() {
    for open in ["[", "{a = ", "[{a = "] {
        let text = format!("a = {}", open.repeat(100_000));
        assert!(!parses_on_a_small_stack(text), "{open}");
    }
    let nested = |n: usize| format!("a = {}1{}", "[".repeat(n), "]".repeat(n));
    assert_eq!(nesting(&nested(MAX_NESTING)), MAX_NESTING);
    assert!(parses_on_a_small_stack(nested(MAX_NESTING)));
    assert!(parses_on_a_small_stack(format!(
        "a = {}",
        "{b = ".repeat(MAX_NESTING) + "1" + &"}".repeat(MAX_NESTING)
    )));
    assert!(parse(&nested(MAX_NESTING + 1)).is_err());
}

#[test]
fn brackets_in_strings_and_comments_do_not_count() {
    let deep = "[".repeat(100);
    for text in [
        format!("a = \"{deep}\""),
        format!("a = '{deep}'"),
        format!("a = \"\"\"\n{deep}\n\"\"\""),
        format!("a = '''{deep}'''"),
        format!("# {deep}\na = 1"),
        format!("a = \"\\\"{deep}\""),
    ] {
        assert_eq!(nesting(&text), 0, "{text}");
        assert!(parse(&text).is_ok(), "{text}");
    }
}

#[test]
fn string_endings_cannot_hide_brackets() {
    let deep = "[".repeat(1000);
    for prefix in [
        "a = \"\"\"x\"\"\"\"\"",
        "a = '''x'''''",
        "a = \"\"\"x\"\"\"\"",
        "a = \"x\\\\\"",
        "a = 'x\'",
        "a = \"\"",
        "a = ''",
        "a = \"\"\"\"\"\"",
        "a = \"x\n",
    ] {
        let text = format!("{prefix}\nb = {deep}");
        assert!(nesting(&text) > MAX_NESTING, "{prefix}");
        assert!(!parses_on_a_small_stack(text), "{prefix}");
    }
}

#[test]
fn a_write_edits_only_the_changed_values() {
    let text = r#"# my settings
unknown = "kept"   # mine too
theme = "dark" # night
language = "fr" # mine
terminal_font_size = 99

[external_editor]
mode = "system"
extra = 1

[analytics]
launch = { consent = "denied", version = 2 }
"#;
    let mut doc = parse_document(text).unwrap();
    let before = read(&doc);
    assert_eq!(before.terminal_font_size, None);
    let mut after = before.clone();
    after.theme = Some(ThemeMode::Light);
    after.language = Some(Language::En);
    after.external_editor = Some(ExternalEditor {
        mode: EditorMode::Custom,
        app_path: Some("/usr/bin/vi".into()),
        notice_seen: true,
    });
    let mut a = after.analytics.unwrap();
    a.categories.launch = granted(2);
    a.categories.features = granted(2);
    after.analytics = Some(a);
    write(&mut doc, &before, &after);
    let out = doc.to_string();
    assert!(
        out.starts_with("# my settings\nunknown = \"kept\"   # mine too\n"),
        "{out}"
    );
    assert!(
        out.contains("theme = \"light\" # night\nlanguage = \"en\" # mine\n"),
        "{out}"
    );
    assert!(out.contains("terminal_font_size = 99\n"), "{out}");
    assert!(out.contains("extra = 1"), "{out}");
    assert_eq!(read(&parse_document(&out).unwrap()), after);

    let mut cleared = after.clone();
    cleared.analytics = None;
    cleared.external_editor = None;
    cleared.theme = None;
    cleared.language = None;
    write(&mut doc, &after, &cleared);
    let out = doc.to_string();
    assert!(
        !out.contains("analytics") && !out.contains("external_editor"),
        "{out}"
    );
    assert!(!out.contains("theme") && !out.contains("language"), "{out}");
    assert!(
        out.contains("# my settings") && out.contains("unknown"),
        "{out}"
    );
}

#[test]
fn a_value_of_the_wrong_kind_is_replaced_when_set() {
    let mut doc = parse_document("external_editor = \"vi\"\nanalytics = 3\n").unwrap();
    let before = read(&doc);
    let mut after = before.clone();
    after.external_editor = Some(ExternalEditor::default());
    after.analytics = Some(AnalyticsSettings {
        categories: CategoryChoices::all(granted(2)),
    });
    write(&mut doc, &before, &after);
    assert_eq!(read(&parse_document(&doc.to_string()).unwrap()), after);
}

#[test]
fn updates_are_read_key_by_key() {
    let read = |text: &str| parse(text).unwrap().updates;
    assert_eq!(read(""), UpdateSettings::default());
    assert_eq!(
        read(
            "[updates]
auto_check = false
skipped_version = \"1.2.3-rc.1\"
"
        ),
        UpdateSettings {
            auto_check: Some(false),
            skipped_version: Some("1.2.3-rc.1".into()),
        }
    );
    for text in [
        "updates = 3",
        "[updates]
auto_check = \"no\"
skipped_version = 3",
        "[updates]
skipped_version = \"v1.2.3\"",
        "[updates]
skipped_version = \"1.2.3+meta\"",
        "[updates]
skipped_version = \"../x\"",
    ] {
        assert_eq!(read(text), UpdateSettings::default(), "{text}");
    }
    assert_eq!(
        read(
            "[updates]
auto_check = true
skipped_version = \"x\""
        ),
        UpdateSettings {
            auto_check: Some(true),
            skipped_version: None,
        }
    );
}

#[test]
fn updates_writes_keep_what_the_app_could_not_read() {
    let text = "[updates]
# mine
auto_check = \"no\"
other = 1
";
    let mut doc = parse_document(text).unwrap();
    let before = read(&doc);
    let mut after = before.clone();
    after.updates.skipped_version = Some("0.3.0".into());
    write(&mut doc, &before, &after);
    let out = doc.to_string();
    assert!(
        out.contains(
            "# mine
auto_check = \"no\""
        ),
        "{out}"
    );
    assert!(out.contains("other = 1"), "{out}");
    assert!(out.contains("skipped_version = \"0.3.0\""), "{out}");
    assert_eq!(parse(&out).unwrap().updates, after.updates);

    let mut doc = parse_document(
        "theme = \"dark\"
[updates]
auto_check = false
",
    )
    .unwrap();
    let before = read(&doc);
    let mut after = before.clone();
    after.updates.auto_check = None;
    write(&mut doc, &before, &after);
    assert_eq!(
        doc.to_string(),
        "theme = \"dark\"
"
    );
}
