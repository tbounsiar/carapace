use std::fs;

use russh::keys::ssh_key::LineEnding;
use secrecy::{ExposeSecret, SecretString};

use super::*;
use crate::commands::resolve::registered_keys;
use crate::secrets::MemoryBackend;
use crate::ssh::test_server::ed25519;

struct World {
    dir: tempfile::TempDir,
    store: ConfigStore,
    secrets: SecretStore,
    mem: std::sync::Arc<MemoryBackend>,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let store = ConfigStore::new(dir.path().join("home"));
    let (secrets, mem) = MemoryBackend::store();
    World {
        dir,
        store,
        secrets,
        mem,
    }
}

fn pass() -> SecretString {
    SecretString::from(uuid::Uuid::new_v4().simple().to_string())
}

fn request(
    name: &str,
    file: &str,
    passphrase: Option<SecretString>,
    remember: bool,
) -> GenerateRequest {
    GenerateRequest {
        name: name.into(),
        file_name: file.into(),
        dir: None,
        algorithm: KeyType::Ed25519,
        comment: "carapace".into(),
        passphrase,
        remember_passphrase: remember,
    }
}

fn external_key(w: &World, name: &str, passphrase: Option<&SecretString>) -> String {
    let mut key = ed25519(3);
    key.set_comment("ext");
    if let Some(p) = passphrase {
        key = key
            .encrypt(&mut rand::rng(), p.expose_secret().as_bytes())
            .unwrap();
    }
    let path = w.dir.path().join(name);
    fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
    path.to_string_lossy().into_owned()
}

fn config_text(w: &World) -> String {
    fs::read_to_string(w.store.dir().join("config.json")).unwrap()
}

#[tokio::test]
async fn generate_registers_a_managed_key_and_remembers_only_when_asked() {
    let w = world();
    let plain = generate(
        &w.store,
        &w.secrets,
        request("Work", "id_ed25519", None, false),
    )
    .await
    .unwrap();
    assert!(plain.key.managed && !plain.has_passphrase && !plain.key.encrypted);
    assert_eq!(plain.warning, None);
    assert!(w.mem.accounts().is_empty());
    let expected = crate::fsutil::canonical(&keys_dir_of(&w.store).join("id_ed25519")).unwrap();
    assert_eq!(plain.key.path, expected.to_string_lossy());

    let p = pass();
    let enc = generate(
        &w.store,
        &w.secrets,
        request(
            "Deploy",
            "deploy",
            Some(SecretString::from(p.expose_secret())),
            true,
        ),
    )
    .await
    .unwrap();
    assert!(enc.key.encrypted && enc.has_passphrase);
    assert_eq!(
        w.mem
            .raw(&format!("key/{}/passphrase", enc.key.id))
            .as_deref(),
        Some(p.expose_secret())
    );
    let json = serde_json::to_string(&enc).unwrap();
    assert!(!json.contains(p.expose_secret()));
    assert!(!config_text(&w).contains(p.expose_secret()));
    assert!(!config_text(&w).contains("PRIVATE"));

    let listed = list(&w.store, &w.secrets).unwrap();
    assert_eq!(listed, vec![plain, enc]);
}

#[tokio::test]
async fn generate_refuses_before_any_work() {
    let w = world();
    generate(&w.store, &w.secrets, request("Work", "a", None, false))
        .await
        .unwrap();
    let code = |r: Res<KeyView>| r.unwrap_err().code;
    assert_eq!(
        code(generate(&w.store, &w.secrets, request("WORK", "b", None, false)).await),
        "already_exists"
    );
    assert_eq!(
        code(generate(&w.store, &w.secrets, request("Other", "a", None, false)).await),
        "already_exists"
    );
    assert_eq!(
        code(generate(&w.store, &w.secrets, request("Other", "b", None, true)).await),
        "invalid_input"
    );
    let long = SecretString::from("x".repeat(1025));
    assert_eq!(
        code(
            generate(
                &w.store,
                &w.secrets,
                request("Other", "b", Some(long), false)
            )
            .await
        ),
        "invalid_input"
    );
    assert_eq!(
        code(generate(&w.store, &w.secrets, request(" ", "b", None, false)).await),
        "invalid_input"
    );
    assert_eq!(
        code(generate(&w.store, &w.secrets, request("Other", "../b", None, false)).await),
        "invalid_input"
    );
    let mut names: Vec<_> = fs::read_dir(keys_dir_of(&w.store))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec!["a", "a.pub"]);
}

