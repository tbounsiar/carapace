//! Text decoding for the remote editor. The editor works on LF text; the line ending style and
//! the BOM found on read are reported so a save writes them back.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Largest file the editor reads or writes, in bytes on the server.
pub const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;

const BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Crlf,
    /// Both CRLF and bare LF; a save writes one style.
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

#[derive(Debug, PartialEq)]
pub struct Decoded {
    pub text: String,
    pub line_ending: LineEnding,
    pub bom: bool,
}

/// `None` for content that is not UTF-8 or holds a NUL byte.
pub fn decode(data: &[u8]) -> Option<Decoded> {
    let (bom, body) = match data.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, data),
    };
    if body.contains(&0) {
        return None;
    }
    let raw = std::str::from_utf8(body).ok()?;
    let crlf = raw.matches("\r\n").count();
    let lf = raw.matches('\n').count() - crlf;
    let line_ending = match (crlf, lf) {
        (0, _) => LineEnding::Lf,
        (_, 0) => LineEnding::Crlf,
        _ => LineEnding::Mixed,
    };
    let text = if crlf > 0 {
        raw.replace("\r\n", "\n")
    } else {
        raw.to_owned()
    };
    Some(Decoded {
        text,
        line_ending,
        bom,
    })
}

/// Bytes to write for `text` (LF lines; CRLF in it is accepted too).
pub fn encode(text: &str, eol: Eol, bom: bool) -> Vec<u8> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut out = Vec::with_capacity(text.len() + 3);
    if bom {
        out.extend_from_slice(BOM);
    }
    match eol {
        Eol::Lf => out.extend_from_slice(text.as_bytes()),
        Eol::Crlf => {
            for (i, line) in text.split('\n').enumerate() {
                if i > 0 {
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(line.strip_suffix('\r').unwrap_or(line).as_bytes());
            }
        }
    }
    out
}

fn sha256_hex(data: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(data))
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Opaque version of a file's content: size, mtime and a SHA-256 of the bytes, so an edit
/// within the same second (SFTP v3 mtimes are seconds) is still a change, plus a SHA-256 of
/// the path the content was read from (the target when opened through a link), so a link
/// pointed elsewhere is never saved through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub size: u64,
    pub mtime: Option<u32>,
    pub hash: String,
    pub place: String,
}

impl Version {
    pub fn of(data: &[u8], mtime: Option<u32>, real: &str) -> Self {
        Self {
            size: data.len() as u64,
            mtime,
            hash: sha256_hex(data),
            place: Self::place_of(real),
        }
    }

    pub fn place_of(real: &str) -> String {
        sha256_hex(real.as_bytes())
    }

    pub fn token(&self) -> String {
        let mtime = self.mtime.map_or_else(|| "-".into(), |m| m.to_string());
        format!("v2:{}:{mtime}:{}:{}", self.size, self.hash, self.place)
    }

    /// Only `v2`: `v1` tokens (no place) are refused.
    pub fn parse(token: &str) -> Option<Self> {
        let mut parts = token.split(':');
        if parts.next()? != "v2" {
            return None;
        }
        let size = parts.next()?.parse().ok()?;
        let mtime = match parts.next()? {
            "-" => None,
            m => Some(m.parse().ok()?),
        };
        let (hash, place) = (parts.next()?, parts.next()?);
        if parts.next().is_some() || !is_hash(hash) || !is_hash(place) {
            return None;
        }
        Some(Self {
            size,
            mtime,
            hash: hash.into(),
            place: place.into(),
        })
    }

