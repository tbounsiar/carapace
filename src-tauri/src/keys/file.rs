use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use getrandom::SysRng;
use getrandom::rand_core::UnwrapErr;
use russh::keys::ssh_key::private::{KeypairData, RsaKeypair};
use russh::keys::ssh_key::public::KeyData;
use russh::keys::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey, PublicKey};
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use zeroize::Zeroizing;

use super::error::KeyError;
use super::location::{self, KeyDir};
use crate::config::KeyAlgorithm;
use crate::text::{Localized, Text};
use crate::{config, fsutil, localfs};

pub const MAX_KEY_FILE_BYTES: u64 = 64 * 1024;
const MAX_PUB_FILE_BYTES: u64 = 16 * 1024;
const MAX_PASSPHRASE_CHARS: usize = 1024;
const MAX_COMMENT_CHARS: usize = 255;
const MAX_FILE_NAME_CHARS: usize = 64;
const RSA_BITS: usize = 4096;
const RESERVED_NAMES: &[&str] = &[
    "authorized_keys",
    "authorized_keys2",
    "config",
    "known_hosts",
    "known_hosts2",
    "environment",
    "rc",
];
const MIN_RSA_BITS: u32 = 2048;

/// What the user can generate: Ed25519, or RSA 4096 as the only alternative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyType {
    Ed25519,
    Rsa4096,
}

/// Public facts about a key, as stored in the config.
#[derive(Debug, Clone, PartialEq)]
pub struct KeyInfo {
    pub algorithm: KeyAlgorithm,
    pub bits: Option<u32>,
    /// OpenSSH public key line (`type base64 comment`).
    pub public_key: String,
    pub fingerprint: String,
    pub comment: String,
    pub encrypted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedKey {
    /// Canonical path of the private key file.
    pub path: PathBuf,
    pub info: KeyInfo,
    /// Written into the managed keys directory.
    pub managed: bool,
}

pub fn keys_dir(home: &Path) -> PathBuf {
    home.join("keys")
}

/// The name of a new private key file.
pub fn validate_file_name(raw: &str) -> Result<&str, KeyError> {
    let raw = name_syntax(raw)?;
    let lower = raw.to_ascii_lowercase();
    if lower.ends_with(".pub") {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.nameEndsInPub",
            "A private key file name cannot end in .pub."
        )));
    }
    // Files OpenSSH reads from ~/.ssh: a key written there under one of these names would be
    // taken for configuration.
    if RESERVED_NAMES.contains(&lower.as_str()) {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.reservedName",
            "This name is reserved. Choose another file name."
        )));
    }
    Ok(raw)
}

/// Charset and platform rules only; also what an existing generated key's name passes, so a
/// pair generated before the reserved names were refused can still be deleted.
fn name_syntax(raw: &str) -> Result<&str, KeyError> {
    let charset = raw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if raw.is_empty() || raw.len() > MAX_FILE_NAME_CHARS || !charset || raw.starts_with('.') {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.fileNameRules",
            "file name must be 1 to 64 letters, digits, '_', '.' or '-' and not start with '.'"
        )));
    }
    localfs::name(raw).map_err(|e| KeyError::invalid(e.text()))
}

pub fn validate_comment(raw: &str) -> Result<String, KeyError> {
    let comment = raw.trim();
    if comment.chars().count() > MAX_COMMENT_CHARS || comment.chars().any(char::is_control) {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.commentRules",
            "comment must be at most 255 characters without control characters"
        )));
    }
    Ok(comment.to_owned())
}

/// The message never includes the value.
pub fn validate_passphrase(value: &SecretString) -> Result<(), KeyError> {
    let len = value.expose_secret().chars().count();
    if !(1..=MAX_PASSPHRASE_CHARS).contains(&len) {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.passphraseLength",
            "passphrase must be 1 to 1024 characters"
        )));
    }
    Ok(())
}

fn generation_failed() -> KeyError {
    KeyError::GenerationFailed
}

/// Control characters (a newline would add an authorized_keys line when the public key is
/// pasted) are dropped, and the comment is cut to the length `validate_comment` allows.
fn clean_comment(raw: &str) -> String {
    let kept: String = raw.chars().filter(|c| !c.is_control()).collect();
    kept.trim().chars().take(MAX_COMMENT_CHARS).collect()
}