#[tokio::test]
async fn a_keychain_failure_keeps_the_key_and_says_so() {
    let w = world();
    w.mem.set_failing(true);
    let err = generate(&w.store, &w.secrets, request("K", "k", Some(pass()), true))
        .await
        .unwrap_err();
    assert_eq!(err.code, "keychain_unavailable");
    w.mem.set_failing(false);
    let listed = list(&w.store, &w.secrets).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].has_passphrase);
}

#[tokio::test]
async fn import_verifies_the_passphrase_before_storing_it() {
    let w = world();
    let p = pass();
    let path = external_key(&w, "id_enc", Some(&p));
    let wrong = import(
        &w.store,
        &w.secrets,
        "E".into(),
        path.clone(),
        Some(pass()),
        true,
    )
    .await;
    assert_eq!(wrong.unwrap_err().code, "invalid_passphrase");
    assert!(w.mem.accounts().is_empty());
    assert!(list(&w.store, &w.secrets).unwrap().is_empty());

    let v = import(
        &w.store,
        &w.secrets,
        "E".into(),
        path.clone(),
        Some(SecretString::from(p.expose_secret())),
        true,
    )
    .await
    .unwrap();
    assert!(!v.key.managed && v.key.encrypted && v.has_passphrase);
    assert_eq!(v.key.comment, "ext");
    let again = import(&w.store, &w.secrets, "F".into(), path, None, false).await;
    assert_eq!(again.unwrap_err().code, "already_exists");

    let plain = external_key(&w, "id_plain", None);
    let v = import(&w.store, &w.secrets, " Plain ".into(), plain, None, false)
        .await
        .unwrap();
    assert_eq!(v.key.name, "Plain");
    assert!(!v.key.encrypted && !v.has_passphrase);
}