    /// Whether a file with this size and mtime may still hold this version (the hash decides).
    pub fn may_match(&self, size: Option<u64>, mtime: Option<u32>) -> bool {
        size == Some(self.size) && mtime == self.mtime
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_line_endings_and_normalizes_to_lf() {
        let lf = decode(b"a\nb\n").unwrap();
        assert_eq!(
            (lf.text.as_str(), lf.line_ending, lf.bom),
            ("a\nb\n", LineEnding::Lf, false)
        );
        let crlf = decode(b"a\r\nb\r\n").unwrap();
        assert_eq!(
            (crlf.text.as_str(), crlf.line_ending),
            ("a\nb\n", LineEnding::Crlf)
        );
        let mixed = decode(b"a\r\nb\nc").unwrap();
        assert_eq!(
            (mixed.text.as_str(), mixed.line_ending),
            ("a\nb\nc", LineEnding::Mixed)
        );
        assert_eq!(decode(b"").unwrap().line_ending, LineEnding::Lf);
        assert_eq!(decode(b"no newline").unwrap().line_ending, LineEnding::Lf);
        let cr = decode(b"a\rb\r\n").unwrap();
        assert_eq!(
            (cr.text.as_str(), cr.line_ending),
            ("a\rb\n", LineEnding::Crlf)
        );
    }

    #[test]
    fn strips_the_bom_and_rejects_binary() {
        let d = decode(b"\xEF\xBB\xBFx=1\n").unwrap();
        assert_eq!((d.text.as_str(), d.bom), ("x=1\n", true));
        assert_eq!(decode(b"a\0b"), None);
        assert_eq!(decode(b"\xff\xfe"), None);
        assert_eq!(decode(b"caf\xc3"), None);
        assert_eq!(decode("café\n".as_bytes()).unwrap().text, "café\n");
    }

    #[test]
    fn encodes_back_what_was_read() {
        for raw in [
            &b"a\nb\n"[..],
            b"a\r\nb\r\n",
            b"\xEF\xBB\xBFa\r\nb",
            b"",
            b"a\rb\r\n",
        ] {
            let d = decode(raw).unwrap();
            let eol = if d.line_ending == LineEnding::Crlf {
                Eol::Crlf
            } else {
                Eol::Lf
            };
            assert_eq!(encode(&d.text, eol, d.bom), raw);
        }
        assert_eq!(encode("a\r\nb\n", Eol::Crlf, false), b"a\r\nb\r\n");
        assert_eq!(encode("\u{FEFF}a", Eol::Lf, true), b"\xEF\xBB\xBFa");
        assert_eq!(encode("\u{FEFF}a", Eol::Lf, false), b"a");
    }

    #[test]
    fn write_line_endings_are_lf_or_crlf_only() {
        assert_eq!(serde_json::from_str::<Eol>("\"lf\"").unwrap(), Eol::Lf);
        assert_eq!(serde_json::from_str::<Eol>("\"crlf\"").unwrap(), Eol::Crlf);
        assert!(serde_json::from_str::<Eol>("\"mixed\"").is_err());
    }

    #[test]
    fn version_tokens_round_trip_and_reject_garbage() {
        let v = Version::of(b"hello", Some(1_700_000_000), "/etc/a");
        assert_eq!(Version::parse(&v.token()), Some(v.clone()));
        assert!(v.token().starts_with("v2:5:1700000000:"));
        assert_eq!(v.place, Version::place_of("/etc/a"));
        let none = Version::of(b"", None, "/x");
        assert_eq!(Version::parse(&none.token()), Some(none));
        assert_ne!(Version::of(b"hellp", Some(1_700_000_000), "/etc/a"), v);
        assert_ne!(Version::of(b"hello", Some(1_700_000_000), "/etc/b"), v);
        let h = "a".repeat(64);
        let v1 = format!("v1:5:1:{h}");
        for bad in [
            "",
            "v2",
            v1.as_str(),
            &format!("v2:x:1:{h}:{h}"),
            &format!("v2:5:1:zz:{h}"),
            &format!("v2:5:1:{h}"),
            &format!("v2:5:1:{h}:{h}:b"),
        ] {
            assert_eq!(Version::parse(bad), None, "{bad}");
        }
        assert!(v.may_match(Some(5), Some(1_700_000_000)));
        assert!(!v.may_match(Some(5), Some(1_700_000_001)));
        assert!(!v.may_match(None, Some(1_700_000_000)));
    }
}
