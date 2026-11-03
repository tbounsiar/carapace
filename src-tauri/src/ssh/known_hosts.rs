use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use data_encoding::BASE64_MIME;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::parse_public_key_base64;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use sha1::Sha1;

use super::error::SshError;

#[derive(Debug, Clone, PartialEq)]
pub enum HostKeyStatus {
    Known,
    Unknown,
    Changed { known_fingerprints: Vec<String> },
    Revoked,
}

/// Lookups read the app file, then the user's file; writes only ever touch the app file.
#[derive(Debug)]
pub struct KnownHosts {
    app_file: PathBuf,
    user_file: Option<PathBuf>,
    write_lock: Mutex<()>,
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn host_pattern(host: &str, port: u16) -> String {
    let host = host.to_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

fn same_key(a: &PublicKey, b: &PublicKey) -> bool {
    a.key_data() == b.key_data()
}

impl KnownHosts {
    pub fn new(app_file: PathBuf, user_file: Option<PathBuf>) -> Self {
        Self {
            app_file,
            user_file,
            write_lock: Mutex::new(()),
        }
    }

    /// A file that cannot be read fails the check: treating it as empty would turn a changed
    /// key into an unknown one and offer the routine accept prompt.
    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> Result<HostKeyStatus, SshError> {
        let target = host_pattern(host, port);
        let app = read_lines(&self.app_file).map_err(|_| SshError::Io)?;
        let user = match self.user_file.as_deref() {
            Some(p) => read_lines(p).map_err(|e| SshError::UserKnownHostsUnreadable(e.kind()))?,
            None => Vec::new(),
        };
        if is_revoked(&app, &target, key) || is_revoked(&user, &target, key) {
            return Ok(HostKeyStatus::Revoked);
        }
        if let Some(status) = classify(&host_keys(&app, &target), key) {
            return Ok(status);
        }
        Ok(classify(&host_keys(&user, &target), key).unwrap_or(HostKeyStatus::Unknown))
    }

    /// Replaces any app-file entry for the same host and algorithm, then appends the new key.
    pub fn trust(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), SshError> {
        let _guard = self.write_lock.lock().map_err(|_| SshError::Io)?;
        let pattern = host_pattern(host, port);
        let algorithm = key.algorithm().to_string();
        let existing = match fs::read_to_string(&self.app_file) {
            Ok(s) => s,
            Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
            Err(_) => return Err(SshError::Io),
        };
        let mut out = String::new();
        for line in existing.lines() {
            if let Some(kept) = strip_entry(line, &pattern, &algorithm) {
                out.push_str(&kept);
                out.push('\n');
            }
        }
        let bare = PublicKey::new(key.key_data().clone(), "");
        let encoded = bare.to_openssh().map_err(|_| SshError::Io)?;
        out.push_str(&format!("{pattern} {encoded}\n"));
        write_atomic(&self.app_file, out.as_bytes()).map_err(|_| SshError::Io)
    }
}

fn classify(entries: &[PublicKey], key: &PublicKey) -> Option<HostKeyStatus> {
    if entries.iter().any(|k| same_key(k, key)) {
        return Some(HostKeyStatus::Known);
    }
    if entries.is_empty() {
        return None;
    }
    Some(HostKeyStatus::Changed {
        known_fingerprints: entries.iter().map(fingerprint).collect(),
    })
}

/// A missing file has no lines; any other read error is returned. Lines that are not UTF-8
/// are skipped, like OpenSSH skips lines it cannot parse.
fn read_lines(file: &Path) -> std::io::Result<Vec<String>> {
    let bytes = match fs::read(file) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(bytes
        .split(|b| *b == b'\n')
        .filter_map(|line| std::str::from_utf8(line).ok())
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect())
}

/// `(marker, hosts, key blob)` of an entry line; the key type field is not needed.
fn fields(line: &str) -> Option<(Option<&str>, &str, &str)> {
    let mut parts = line.split_whitespace();
    let first = parts.next()?;
    let (marker, hosts) = match first.strip_prefix('@') {
        Some(marker) => (Some(marker), parts.next()?),
        None => (None, first),
    };
    let _key_type = parts.next()?;
    Some((marker, hosts, parts.next()?))
}

/// Plain entries only: marker lines (`@cert-authority`, `@revoked`) never make a host known.
/// An entry whose key does not parse is skipped.
fn host_keys(lines: &[String], target: &str) -> Vec<PublicKey> {
    lines
        .iter()
        .filter_map(|line| match fields(line)? {
            (None, hosts, blob) if hosts.split(',').any(|h| host_equals(target, h)) => {
                parse_public_key_base64(blob).ok()
            }
            _ => None,
        })
        .collect()
}

fn is_revoked(lines: &[String], target: &str, key: &PublicKey) -> bool {
    lines.iter().any(|line| {
        matches!(fields(line), Some((Some("revoked"), hosts, blob))
            if hosts.split(',').any(|h| host_matches(target, h))
                && parse_public_key_base64(blob).is_ok_and(|k| same_key(&k, key)))
    })
}

fn hashed_matches(target: &str, hashed: &str) -> bool {
    let mut parts = hashed.split('|');
    let (Some(Ok(salt)), Some(Ok(hash))) = (
        parts.next().map(|p| BASE64_MIME.decode(p.as_bytes())),
        parts.next().map(|p| BASE64_MIME.decode(p.as_bytes())),
    ) else {
        return false;
    };
    Hmac::<Sha1>::new_from_slice(&salt)
        .is_ok_and(|m| m.chain_update(target).verify_slice(&hash).is_ok())
}

/// Lookup matching: exact (case-insensitive) or hashed, no wildcards.
fn host_equals(target: &str, entry: &str) -> bool {
    match entry.strip_prefix("|1|") {
        Some(hashed) => hashed_matches(target, hashed),
        None => entry.eq_ignore_ascii_case(target),
    }
}

/// Revocation matching, broader on purpose: wildcards too; `!` entries are ignored.
fn host_matches(target: &str, entry: &str) -> bool {
    if let Some(hashed) = entry.strip_prefix("|1|") {
        return hashed_matches(target, hashed);
    }
    !entry.starts_with('!') && glob(entry.to_lowercase().as_bytes(), target.as_bytes())
}

fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some((b'*', rest)) => (0..=text.len()).any(|i| glob(rest, &text[i..])),
        Some((b'?', rest)) => !text.is_empty() && glob(rest, &text[1..]),
        Some((c, rest)) => text.first() == Some(c) && glob(rest, &text[1..]),
    }
}

