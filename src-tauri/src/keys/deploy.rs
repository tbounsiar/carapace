//! Appends a public key to the remote `~/.ssh/authorized_keys` over the connection's SFTP
//! channel. The file's content never reaches logs or errors.

use crate::files::{EntryKind, FsError};
use crate::sftp::{Remote, join};

use super::error::KeyError;

const MAX_AUTHORIZED_KEYS: usize = 1024 * 1024;
const CHUNK: u32 = 32 * 1024;
const MAX_TEMPS: u32 = 16;

/// Splits an OpenSSH public key line into its type and base64 blob.
fn key_parts(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.split_ascii_whitespace();
    Some((parts.next()?, parts.next()?))
}

/// The first `n` whitespace-separated fields of an authorized_keys line; whitespace inside
/// double quotes (options such as `command="a b"`) does not separate.
fn fields(line: &str, n: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let (mut quoted, mut escaped) = (false, false);
    for c in line.chars() {
        if escaped {
            current.push(c);
            escaped = false;
        } else if quoted && c == '\\' {
            current.push(c);
            escaped = true;
        } else if c == '"' {
            current.push(c);
            quoted = !quoted;
        } else if c.is_whitespace() && !quoted {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
                if out.len() == n {
                    return out;
                }
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Presence {
    Absent,
    /// A line holds the key without options.
    Plain,
    /// Only lines with options (`restrict`, `command=`, `cert-authority`...) hold the key.
    WithOptions,
}

/// How the key (same type and blob, comment ignored) appears in an authorized_keys content.
pub(super) fn presence(content: &str, kind: &str, blob: &str) -> Presence {
    let mut found = Presence::Absent;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f = fields(line, 3);
        let at = |i: usize| f.get(i).map(String::as_str);
        if at(0) == Some(kind) && at(1) == Some(blob) {
            return Presence::Plain;
        }
        if at(1) == Some(kind) && at(2) == Some(blob) {
            found = Presence::WithOptions;
        }
    }
    found
}

/// What a deploy did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deployed {
    Added,
    AlreadyPresent,
    /// The key is only present with options; nothing was changed, the user decides by hand.
    PresentWithOptions,
}

pub(super) async fn read_capped(remote: &Remote, path: &str) -> Result<Vec<u8>, KeyError> {
    let handle = remote.open_read(path).await?;
    let mut data = Vec::new();
    let result = async {
        loop {
            match remote
                .read_at(&handle, data.len() as u64, CHUNK, path)
                .await?
            {
                None => return Ok(()),
                Some(chunk) if chunk.is_empty() => return Ok(()),
                Some(chunk) => {
                    data.extend_from_slice(&chunk);
                    if data.len() > MAX_AUTHORIZED_KEYS {
                        return Err(KeyError::TooLarge(path.into()));
                    }
                }
            }
        }
    }
    .await;
    let _ = remote.close_handle(&handle, path).await;
    result.map(|()| data)
}

fn temp_name(name: &str, n: u32) -> String {
    if n == 0 {
        format!(".{name}.carapace-part")
    } else {
        format!(".{name}.{n}.carapace-part")
    }
}

async fn write_all(remote: &Remote, handle: &str, data: &[u8], path: &str) -> Result<(), FsError> {
    for (i, chunk) in data.chunks(CHUNK as usize).enumerate() {
        let offset = (i * CHUNK as usize) as u64;
        remote
            .write_at(handle, offset, chunk.to_vec(), path)
            .await?;
    }
    remote.set_handle_mode(handle, 0o600, path).await
}

/// Writes `data` to `dir/name` through an owner-only temp sibling created exclusively, then
/// renames it into place (`replace`: over the existing file, atomically with posix-rename;
/// else never replacing). The temp is removed on failure.
pub async fn replace_file(
    remote: &Remote,
    dir: &str,
    name: &str,
    data: &[u8],
    replace: bool,
) -> Result<(), KeyError> {
    let target = join(dir, name);
    // The fallback (move the original aside, then rename) leaves a moment without the file; for
    // authorized_keys that can lock the user out, so only an atomic replace is done.
    if replace && !remote.has_posix_rename() {
        return Err(KeyError::invalid(crate::text!(
            "errors.keys.noAtomicReplace",
            "the server cannot replace {name} atomically (no posix-rename@openssh.com); add the key by hand",
            name = name
        )));
    }
    let mut created = None;
    for n in 0..MAX_TEMPS {
        let temp = join(dir, &temp_name(name, n));
        match remote.create_new(&temp).await {
            Ok(handle) => {
                created = Some((temp, handle));
                break;
            }
            Err(FsError::AlreadyExists(_)) => {}
            Err(e) => return Err(e.into()),
        }
    }
    let (temp, handle) = created.ok_or_else(|| KeyError::AlreadyExists(target.clone()))?;
    let written = write_all(remote, &handle, data, &temp).await;
    let closed = remote.close_handle(&handle, &temp).await;
    let placed = match written.and(closed) {
        Ok(()) if replace => remote.rename_replace(&temp, &target).await,
        Ok(()) => remote.rename_new(&temp, &target).await,
        Err(e) => Err(e),
    };
    if let Err(e) = placed {
        let _ = remote.remove_entry(&temp).await;
        return Err(e.into());
    }
    Ok(())
}

fn ssh_dir_not_dir() -> KeyError {
    KeyError::invalid(crate::text!(
        "errors.keys.sshDirNotDir",
        "~/.ssh is not a directory"
    ))
}

/// Adds `public_key` (an OpenSSH line) to `~/.ssh/authorized_keys`, unless a line already
/// holds the same key; nothing is written then.
pub async fn deploy(remote: &Remote, public_key: &str) -> Result<Deployed, KeyError> {
    let (kind, blob) = key_parts(public_key)
        .filter(|_| !public_key.contains(['\n', '\r']))
        .ok_or_else(|| {
            KeyError::invalid(crate::text!(
                "errors.keys.publicKeyInvalid",
                "the public key is invalid"
            ))
        })?;
    let home = remote.absolute("")?;
    let ssh_dir = join(&home, ".ssh");
    let is_dir = |m: Option<crate::sftp::RemoteMeta>| m.is_some_and(|m| m.kind == EntryKind::Dir);
    match remote.stat_link(&ssh_dir).await? {
        None => match remote.make_dir(&ssh_dir, 0o700).await {
            Ok(()) => {}
            Err(FsError::AlreadyExists(_)) if is_dir(remote.stat_link(&ssh_dir).await?) => {}
            Err(FsError::AlreadyExists(_)) => return Err(ssh_dir_not_dir()),
            Err(e) => return Err(e.into()),
        },
        Some(m) if m.kind == EntryKind::Dir => {}
        Some(_) => return Err(ssh_dir_not_dir()),
    }
    let path = join(&ssh_dir, "authorized_keys");
    let existing = match remote.stat_link(&path).await? {
        None => None,
        Some(m) if m.kind == EntryKind::Symlink => {
            return Err(KeyError::invalid(crate::text!(
                "errors.keys.authorizedKeysLink",
                "authorized_keys is a link, edit it by hand"
            )));
        }
        Some(m) if m.kind == EntryKind::File => Some(read_capped(remote, &path).await?),
        Some(_) => {
            return Err(KeyError::invalid(crate::text!(
                "errors.keys.authorizedKeysNotFile",
                "authorized_keys is not a regular file"
            )));
        }
    };
    let found = existing.as_deref().map_or(Presence::Absent, |c| {
        presence(&String::from_utf8_lossy(c), kind, blob)
    });
    match found {
        Presence::Plain => return Ok(Deployed::AlreadyPresent),
        Presence::WithOptions => return Ok(Deployed::PresentWithOptions),
        Presence::Absent => {}
    }
    let mut content = existing.clone().unwrap_or_default();
    if !content.is_empty() && !content.ends_with(b"\n") {
        content.push(b'\n');
    }
    content.extend_from_slice(public_key.as_bytes());
    content.push(b'\n');
    replace_file(
        remote,
        &ssh_dir,
        "authorized_keys",
        &content,
        existing.is_some(),
    )
    .await?;
    Ok(Deployed::Added)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_lines_win_over_lines_with_options() {
        use Presence::*;
        let content = "
# ssh-ed25519 AAAA commented
ssh-rsa BBBB old
from=\"10.0.0.1\",command=\"echo ssh-ed25519 CCCC\" ssh-ed25519 DDDD me
";
        assert_eq!(presence(content, "ssh-rsa", "BBBB"), Plain);
        assert_eq!(presence(content, "ssh-ed25519", "DDDD"), WithOptions);
        assert_eq!(presence(content, "ssh-ed25519", "AAAA"), Absent);
        assert_eq!(presence(content, "ssh-ed25519", "CCCC"), Absent);
        assert_eq!(presence(content, "ssh-ed25519", "BBBB"), Absent);
        assert_eq!(presence("ssh-rsa BBBB", "ssh-rsa", "BBBB"), Plain);
        let both = "restrict ssh-rsa BBBB
cert-authority ssh-rsa BBBB
ssh-rsa BBBB x
";
        assert_eq!(presence(both, "ssh-rsa", "BBBB"), Plain);
        assert_eq!(
            presence("cert-authority ssh-rsa BBBB", "ssh-rsa", "BBBB"),
            WithOptions
        );
    }

    #[test]
    fn quoted_fields_keep_spaces_and_escapes() {
        assert_eq!(
            fields(r#"command="a \" b" ssh-ed25519 X c"#, 3),
            vec![r#"command="a \" b""#, "ssh-ed25519", "X"]
        );
    }
}