#[tokio::test]
async fn rename_delete_and_forget() {
    let w = world();
    let managed = generate(&w.store, &w.secrets, request("M", "m", Some(pass()), true))
        .await
        .unwrap();
    let ext_path = external_key(&w, "ext", None);
    let ext = import(
        &w.store,
        &w.secrets,
        "X".into(),
        ext_path.clone(),
        None,
        false,
    )
    .await
    .unwrap();

    assert_eq!(
        rename(&w.store, &w.secrets, &ext.key.id, "Y")
            .unwrap()
            .key
            .name,
        "Y"
    );
    assert_eq!(
        rename(&w.store, &w.secrets, &ext.key.id, "m")
            .unwrap_err()
            .code,
        "already_exists"
    );
    assert_eq!(
        rename(&w.store, &w.secrets, "nope", "Z").unwrap_err().code,
        "not_found"
    );

    assert_eq!(
        delete(&w.store, &w.secrets, &ext.key.id, true)
            .unwrap_err()
            .code,
        "invalid_input"
    );
    delete(&w.store, &w.secrets, &ext.key.id, false).unwrap();
    assert!(
        fs::metadata(&ext_path).is_ok(),
        "an imported key file is never deleted"
    );

    forget_passphrase(&w.store, &w.secrets, &managed.key.id).unwrap();
    assert!(w.mem.accounts().is_empty());
    assert!(!list(&w.store, &w.secrets).unwrap()[0].has_passphrase);
    w.secrets
        .set_key_passphrase(&KeyPassKey::new(&managed.key.id).unwrap(), &pass())
        .unwrap();
    delete(&w.store, &w.secrets, &managed.key.id, true).unwrap();
    assert!(w.mem.accounts().is_empty());
    assert!(
        fs::read_dir(keys_dir_of(&w.store))
            .unwrap()
            .next()
            .is_none()
    );
    assert!(list(&w.store, &w.secrets).unwrap().is_empty());
    assert_eq!(
        delete(&w.store, &w.secrets, &managed.key.id, false)
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(
        forget_passphrase(&w.store, &w.secrets, " ")
            .unwrap_err()
            .code,
        "invalid_input"
    );
}

#[tokio::test]
async fn managed_files_stay_when_only_unlisted() {
    let w = world();
    let k = generate(&w.store, &w.secrets, request("M", "m", None, false))
        .await
        .unwrap();
    delete(&w.store, &w.secrets, &k.key.id, false).unwrap();
    assert!(fs::metadata(&k.key.path).is_ok());
}

#[tokio::test]
async fn encrypted_registered_keys_are_auth_candidates_by_fingerprint() {
    let w = world();
    generate(&w.store, &w.secrets, request("Plain", "p", None, false))
        .await
        .unwrap();
    let enc = generate(
        &w.store,
        &w.secrets,
        request("Enc", "e", Some(pass()), false),
    )
    .await
    .unwrap();
    let found = registered_keys(&w.store.snapshot().unwrap());
    assert_eq!(
        found,
        vec![crate::ssh::RegisteredKey {
            fingerprint: enc.key.fingerprint.clone(),
            passphrase: KeyPassKey::new(&enc.key.id).unwrap(),
        }]
    );
}

#[tokio::test]
async fn delete_stops_before_the_config_when_the_keychain_fails() {
    let w = world();
    let k = generate(&w.store, &w.secrets, request("M", "m", Some(pass()), true))
        .await
        .unwrap();
    w.mem.set_failing(true);
    let err = delete(&w.store, &w.secrets, &k.key.id, true).unwrap_err();
    assert_eq!(err.code, "keychain_unavailable");
    w.mem.set_failing(false);
    assert_eq!(list(&w.store, &w.secrets).unwrap().len(), 1);
    assert!(fs::metadata(&k.key.path).is_ok());
    assert_eq!(w.mem.accounts().len(), 1);
}

#[test]
fn views_serialize_in_camel_case() {
    let view = KeyView {
        key: KeyEntry {
            id: "i".into(),
            name: "n".into(),
            path: "/k".into(),
            managed: true,
            origin: KeyOrigin::Generated,
            algorithm: crate::config::KeyAlgorithm::Rsa,
            bits: Some(4096),
            public_key: "ssh-rsa AAAA c".into(),
            fingerprint: "SHA256:x".into(),
            comment: "c".into(),
            encrypted: false,
        },
        has_passphrase: true,
        warning: None,
    };
    assert_eq!(
        serde_json::to_value(&view).unwrap(),
        serde_json::json!({
            "id": "i", "name": "n", "path": "/k", "managed": true, "origin": "generated", "algorithm": "rsa",
            "bits": 4096, "publicKey": "ssh-rsa AAAA c", "fingerprint": "SHA256:x",
            "comment": "c", "encrypted": false, "hasPassphrase": true, "warning": null
        })
    );
    assert_eq!(
        serde_json::to_value(DeployResult {
            added: false,
            restricted: true
        })
        .unwrap(),
        serde_json::json!({ "added": false, "restricted": true })
    );
    let kind: KeyType = serde_json::from_str("\"rsa4096\"").unwrap();
    assert_eq!(kind, KeyType::Rsa4096);
    assert!(serde_json::from_str::<KeyType>("\"rsa\"").is_err());
}

#[test]
fn keys_dir_is_under_the_app_home() {
    let w = world();
    assert_eq!(keys_dir_of(&w.store), w.store.dir().join("keys"));
    assert!(display(&keys_dir_of(&w.store)).unwrap().ends_with("keys"));
}

fn custom_request(name: &str, file: &str, dir: &std::path::Path) -> GenerateRequest {
    GenerateRequest {
        dir: Some(dir.to_string_lossy().into_owned()),
        ..request(name, file, None, false)
    }
}

/// Only the current user can open it (a plain temp dir inherits a broad ACL on this machine).
fn private_dir(w: &World, name: &str) -> std::path::PathBuf {
    let dir = w.dir.path().join(name);
    crate::fsutil::ensure_dir_owner_only(&dir).unwrap();
    crate::fsutil::canonical(&dir).unwrap()
}

fn some(p: &std::path::Path) -> Option<String> {
    Some(p.to_string_lossy().into_owned())
}

#[tokio::test]
async fn check_key_location_reports_what_generation_would_refuse() {
    let w = world();
    let default = check_location(&w.store, None, "id_ed25519".into())
        .await
        .unwrap();
    assert!(default.is_default && default.warning.is_none());
    assert_eq!(default.dir, display(&keys_dir_of(&w.store)).unwrap());

    let own = private_dir(&w, "own");
    let custom = check_location(&w.store, some(&own), "id_work".into())
        .await
        .unwrap();
    assert_eq!(
        custom,
        KeyLocationView {
            dir: display(&own).unwrap(),
            is_default: false,
            warning: None
        }
    );
    assert_eq!(
        serde_json::to_value(&custom).unwrap(),
        serde_json::json!({ "dir": display(&own).unwrap(), "isDefault": false, "warning": null })
    );

    let shared = w.dir.path().join("shared");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
    }
    #[cfg(windows)]
    crate::fsutil::create_dir_with_sddl(&shared, "D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;%ME%)").unwrap();
    let warned = check_location(&w.store, some(&shared), "k".into())
        .await
        .unwrap();
    assert!(warned.warning.is_some() && !warned.is_default);

    let e = check_location(&w.store, some(&w.dir.path().join("missing")), "k".into())
        .await
        .unwrap_err();
    assert_eq!(e.code, "not_found");
    assert_eq!(e.message, "This folder does not exist.");
    fs::write(own.join("id_work.pub"), b"x").unwrap();
    let e = check_location(&w.store, some(&own), "id_work".into())
        .await
        .unwrap_err();
    assert_eq!(e.code, "already_exists");
    assert_eq!(
        e.message,
        "id_work or id_work.pub already exists in this folder."
    );
    let e = check_location(&w.store, Some("relative".into()), "k".into()).await;
    assert_eq!(e.unwrap_err().code, "invalid_input");
    let e = check_location(&w.store, some(&own), "../k".into()).await;
    assert_eq!(e.unwrap_err().code, "invalid_input");
    let file = own.join("plain-file");
    fs::write(&file, b"").unwrap();
    let e = check_location(&w.store, some(&file), "k".into()).await;
    assert_eq!(e.unwrap_err().code, "invalid_input");
}

