use std::fs;
use std::path::Path;
use std::time::Instant;

use russh::keys::ssh_key::LineEnding;
use secrecy::SecretString;

use super::deploy::replace_file;
use super::file;
use super::file::{MAX_KEY_FILE_BYTES, validate_comment};
use super::*;
use crate::config::KeyAlgorithm;
use crate::files::FsError;
use crate::fsutil::is_owner_only;
use crate::sftp::{Remote, SftpManager};
use crate::ssh::test_server::{Connected, TestServer, ed25519, manager_for, start_server};
use crate::ssh::test_sftp::HOME;

fn passphrase() -> SecretString {
    SecretString::from(uuid::Uuid::new_v4().simple().to_string())
}

fn names(dir: &Path) -> Vec<String> {
    let mut n: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    n.sort();
    n
}

fn text(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn generates_an_owner_only_ed25519_key_pair() {
    let home = tempfile::tempdir().unwrap();
    let dir = keys_dir(home.path());
    let g = generate(&dir, "id_ed25519", KeyType::Ed25519, " me@box ", None).unwrap();
    assert_eq!(
        g.path,
        crate::fsutil::canonical(&dir.join("id_ed25519")).unwrap()
    );
    assert_eq!(names(&dir), vec!["id_ed25519", "id_ed25519.pub"]);
    assert!(is_owner_only(&fs::File::open(&g.path).unwrap()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let info = &g.info;
    assert_eq!(info.algorithm, KeyAlgorithm::Ed25519);
    assert_eq!(info.bits, None);
    assert_eq!(info.comment, "me@box");
    assert!(!info.encrypted);
    assert!(info.fingerprint.starts_with("SHA256:"));
    assert!(info.public_key.starts_with("ssh-ed25519 "));
    assert!(info.public_key.ends_with(" me@box"));
    assert_eq!(
        text(&dir.join("id_ed25519.pub")),
        format!("{}\n", info.public_key)
    );
    let key = russh::keys::decode_secret_key(&text(&g.path), None).unwrap();
    assert_eq!(key.public_key().to_openssh().unwrap(), info.public_key);
}

#[test]
fn encrypted_key_decodes_only_with_its_passphrase() {
    let home = tempfile::tempdir().unwrap();
    let dir = keys_dir(home.path());
    let pp = passphrase();
    let g = generate(&dir, "enc", KeyType::Ed25519, "c", Some(&pp)).unwrap();
    assert!(g.info.encrypted);
    let pem = text(&g.path);
    assert!(matches!(
        russh::keys::decode_secret_key(&pem, None),
        Err(russh::keys::Error::KeyIsEncrypted)
    ));
    assert!(russh::keys::decode_secret_key(&pem, Some("wrong")).is_err());
    use secrecy::ExposeSecret;
    russh::keys::decode_secret_key(&pem, Some(pp.expose_secret())).unwrap();

    let path = path_str(&g.path);
    let (_, found) = inspect(&path, None).unwrap();
    assert!(found.encrypted);
    assert_eq!(found.comment, "c", "taken from the .pub sibling");
    assert_eq!(found.fingerprint, g.info.fingerprint);
    let (_, found) = inspect(&path, Some(&pp)).unwrap();
    assert_eq!(found.comment, "c");
    assert_eq!(
        inspect(&path, Some(&passphrase())).unwrap_err(),
        KeyError::InvalidPassphrase
    );
}

#[test]
fn never_replaces_an_existing_file() {
    let home = tempfile::tempdir().unwrap();
    let dir = keys_dir(home.path());
    generate(&dir, "a", KeyType::Ed25519, "", None).unwrap();
    let before = text(&dir.join("a"));
    let err = generate(&dir, "a", KeyType::Ed25519, "", None).unwrap_err();
    assert_eq!(err.code(), "already_exists");
    assert_eq!(text(&dir.join("a")), before);
    fs::write(dir.join("b.pub"), "x").unwrap();
    assert_eq!(
        generate(&dir, "b", KeyType::Ed25519, "", None)
            .unwrap_err()
            .code(),
        "already_exists"
    );
    assert_eq!(names(&dir), vec!["a", "a.pub", "b.pub"]);
}

#[test]
fn rejects_bad_names_comments_and_passphrases() {
    let home = tempfile::tempdir().unwrap();
    let dir = keys_dir(home.path());
    let long = "a".repeat(65);
    let mut bad = vec!["", ".hidden", "a/b", "a\\b", "a b", "é", long.as_str()];
    if cfg!(windows) {
        bad.extend(["CON", "nul.txt", "a."]);
    }
    for name in bad {
        let err = generate(&dir, name, KeyType::Ed25519, "", None).unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{name:?}");
    }
    assert!(validate_file_name(&"a".repeat(64)).is_ok());
    assert!(validate_file_name("id_ed25519.work-1").is_ok());
    assert!(validate_comment("a\nb").is_err());
    assert!(validate_comment(&"c".repeat(256)).is_err());
    assert!(validate_passphrase(&SecretString::from("")).is_err());
    let err = validate_passphrase(&SecretString::from("p".repeat(1025))).unwrap_err();
    assert!(!err.to_string().contains("ppp"));
    assert!(validate_passphrase(&SecretString::from("p".repeat(1024))).is_ok());
    assert!(!dir.exists() || names(&dir).is_empty());
}

#[test]
fn generates_an_encrypted_rsa_4096_key() {
    let home = tempfile::tempdir().unwrap();
    let dir = keys_dir(home.path());
    let started = Instant::now();
    let g = generate(&dir, "id_rsa", KeyType::Rsa4096, "rsa", Some(&passphrase())).unwrap();
    eprintln!("RSA 4096 generated in {:?}", started.elapsed());
    assert_eq!(g.info.algorithm, KeyAlgorithm::Rsa);
    assert_eq!(g.info.bits, Some(4096));
    assert!(g.info.public_key.starts_with("ssh-rsa "));
    assert!(g.info.encrypted);
    assert!(is_owner_only(&fs::File::open(&g.path).unwrap()));
    assert_eq!(names(&dir), vec!["id_rsa", "id_rsa.pub"]);
}

fn write_key(dir: &Path, name: &str, comment: &str) -> String {
    let mut key = ed25519(7);
    key.set_comment(comment);
    let path = dir.join(name);
    fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
    path_str(&path)
}

#[test]
fn inspects_existing_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_key(dir.path(), "plain", "from-file");
    let (canonical, info) = inspect(&path, None).unwrap();
    assert_eq!(
        canonical,
        crate::fsutil::canonical(Path::new(&path)).unwrap()
    );
    assert_eq!(info.comment, "from-file");
    assert!(!info.encrypted);
    assert_eq!(
        inspect(&path, Some(&passphrase())).unwrap_err().code(),
        "invalid_input"
    );

    let code = |p: &str| inspect(p, None).unwrap_err().code();
    let garbage = dir.path().join("garbage");
    fs::write(&garbage, "not a key").unwrap();
    assert_eq!(code(&path_str(&garbage)), "invalid_input");
    let cert = dir.path().join("cert.pem");
    fs::write(
        &cert,
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
    )
    .unwrap();
    let err = inspect(&path_str(&cert), None).unwrap_err();
    assert!(err.to_string().contains("PKCS#8"), "{err}");
    let ppk = dir.path().join("key.ppk");
    fs::write(&ppk, "PuTTY-User-Key-File-3: ssh-ed25519\n").unwrap();
    assert!(
        inspect(&path_str(&ppk), None)
            .unwrap_err()
            .to_string()
            .contains("PuTTY")
    );
    let public = dir.path().join("plain.pub");
    fs::write(&public, ed25519(7).public_key().to_openssh().unwrap()).unwrap();
    assert_eq!(code(&path_str(&public)), "invalid_input");
    let big = dir.path().join("big");
    fs::write(&big, vec![b'a'; MAX_KEY_FILE_BYTES as usize + 1]).unwrap();
    assert_eq!(code(&path_str(&big)), "too_large");
    assert_eq!(code(&path_str(&dir.path().join("missing"))), "not_found");
    assert_eq!(code(&path_str(dir.path())), "invalid_input");
    assert_eq!(code("relative/key"), "invalid_input");
}

#[test]
fn removes_managed_files_only_inside_the_keys_dir() {
    let home = tempfile::tempdir().unwrap();
    let dir = keys_dir(home.path());
    let g = generate(&dir, "k", KeyType::Ed25519, "", None).unwrap();
    let outside = write_key(home.path(), "k", "");
    assert_eq!(
        remove_managed(&dir, &outside).unwrap_err().code(),
        "invalid_input"
    );
    assert!(Path::new(&outside).exists());
    remove_managed(&dir, &path_str(&g.path)).unwrap();
    assert!(names(&dir).is_empty());
    remove_managed(&dir, &path_str(&g.path)).unwrap();
}

#[test]
fn warns_about_missing_or_exposed_key_files() {
    let dir = tempfile::tempdir().unwrap();
    let missing = path_str(&dir.path().join("missing"));
    assert!(permission_warning(&missing).unwrap().contains("not found"));
    #[cfg(unix)]
    {
        let path = write_key(dir.path(), "k", "");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(permission_warning(&path).unwrap().contains("other users"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(permission_warning(&path), None);
    }
    let home = tempfile::tempdir().unwrap();
    let g = generate(&keys_dir(home.path()), "own", KeyType::Ed25519, "", None).unwrap();
    assert_eq!(permission_warning(&path_str(&g.path)), None);
}

const CONN: &str = "keys";

struct Deploy {
    server: TestServer,
    _ssh: Connected,
    remote: std::sync::Arc<Remote>,
}

async fn deploy_env() -> Deploy {
    let server = start_server(41).await;
    let ssh = manager_for(&server, CONN);
    ssh.connect().await.unwrap();
    let remote = SftpManager::default()
        .channel(&ssh.manager, CONN)
        .await
        .unwrap();
    Deploy {
        server,
        _ssh: ssh,
        remote,
    }
}

fn line(seed: u8, comment: &str) -> String {
    let mut key = ed25519(seed);
    key.set_comment(comment);
    key.public_key().to_openssh().unwrap()
}

fn ssh_dir() -> String {
    format!("{HOME}/.ssh")
}

fn authorized() -> String {
    format!("{HOME}/.ssh/authorized_keys")
}

#[tokio::test]
async fn deploy_creates_ssh_dir_and_file_owner_only() {
    let env = deploy_env().await;
    let fs = env.server.fs();
    assert!(fs.get(&ssh_dir()).is_none());
    let key = line(1, "new");
    assert_eq!(deploy(&env.remote, &key).await.unwrap(), Deployed::Added);
    assert_eq!(fs.mode(&ssh_dir()), Some(0o700));
    assert_eq!(fs.mode(&authorized()), Some(0o600));
    assert_eq!(
        fs.contents(&authorized()).unwrap(),
        format!("{key}\n").into_bytes()
    );
    assert_eq!(fs.paths_under(&ssh_dir()), vec![authorized()]);
    assert_eq!(
        deploy(&env.remote, &line(1, "other comment"))
            .await
            .unwrap(),
        Deployed::AlreadyPresent
    );
}

#[tokio::test]
async fn deploy_appends_after_a_missing_newline_and_skips_duplicates() {
    let env = deploy_env().await;
    let fs = env.server.fs();
    fs.dir(&ssh_dir());
    fs.set_mode(&ssh_dir(), 0o755);
    let old = format!("command=\"echo hi\" {}", line(2, "old"));
    fs.data(&authorized(), old.clone().into_bytes());
    fs.set_mode(&authorized(), 0o644);
    let key = line(3, "new");
    assert_eq!(deploy(&env.remote, &key).await.unwrap(), Deployed::Added);
    assert_eq!(
        String::from_utf8(fs.contents(&authorized()).unwrap()).unwrap(),
        format!("{old}\n{key}\n")
    );
    assert_eq!(fs.mode(&authorized()), Some(0o600));
    assert_eq!(
        fs.mode(&ssh_dir()),
        Some(0o755),
        "an existing ~/.ssh is never changed"
    );
    let before = fs.contents(&authorized());
    assert_eq!(
        deploy(&env.remote, &line(2, "")).await.unwrap(),
        Deployed::PresentWithOptions,
        "only present with options: reported, not changed"
    );
    assert_eq!(
        deploy(&env.remote, &key).await.unwrap(),
        Deployed::AlreadyPresent
    );
    assert_eq!(fs.contents(&authorized()), before);
    assert_eq!(fs.paths_under(&ssh_dir()), vec![authorized()]);
}

#[tokio::test]
async fn deploy_refuses_to_replace_without_posix_rename() {
    let server = start_server(42).await;
    server.fs().set_posix_rename(false);
    let ssh = manager_for(&server, CONN);
    ssh.connect().await.unwrap();
    let remote = SftpManager::default()
        .channel(&ssh.manager, CONN)
        .await
        .unwrap();
    let fs = server.fs();
    fs.dir(&ssh_dir());
    fs.data(&authorized(), b"ssh-ed25519 AAAA x\n".to_vec());
    let err = deploy(&remote, &line(4, "n")).await.unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("posix-rename"), "{err}");
    assert_eq!(
        fs.contents(&authorized()).unwrap(),
        b"ssh-ed25519 AAAA x\n".to_vec()
    );
    assert_eq!(fs.paths_under(&ssh_dir()), vec![authorized()]);

    fs.0.lock().unwrap().remove(&authorized());
    assert_eq!(
        deploy(&remote, &line(4, "n")).await.unwrap(),
        Deployed::Added,
        "creating a missing file needs no replace"
    );
}

#[tokio::test]
async fn deploy_refuses_links_and_oversized_files() {
    let env = deploy_env().await;
    let fs = env.server.fs();
    fs.dir(&ssh_dir());
    fs.data(&format!("{HOME}/elsewhere"), Vec::new());
    fs.link(&authorized(), &format!("{HOME}/elsewhere"));
    let err = deploy(&env.remote, &line(5, "")).await.unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("link"));
    assert_eq!(
        fs.contents(&format!("{HOME}/elsewhere")).unwrap(),
        Vec::<u8>::new()
    );

    fs.0.lock().unwrap().remove(&authorized());
    fs.file(&authorized(), 1024 * 1024 + 1);
    let err = deploy(&env.remote, &line(5, "")).await.unwrap_err();
    assert_eq!(err.code(), "too_large");
    assert!(!err.to_string().contains("AAAA"));

    fs.0.lock()
        .unwrap()
        .retain(|k, _| !k.starts_with(&ssh_dir()));
    fs.dir(&format!("{HOME}/real"));
    fs.link(&ssh_dir(), &format!("{HOME}/real"));
    assert_eq!(
        deploy(&env.remote, &line(5, "")).await.unwrap_err().code(),
        "invalid_input"
    );
    assert!(fs.paths_under(&format!("{HOME}/real")).is_empty());
    assert_eq!(
        deploy(&env.remote, "ssh-ed25519").await.unwrap_err().code(),
        "invalid_input"
    );
}

#[tokio::test]
async fn replace_file_leaves_a_taken_temp_alone() {
    let env = deploy_env().await;
    let fs = env.server.fs();
    let taken = format!("{HOME}/.f.carapace-part");
    fs.data(&taken, b"other".to_vec());
    replace_file(&env.remote, HOME, "f", b"data", false)
        .await
        .unwrap();
    assert_eq!(fs.contents(&format!("{HOME}/f")).unwrap(), b"data");
    assert_eq!(fs.contents(&taken).unwrap(), b"other");
    let err = replace_file(&env.remote, HOME, "f", b"x", false)
        .await
        .unwrap_err();
    assert_eq!(
        err,
        KeyError::Fs(FsError::AlreadyExists(format!("{HOME}/f")))
    );
    assert!(fs.get(&format!("{HOME}/.f.1.carapace-part")).is_none());
}

#[test]
fn imported_comments_never_carry_control_characters() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_key(dir.path(), "evil", "a\nssh-ed25519 AAAA injected");
    let (_, info) = inspect(&path, None).unwrap();
    assert_eq!(info.comment, "");
    assert!(!info.public_key.contains('\n'));
    assert_eq!(info.public_key.split_ascii_whitespace().count(), 2);

    let mut key = ed25519(8);
    key.set_comment("x\r\ny\t z");
    let info = file::info_of(key.public_key(), false).unwrap();
    assert_eq!(info.comment, "xy z");
    assert!(info.public_key.ends_with(" xy z"));
}

#[test]
fn deployable_line_comes_from_the_key_file() {
    let home = tempfile::tempdir().unwrap();
    let dir = keys_dir(home.path());
    let g = generate(&dir, "k", KeyType::Ed25519, "orig", Some(&passphrase())).unwrap();
    let path = path_str(&g.path);
    let line = deployable_line(&path, &g.info.public_key, "renamed\nevil").unwrap();
    let mut parts = g.info.public_key.split(' ');
    let (kind, blob) = (parts.next().unwrap(), parts.next().unwrap());
    assert_eq!(line, format!("{kind} {blob}"));
    assert_eq!(
        deployable_line(&path, &g.info.public_key, "c").unwrap(),
        format!("{kind} {blob} c")
    );
    let other = ed25519(9).public_key().to_openssh().unwrap();
    let err = deployable_line(&path, &other, "c").unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert_eq!(
        deployable_line(&path, "garbage", "c").unwrap_err().code(),
        "invalid_input"
    );
}