/// Returns the line to keep (possibly without the removed host), or `None` to drop it.
fn strip_entry(line: &str, pattern: &str, algorithm: &str) -> Option<String> {
    let mut parts = line.splitn(3, ' ');
    let (Some(hosts), Some(alg), Some(_)) = (parts.next(), parts.next(), parts.next()) else {
        return Some(line.to_string());
    };
    if line.starts_with('#') || alg != algorithm || !hosts.split(',').any(|h| h == pattern) {
        return Some(line.to_string());
    }
    let remaining: Vec<&str> = hosts.split(',').filter(|h| *h != pattern).collect();
    if remaining.is_empty() {
        None
    } else {
        let rest = &line[hosts.len()..];
        Some(format!("{}{rest}", remaining.join(",")))
    }
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let tmp = path.with_extension("tmp");
    let result = (|| {
        let mut f = create_private(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn create_private(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_encoding::BASE64;
    use russh::keys::parse_public_key_base64;

    const ED_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIPcHUh481dpU/BTeNATBHP6iUCYXXvDiwMhNu72TSlEw";
    const ED_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const ED_HASHED: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";
    const ECDSA: &str = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLeYS+Ryd4Z3jPtCNeaXDUARjsimqnI5GVoCBe9wpl/dF1kv3q8Z+Y1MSC2514EHk7avv1jU3CrBxVwiHD9OYTc=";

    fn key(b64: &str) -> PublicKey {
        parse_public_key_base64(b64).unwrap()
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        app: PathBuf,
        user: PathBuf,
        hosts: KnownHosts,
    }

    fn fixture(app_content: &str, user_content: &str) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app").join("known_hosts");
        let user = dir.path().join("user_known_hosts");
        if !app_content.is_empty() {
            fs::create_dir_all(app.parent().unwrap()).unwrap();
            fs::write(&app, app_content).unwrap();
        }
        fs::write(&user, user_content).unwrap();
        let hosts = KnownHosts::new(app.clone(), Some(user.clone()));
        Fixture {
            _dir: dir,
            app,
            user,
            hosts,
        }
    }

    #[test]
    fn unknown_when_no_entry() {
        let f = fixture("", "");
        assert_eq!(
            f.hosts.check("h.example", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn plain_and_port_forms() {
        let f = fixture(
            &format!("h.example ssh-ed25519 {ED_A}\n[h.example]:2222 ssh-ed25519 {ED_B}\n"),
            "",
        );
        let check = |port, k: &str| f.hosts.check("H.Example", port, &key(k)).unwrap();
        assert_eq!(check(22, ED_A), HostKeyStatus::Known);
        assert_eq!(check(2222, ED_B), HostKeyStatus::Known);
        assert!(matches!(check(2222, ED_A), HostKeyStatus::Changed { .. }));
        assert_eq!(check(2200, ED_A), HostKeyStatus::Unknown);
    }

    #[test]
    fn hashed_entries_are_matched() {
        let f = fixture(
            "",
            &format!(
                "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 {ED_HASHED}\n"
            ),
        );
        assert_eq!(
            f.hosts.check("example.com", 22, &key(ED_HASHED)).unwrap(),
            HostKeyStatus::Known
        );
        assert_eq!(
            f.hosts.check("other.com", 22, &key(ED_HASHED)).unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn changed_lists_every_known_fingerprint() {
        let f = fixture(
            &format!("h ssh-ed25519 {ED_A}\nh ecdsa-sha2-nistp256 {ECDSA}\n"),
            "",
        );
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_B)).unwrap(),
            HostKeyStatus::Changed {
                known_fingerprints: vec![fingerprint(&key(ED_A)), fingerprint(&key(ECDSA))]
            }
        );
        assert_eq!(
            f.hosts.check("h", 22, &key(ECDSA)).unwrap(),
            HostKeyStatus::Known
        );
    }

    #[test]
    fn other_algorithm_only_is_changed() {
        let f = fixture(&format!("h ecdsa-sha2-nistp256 {ECDSA}\n"), "");
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Changed {
                known_fingerprints: vec![fingerprint(&key(ECDSA))]
            }
        );
    }

    fn hashed_entry(pattern: &str) -> String {
        let salt = b"0123456789abcdefghij";
        let mac = Hmac::<Sha1>::new_from_slice(salt)
            .unwrap()
            .chain_update(pattern)
            .finalize()
            .into_bytes();
        format!("|1|{}|{}", BASE64.encode(salt), BASE64.encode(&mac))
    }

    #[test]
    fn hashed_entries_on_custom_port_are_matched() {
        let f = fixture(
            "",
            &format!(
                "{} ssh-ed25519 {ED_A}\n",
                hashed_entry("[example.com]:2222")
            ),
        );
        let check = |h, port, k| f.hosts.check(h, port, &key(k)).unwrap();
        assert_eq!(check("Example.com", 2222, ED_A), HostKeyStatus::Known);
        assert_eq!(check("example.com", 22, ED_A), HostKeyStatus::Unknown);
        assert_eq!(check("example.com", 2223, ED_A), HostKeyStatus::Unknown);
        assert!(matches!(
            check("example.com", 2222, ED_B),
            HostKeyStatus::Changed { .. }
        ));
    }

    #[test]
    fn revoked_in_user_file() {
        let f = fixture(
            "",
            &format!("h ssh-ed25519 {ED_A}\n@revoked h ssh-ed25519 {ED_B}\n"),
        );
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_B)).unwrap(),
            HostKeyStatus::Revoked
        );
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Known
        );
    }

    #[test]
    fn revoked_in_app_file_beats_a_user_file_match() {
        let f = fixture(
            &format!("@revoked h,other ssh-ed25519 {ED_A}\n"),
            &format!("h ssh-ed25519 {ED_A}\n"),
        );
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Revoked
        );
        assert_eq!(
            f.hosts.check("other", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Revoked
        );
    }

    #[test]
    fn revoked_with_port_hashed_and_wildcard_patterns() {
        let f = fixture(
            &format!(
                "@revoked [h]:2222 ssh-ed25519 {ED_A}\n@revoked {} ssh-ed25519 {ED_B}\n@revoked *.example.com ssh-ed25519 {ED_HASHED}\n",
                hashed_entry("[x.test]:2200")
            ),
            "",
        );
        let check = |h, port, k| f.hosts.check(h, port, &key(k)).unwrap();
        assert_eq!(check("h", 2222, ED_A), HostKeyStatus::Revoked);
        assert_eq!(check("h", 22, ED_A), HostKeyStatus::Unknown);
        assert_eq!(check("x.test", 2200, ED_B), HostKeyStatus::Revoked);
        assert_eq!(check("x.test", 22, ED_B), HostKeyStatus::Unknown);
        assert_eq!(
            check("a.example.com", 22, ED_HASHED),
            HostKeyStatus::Revoked
        );
    }

    #[test]
    fn cert_authority_lines_do_not_make_a_host_known() {
        let f = fixture(
            &format!("@cert-authority h ssh-ed25519 {ED_A}\n"),
            &format!("@cert-authority h ssh-ed25519 {ED_A}\n"),
        );
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[cfg(unix)]
    #[test]
    fn temp_file_is_created_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let f = create_private(&dir.path().join("t")).unwrap();
        assert_eq!(f.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn user_file_is_used_and_never_written() {
        let content = format!("h ssh-ed25519 {ED_A}\n");
        let f = fixture("", &content);
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Known
        );
        assert!(matches!(
            f.hosts.check("h", 22, &key(ED_B)).unwrap(),
            HostKeyStatus::Changed { .. }
        ));
        f.hosts.trust("h", 22, &key(ED_B)).unwrap();
        assert_eq!(fs::read_to_string(&f.user).unwrap(), content);
        assert!(f.app.exists());
    }

    #[test]
    fn app_file_wins_over_user_file() {
        let f = fixture("", &format!("h ssh-ed25519 {ED_A}\n"));
        f.hosts.trust("h", 22, &key(ED_B)).unwrap();
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_B)).unwrap(),
            HostKeyStatus::Known
        );
        assert!(matches!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Changed { .. }
        ));
    }

    #[test]
    fn trust_replaces_same_algorithm_and_keeps_the_rest() {
        let f = fixture(
            &format!("# note\nh,other ssh-ed25519 {ED_A}\nh ecdsa-sha2-nistp256 {ECDSA}\n"),
            "",
        );
        f.hosts.trust("h", 22, &key(ED_B)).unwrap();
        let content = fs::read_to_string(&f.app).unwrap();
        assert!(content.contains("# note\n"));
        assert!(content.contains(&format!("other ssh-ed25519 {ED_A}\n")));
        assert!(content.contains(&format!("h ecdsa-sha2-nistp256 {ECDSA}\n")));
        assert!(content.contains(&format!("h ssh-ed25519 {ED_B}\n")));
        assert_eq!(content.matches("ssh-ed25519").count(), 2);
        assert!(!f.app.with_extension("tmp").exists());
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_B)).unwrap(),
            HostKeyStatus::Known
        );
        assert_eq!(
            f.hosts.check("other", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Known
        );
    }

    #[test]
    fn trust_writes_bracketed_pattern_for_custom_port() {
        let f = fixture("", "");
        f.hosts.trust("Host", 2222, &key(ED_A)).unwrap();
        assert_eq!(
            fs::read_to_string(&f.app).unwrap(),
            format!("[host]:2222 ssh-ed25519 {ED_A}\n")
        );
    }

    #[test]
    fn unreadable_user_file_fails_the_check() {
        let f = fixture("", "");
        fs::remove_file(&f.user).unwrap();
        fs::create_dir(&f.user).unwrap();
        let err = f.hosts.check("h", 22, &key(ED_A)).unwrap_err();
        assert!(matches!(err, SshError::UserKnownHostsUnreadable(_)));
        assert_eq!(err.code(), "io");
        assert!(err.to_string().contains("~/.ssh/known_hosts"));
    }

    #[test]
    fn unreadable_app_file_fails_the_check() {
        let f = fixture("", "");
        fs::create_dir_all(&f.app).unwrap();
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap_err(),
            SshError::Io
        );
    }

    #[test]
    fn missing_user_file_has_no_entries() {
        let f = fixture("", "");
        fs::remove_file(&f.user).unwrap();
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn bad_lines_are_skipped_and_the_rest_still_counts() {
        let f = fixture("", "");
        let mut content = b"bad \xff\xfe line\n".to_vec();
        content.extend_from_slice(b"h ssh-ed25519 not-base64\n");
        content.extend_from_slice(format!("h\tssh-ed25519   {ED_B}\r\n").as_bytes());
        fs::write(&f.user, content).unwrap();
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_A)).unwrap(),
            HostKeyStatus::Changed {
                known_fingerprints: vec![fingerprint(&key(ED_B))]
            }
        );
        assert_eq!(
            f.hosts.check("h", 22, &key(ED_B)).unwrap(),
            HostKeyStatus::Known
        );
    }

    #[test]
    fn fingerprint_is_openssh_sha256() {
        let fp = fingerprint(&key(ED_A));
        assert!(fp.starts_with("SHA256:"));
        let b64 = &fp["SHA256:".len()..];
        assert_eq!(b64.len(), 43);
        assert!(!b64.contains('='));
    }
}