#[tokio::test]
async fn network_paths_are_refused_by_every_key_command() {
    let w = world();
    for raw in crate::fsutil::NON_LOCAL {
        let request = GenerateRequest {
            dir: Some((*raw).into()),
            ..request("N", "n", None, false)
        };
        let e = generate(&w.store, &w.secrets, request).await.unwrap_err();
        assert_eq!(e.code, "invalid_input", "{raw}");
        let e = check_location(&w.store, Some((*raw).into()), "n".into()).await;
        assert_eq!(e.unwrap_err().code, "invalid_input", "{raw}");
        let e = import(&w.store, &w.secrets, "N".into(), (*raw).into(), None, false).await;
        assert_eq!(e.unwrap_err().code, "invalid_input", "{raw}");
    }
    assert!(list(&w.store, &w.secrets).unwrap().is_empty());
}

#[tokio::test]
async fn generate_into_a_custom_folder() {
    let w = world();
    let own = private_dir(&w, "own");
    let p = pass();
    let v = generate(
        &w.store,
        &w.secrets,
        GenerateRequest {
            passphrase: Some(SecretString::from(p.expose_secret())),
            remember_passphrase: true,
            ..custom_request("Custom", "id_work", &own)
        },
    )
    .await
    .unwrap();
    assert_eq!(v.key.path, display(&own.join("id_work")).unwrap());
    assert!(!v.key.managed && v.key.origin == KeyOrigin::Generated && v.has_passphrase);
    assert_eq!(v.warning, None);
    assert!(crate::fsutil::is_owner_only(
        &fs::File::open(&v.key.path).unwrap()
    ));
    assert!(own.join("id_work.pub").is_file());
    assert!(!keys_dir_of(&w.store).exists());
    assert_eq!(serde_json::to_value(&v).unwrap()["origin"], "generated");
    assert!(!config_text(&w).contains(p.expose_secret()));

    let again = generate(
        &w.store,
        &w.secrets,
        custom_request("Other", "id_work", &own),
    )
    .await;
    assert_eq!(again.unwrap_err().code, "already_exists");
    let missing = w.dir.path().join("missing");
    let e = generate(&w.store, &w.secrets, custom_request("Other", "k", &missing)).await;
    assert_eq!(e.unwrap_err().code, "not_found");

    let m = generate(&w.store, &w.secrets, request("M", "m", None, false))
        .await
        .unwrap();
    assert!(m.key.managed && m.key.origin == KeyOrigin::Generated);
    let same = generate(
        &w.store,
        &w.secrets,
        custom_request("Managed", "m2", &keys_dir_of(&w.store)),
    )
    .await
    .unwrap();
    assert!(
        same.key.managed,
        "the managed dir chosen by path is still managed"
    );
}