/// Every public key line the app stores or deploys comes from here, with a clean comment.
pub(super) fn info_of(public: &PublicKey, encrypted: bool) -> Result<KeyInfo, KeyError> {
    let mut public = public.clone();
    let comment = clean_comment(public.comment().as_ref());
    public.set_comment(comment);
    let public = &public;
    let (algorithm, bits) = match public.key_data() {
        KeyData::Ed25519(_) => (KeyAlgorithm::Ed25519, None),
        KeyData::Rsa(rsa) => {
            let bits = rsa.key_size();
            if bits < MIN_RSA_BITS {
                return Err(KeyError::invalid(crate::text!(
                    "errors.keys.rsaTooShort",
                    "RSA keys shorter than 2048 bits are not supported"
                )));
            }
            (KeyAlgorithm::Rsa, Some(bits))
        }
        _ => {
            return Err(KeyError::invalid(crate::text!(
                "errors.keys.unsupportedType",
                "only Ed25519 and RSA keys are supported"
            )));
        }
    };
    let public_key = public.to_openssh().map_err(|_| {
        KeyError::invalid(crate::text!(
            "errors.keys.publicKeyEncoding",
            "the public key could not be encoded"
        ))
    })?;
    Ok(KeyInfo {
        algorithm,
        bits,
        public_key,
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        comment: public.comment().to_string(),
        encrypted,
    })
}

/// Generates a key pair into `dir`: `{file_name}` owner-only and `{file_name}.pub`, both
/// written atomically without replacing anything. The managed directory is created owner-only
/// if missing; a custom folder must already exist (see `key_dir`). Blocking (RSA takes
/// seconds); run it on the blocking pool.
pub fn generate(
    dir: &KeyDir,
    file_name: &str,
    kind: KeyType,
    comment: &str,
    passphrase: Option<&SecretString>,
) -> Result<GeneratedKey, KeyError> {
    let file_name = validate_file_name(file_name)?;
    let comment = validate_comment(comment)?;
    if let Some(p) = passphrase {
        validate_passphrase(p)?;
    }
    let path = &dir.path;
    if dir.managed {
        if let Some(home) = path.parent() {
            fs::create_dir_all(home).map_err(|e| KeyError::io(e, home))?;
        }
        fsutil::ensure_dir_owner_only(path).map_err(|e| KeyError::io(e, path))?;
    }
    let held = location::hold(dir)?;
    location::ensure_free(path, file_name)?;
    let pub_name = format!("{file_name}.pub");

    let mut rng = UnwrapErr(SysRng);
    let mut key = match kind {
        KeyType::Ed25519 => PrivateKey::random(&mut rng, Algorithm::Ed25519),
        KeyType::Rsa4096 => RsaKeypair::random(&mut rng, RSA_BITS)
            .and_then(|pair| PrivateKey::new(KeypairData::from(pair), "")),
    }
    .map_err(|_| generation_failed())?;
    key.set_comment(comment);
    let info = info_of(key.public_key(), passphrase.is_some())?;
    if let Some(p) = passphrase {
        key = key
            .encrypt(&mut rng, p.expose_secret().as_bytes())
            .map_err(|_| generation_failed())?;
    }
    let pem: Zeroizing<String> = key
        .to_openssh(LineEnding::LF)
        .map_err(|_| generation_failed())?;
    drop(key);

    location::recheck(dir, held.as_ref())?;
    let private = fsutil::write_new(path, file_name, pem.as_bytes(), true)
        .map_err(|e| location::write_error(e, dir, file_name))?;
    let public_line = format!("{}\n", info.public_key);
    if let Err(e) = fsutil::write_new(path, &pub_name, public_line.as_bytes(), false) {
        let _ = fs::remove_file(&private);
        return Err(location::write_error(e, dir, file_name));
    }
    let canonical = fsutil::canonical(&private).map_err(|e| KeyError::io(e, &private))?;
    drop(held);
    Ok(GeneratedKey {
        path: canonical,
        info,
        managed: dir.managed,
    })
}

fn not_openssh(text: &str) -> KeyError {
    let pem = text.contains("-----BEGIN");
    KeyError::invalid(if text.starts_with("PuTTY-User-Key-File") {
        crate::text!(
            "errors.keys.puttyKey",
            "PuTTY keys are not supported; export the key in OpenSSH format with PuTTYgen"
        )
    } else if pem && text.contains("OPENSSH") {
        crate::text!(
            "errors.keys.unparsable",
            "the private key file could not be parsed"
        )
    } else if pem {
        crate::text!(
            "errors.keys.pemKey",
            "PEM and PKCS#8 keys are not supported; convert the key with ssh-keygen -p -f <file>"
        )
    } else {
        not_a_private_key()
    })
}

fn not_a_private_key() -> Text {
    crate::text!(
        "errors.keys.notPrivateKey",
        "the file is not an OpenSSH private key"
    )
}

