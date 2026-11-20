use super::*;
use crate::updates::InstallKind;

fn store() -> (tempfile::TempDir, ConfigStore) {
    let dir = tempfile::tempdir().unwrap();
    let s = ConfigStore::new(dir.path().to_path_buf());
    (dir, s)
}

#[test]
fn skip_validates_the_version_and_stores_it() {
    let (d, s) = store();
    let u = AppUpdates::new("0.2.0", InstallKind::InPlace);
    for bad in ["", "v0.3.0", "0.3.0+x", "../0.3.0", "0.3"] {
        let e = skip_in(&s, &u, bad).unwrap_err();
        assert_eq!(e.code, "invalid_input");
        assert_eq!(e.key, Some("errors.updates.invalidVersion"));
        assert!(!e.message.contains(bad) || bad.is_empty());
    }
    assert!(!d.path().join("settings.toml").exists());
    let state = skip_in(&s, &u, "0.3.0").unwrap();
    assert_eq!(state.skipped_version.as_deref(), Some("0.3.0"));
    assert!(state.auto_check);
    let text = std::fs::read_to_string(d.path().join("settings.toml")).unwrap();
    assert_eq!(text, "[updates]\nskipped_version = \"0.3.0\"\n");
    assert_eq!(prefs(&s).skipped.as_deref(), Some("0.3.0"));
}

#[test]
fn auto_check_follows_the_stored_value() {
    let (_d, s) = store();
    assert!(prefs(&s).auto_check);
    s.set_update_auto_check(false).unwrap();
    assert!(!prefs(&s).auto_check);
    s.set_update_auto_check(true).unwrap();
    assert!(prefs(&s).auto_check);
}

#[test]
fn a_settings_file_that_cannot_be_read_stops_the_automatic_check() {
    let (d, s) = store();
    std::fs::write(d.path().join("settings.toml"), "[updates").unwrap();
    assert_eq!(
        prefs(&s),
        Prefs {
            auto_check: false,
            skipped: None
        }
    );
}

#[test]
fn update_errors_map_to_command_errors() {
    let e = CommandError::from(UpdateError::Signature);
    let json = serde_json::to_value(&e).unwrap();
    assert_eq!(json["code"], "signature_invalid");
    assert_eq!(json["key"], "errors.updates.signature");
    assert!(json.get("params").is_none());
    assert_eq!(
        CommandError::from(UpdateError::NotUploaded).code,
        "not_uploaded"
    );
    assert_eq!(CommandError::from(UpdateError::Busy).code, "busy");
}