#[tokio::test]
async fn delete_files_of_a_key_generated_elsewhere() {
    let w = world();
    let own = private_dir(&w, "own");
    let k = generate(
        &w.store,
        &w.secrets,
        GenerateRequest {
            passphrase: Some(pass()),
            remember_passphrase: true,
            ..custom_request("K", "k", &own)
        },
    )
    .await
    .unwrap();
    let other = generate(&w.store, &w.secrets, custom_request("O", "o", &own))
        .await
        .unwrap();

    fs::remove_file(&k.key.path).unwrap();
    fs::copy(&other.key.path, &k.key.path).unwrap();
    let e = delete(&w.store, &w.secrets, &k.key.id, true).unwrap_err();
    assert_eq!(e.code, "conflict");
    assert_eq!(
        e.message,
        "The file at this path no longer holds this key. Nothing was deleted."
    );
    assert_eq!(list(&w.store, &w.secrets).unwrap().len(), 2);
    assert_eq!(w.mem.accounts().len(), 1, "the passphrase is kept too");
    assert!(own.join("k.pub").exists());

    fs::remove_file(&k.key.path).unwrap();
    delete(&w.store, &w.secrets, &k.key.id, true).unwrap();
    assert!(!own.join("k.pub").exists());
    assert!(w.mem.accounts().is_empty());

    delete(&w.store, &w.secrets, &other.key.id, true).unwrap();
    assert!(fs::read_dir(&own).unwrap().next().is_none());
    assert!(list(&w.store, &w.secrets).unwrap().is_empty());
}

#[tokio::test]
async fn delete_refuses_a_link_in_place_of_the_key() {
    let w = world();
    let own = private_dir(&w, "own");
    let k = generate(&w.store, &w.secrets, custom_request("K", "k", &own))
        .await
        .unwrap();
    let moved = own.join("moved");
    fs::rename(&k.key.path, &moved).unwrap();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&moved, &k.key.path).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&moved, &k.key.path).is_ok();
    if linked {
        let e = delete(&w.store, &w.secrets, &k.key.id, true).unwrap_err();
        assert_eq!(e.code, "conflict");
        assert!(moved.exists());
        assert_eq!(list(&w.store, &w.secrets).unwrap().len(), 1);
    }
}

#[tokio::test]
async fn imported_files_are_never_deleted_whatever_the_folder() {
    let w = world();
    let own = private_dir(&w, "own");
    let path = own.join("id_imported");
    fs::write(
        &path,
        ed25519(9).to_openssh(LineEnding::LF).unwrap().as_bytes(),
    )
    .unwrap();
    let v = import(
        &w.store,
        &w.secrets,
        "I".into(),
        path.to_string_lossy().into_owned(),
        None,
        false,
    )
    .await
    .unwrap();
    assert_eq!(v.key.origin, KeyOrigin::Imported);
    let e = delete(&w.store, &w.secrets, &v.key.id, true).unwrap_err();
    assert_eq!(e.code, "invalid_input");
    assert!(path.exists());
}

#[tokio::test]
async fn old_entries_get_an_origin_from_their_folder() {
    let w = world();
    let managed = generate(&w.store, &w.secrets, request("M", "m", None, false))
        .await
        .unwrap();
    let ext = import(
        &w.store,
        &w.secrets,
        "X".into(),
        external_key(&w, "ext", None),
        None,
        false,
    )
    .await
    .unwrap();
    let mut cfg: serde_json::Value = serde_json::from_str(&config_text(&w)).unwrap();
    for k in cfg["keys"].as_array_mut().unwrap() {
        k.as_object_mut().unwrap().remove("origin");
    }
    fs::write(w.store.dir().join("config.json"), cfg.to_string()).unwrap();
    let listed = list(&w.store, &w.secrets).unwrap();
    assert_eq!(listed[0].key.id, managed.key.id);
    assert_eq!(listed[0].key.origin, KeyOrigin::Generated);
    assert_eq!(listed[1].key.id, ext.key.id);
    assert_eq!(listed[1].key.origin, KeyOrigin::Imported);
    delete(&w.store, &w.secrets, &managed.key.id, true).unwrap();
    assert!(!std::path::Path::new(&managed.key.path).exists());
    let e = delete(&w.store, &w.secrets, &ext.key.id, true).unwrap_err();
    assert_eq!(e.code, "invalid_input");
}

#[tokio::test]
async fn a_swapped_managed_key_is_not_deleted() {
    let w = world();
    let a = generate(&w.store, &w.secrets, request("A", "a", None, false))
        .await
        .unwrap();
    let b = generate(&w.store, &w.secrets, request("B", "b", None, false))
        .await
        .unwrap();
    fs::remove_file(&a.key.path).unwrap();
    fs::copy(&b.key.path, &a.key.path).unwrap();
    let e = delete(&w.store, &w.secrets, &a.key.id, true).unwrap_err();
    assert_eq!(e.code, "conflict");
    assert!(std::path::Path::new(&a.key.path).exists());
}