/// Reads a key file through one bounded handle, never following a link at the last component
/// (stored paths are canonical, so a link there was swapped in).
fn read_key_file(path: &Path, max: u64) -> Result<Zeroizing<Vec<u8>>, KeyError> {
    fsutil::read_regular_capped(path, max, false).map_err(|e| match e.kind() {
        ErrorKind::InvalidInput => KeyError::invalid(crate::text!(
            "errors.keys.notRegularFile",
            "{path} is not a regular file",
            path = path.display().to_string()
        )),
        ErrorKind::FileTooLarge => KeyError::TooLarge(path.display().to_string()),
        _ => KeyError::io(e, path),
    })
}

fn parse_private(raw: &[u8]) -> Result<PrivateKey, KeyError> {
    let text = std::str::from_utf8(raw).map_err(|_| KeyError::invalid(not_a_private_key()))?;
    PrivateKey::from_openssh(text).map_err(|_| not_openssh(text))
}

/// The comment of the `.pub` file next to `path`, if it holds the same key.
fn sibling_comment(path: &Path, public: &PublicKey) -> Option<String> {
    let raw = read_key_file(&pub_path(path), MAX_PUB_FILE_BYTES).ok()?;
    let found = PublicKey::from_openssh(std::str::from_utf8(&raw).ok()?.trim()).ok()?;
    (found.key_data() == public.key_data()).then(|| found.comment().to_string())
}

/// Reads and parses an existing OpenSSH private key at `raw_path` (absolute or `~/`). The
/// public key and the encrypted flag come from the file header; an encrypted key's comment is
/// only readable with the passphrase, else it is taken from a matching `.pub` sibling. A
/// passphrase, when given, is checked by decrypting. Returns the canonical path. Blocking.
pub fn inspect(
    raw_path: &str,
    passphrase: Option<&SecretString>,
) -> Result<(PathBuf, KeyInfo), KeyError> {
    config::validate::key_path(raw_path).map_err(KeyError::invalid)?;
    if let Some(p) = passphrase {
        validate_passphrase(p)?;
    }
    let expanded = fsutil::expand_local(raw_path).ok_or_else(|| {
        KeyError::invalid(crate::text!(
            "errors.keys.pathNotLocal",
            "key path must be absolute or start with ~/"
        ))
    })?;
    let path = fsutil::canonical(&expanded).map_err(|e| KeyError::io(e, &expanded))?;
    if !fsutil::is_local_path(&path) {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.pathNotOnLocalDrive",
            "key path must be on a local drive"
        )));
    }
    let key = parse_private(&read_key_file(&path, MAX_KEY_FILE_BYTES)?)?;
    let encrypted = key.is_encrypted();
    let mut public = key.public_key().clone();
    let comment = match (encrypted, passphrase) {
        (false, Some(_)) => {
            return Err(KeyError::invalid(crate::text!(
                "errors.keys.notEncrypted",
                "this key is not protected by a passphrase"
            )));
        }
        (false, None) => key.comment().to_string(),
        (true, Some(p)) => key
            .decrypt(p.expose_secret().as_bytes())
            .map_err(|_| KeyError::InvalidPassphrase)?
            .comment()
            .to_string(),
        (true, None) => sibling_comment(&path, &public).unwrap_or_default(),
    };
    // A comment that would not pass for a generated key is dropped rather than cleaned up.
    let comment = validate_comment(&comment).unwrap_or_default();
    public.set_comment(comment.as_str());
    let info = info_of(&public, encrypted)?;
    Ok((path, info))
}

/// The public key line to deploy for a registered key, rebuilt from the private key file's
/// header (readable without the passphrase). Refused if the file no longer holds the key the
/// config lists, so a swapped file is never deployed under the registered key's name.
pub fn deployable_line(path: &str, registered: &str, comment: &str) -> Result<String, KeyError> {
    let key = parse_private(&read_key_file(Path::new(path), MAX_KEY_FILE_BYTES)?)?;
    let listed = PublicKey::from_openssh(registered).map_err(|_| {
        KeyError::invalid(crate::text!(
            "errors.keys.registeredKeyInvalid",
            "the registered public key is invalid"
        ))
    })?;
    if listed.key_data() != key.public_key().key_data() {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.fileChanged",
            "the key file no longer holds the registered key; remove the key and import it again"
        )));
    }
    let mut public = key.public_key().clone();
    public.set_comment(validate_comment(comment).unwrap_or_default());
    Ok(info_of(&public, key.is_encrypted())?.public_key)
}

