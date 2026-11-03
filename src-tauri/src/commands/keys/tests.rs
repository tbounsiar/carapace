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
            "id": "i", "name": "n", "path": "/k", "managed": true, "algorithm": "rsa",
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