/// A user-facing warning about the private key file, if any.
pub fn permission_warning(path: &str) -> Option<Text> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Some(crate::text!(
                "errors.keys.fileMissing",
                "the private key file was not found"
            ));
        }
        Err(_) => return None,
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Some(crate::text!(
                "errors.keys.fileOpenToOthers",
                "the private key file is accessible to other users; restrict it with chmod 600"
            ));
        }
    }
    #[cfg(windows)]
    {
        let _ = meta;
        let exposed = fs::File::open(path)
            .and_then(|f| fsutil::readable_by_others(&f))
            .unwrap_or(false);
        if exposed {
            return Some(crate::text!(
                "errors.keys.fileReadableByOthers",
                "the private key file is readable by other users; restrict its permissions to your account"
            ));
        }
    }
    None
}

fn pub_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".pub");
    PathBuf::from(p)
}

fn delete_error(e: std::io::Error, path: &Path) -> KeyError {
    match e.kind() {
        ErrorKind::InvalidInput | ErrorKind::FileTooLarge => KeyError::NotThisKey,
        _ => KeyError::io(e, path),
    }
}

/// Reads one file of the pair for a deletion check: `None` when it is missing; a link, a
/// non-regular or oversized file is not this key.
fn read_for_delete(path: &Path, max: u64) -> Result<Option<Zeroizing<Vec<u8>>>, KeyError> {
    match fsutil::read_regular_capped(path, max, false) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(delete_error(e, path)),
    }
}

fn fingerprint_of(public: &PublicKey) -> String {
    public.fingerprint(HashAlg::Sha256).to_string()
}

fn private_holds(raw: &[u8], fingerprint: &str) -> Result<(), KeyError> {
    let key = parse_private(raw).map_err(|_| KeyError::NotThisKey)?;
    if fingerprint_of(key.public_key()) != fingerprint {
        return Err(KeyError::NotThisKey);
    }
    Ok(())
}

fn public_holds(raw: &[u8], fingerprint: &str) -> Result<(), KeyError> {
    let found = std::str::from_utf8(raw)
        .ok()
        .and_then(|t| PublicKey::from_openssh(t.trim()).ok())
        .ok_or(KeyError::NotThisKey)?;
    if fingerprint_of(&found) != fingerprint {
        return Err(KeyError::NotThisKey);
    }
    Ok(())
}

/// Checks that the files of a generated key pair may be deleted: the private key at `path`
/// (no link followed) holds the key with `fingerprint`, and so does its `.pub` sibling.
/// Missing files are fine. With `managed`, the path must also be directly in that directory,
/// so a tampered config cannot point the deletion elsewhere.
pub fn check_pair(path: &str, fingerprint: &str, managed: Option<&Path>) -> Result<(), KeyError> {
    let path = Path::new(path);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|_| fsutil::is_local_path(path))
        .ok_or_else(|| {
            KeyError::invalid(crate::text!(
                "errors.keys.filesNotLocated",
                "the key files cannot be located"
            ))
        })?;
    name_syntax(name)?;
    if let Some(dir) = managed {
        let inside = match (path.parent().map(fsutil::canonical), fsutil::canonical(dir)) {
            (Some(Ok(parent)), Ok(dir)) => parent == dir,
            _ => false,
        };
        if !inside {
            return Err(KeyError::invalid(crate::text!(
                "errors.keys.outsideKeysDir",
                "the key is not in the keys directory"
            )));
        }
    }
    if let Some(raw) = read_for_delete(path, MAX_KEY_FILE_BYTES)? {
        private_holds(&raw, fingerprint)?;
    }
    if let Some(raw) = read_for_delete(&pub_path(path), MAX_PUB_FILE_BYTES)? {
        public_holds(&raw, fingerprint)?;
    }
    Ok(())
}

/// Deletes a generated key's two files once `check_pair` passed. Each file is opened once,
/// checked again from that handle and deleted through it, so a link or junction swapped into
/// the path after the check cannot make it delete another file. Missing files are fine.
pub fn remove_pair(path: &str, fingerprint: &str, managed: Option<&Path>) -> Result<(), KeyError> {
    check_pair(path, fingerprint, managed)?;
    let path = Path::new(path);
    let public = pub_path(path);
    let open = |p: &Path, max: u64| fsutil::open_for_delete(p, max).map_err(|e| delete_error(e, p));
    let private = open(path, MAX_KEY_FILE_BYTES)?;
    if let Some((_, raw)) = &private {
        private_holds(raw, fingerprint)?;
    }
    let public_file = open(&public, MAX_PUB_FILE_BYTES)?;
    if let Some((_, raw)) = &public_file {
        public_holds(raw, fingerprint)?;
    }
    for (doomed, p) in [(private, path), (public_file, public.as_path())] {
        if let Some((doomed, _)) = doomed {
            doomed.delete().map_err(|e| delete_error(e, p))?;
        }
    }
    Ok(())
}
