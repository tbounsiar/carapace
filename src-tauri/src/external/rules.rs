//! Pure rules: size limits, local file names, file types the system would run, and names that
//! look like they hold secrets.

/// Up to this size a file opens without asking.
pub const CONFIRM_BYTES: u64 = 20 * 1024 * 1024;
/// Never downloaded or uploaded above this size.
pub const MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// Bytes of the copy read to recognise a program by its content (room for comment lines
/// before a desktop entry header).
pub const HEAD_BYTES: usize = 4096;
/// Longest local copy name; long names plus the app home could exceed what editors handle.
const MAX_LOCAL_NAME_BYTES: usize = 150;
const MAX_EXT_BYTES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Direct,
    Confirm,
    Refused,
}

pub fn size_class(size: u64) -> Size {
    match size {
        s if s > MAX_BYTES => Size::Refused,
        s if s > CONFIRM_BYTES => Size::Confirm,
        _ => Size::Direct,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

pub const CURRENT_OS: Os = if cfg!(windows) {
    Os::Windows
} else if cfg!(target_os = "macos") {
    Os::Mac
} else {
    Os::Linux
};

/// What the system default opener is judged against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Platform {
    pub os: Os,
    /// Linux under WSL: the opener may hand files to Windows (`wslview`).
    pub wsl: bool,
    /// `%PATHEXT%` (Windows): extensions the shell runs as programs.
    pub pathext: String,
}

impl Platform {
    pub fn current() -> Self {
        Self {
            os: CURRENT_OS,
            wsl: CURRENT_OS == Os::Linux
                && (std::env::var_os("WSL_DISTRO_NAME").is_some()
                    || std::path::Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()),
            pathext: std::env::var("PATHEXT").unwrap_or_default(),
        }
    }
}

const WINDOWS_RUN: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "ps1xml",
    "psc1",
    "ps2",
    "ps2xml",
    "psc2",
    "msh",
    "msh1",
    "msh2",
    "mshxml",
    "vbs",
    "vbe",
    "vb",
    "js",
    "jse",
    "wsf",
    "wsh",
    "ws",
    "wsc",
    "sct",
    "shb",
    "shs",
    "hta",
    "msi",
    "msp",
    "mst",
    "lnk",
    "url",
    "website",
    "scr",
    "cpl",
    "reg",
    "jar",
    "appref-ms",
    "application",
    "ahk",
    "au3",
    "a3x",
    "jnlp",
    "rdp",
    "appinstaller",
    "xbap",
    "xll",
    "mde",
    "ade",
    "adp",
    "accde",
    "pif",
    "msc",
    "scf",
    "inf",
    "chm",
    "gadget",
    "settingcontent-ms",
    "appx",
    "appxbundle",
    "msix",
    "msixbundle",
    "diagcab",
    "library-ms",
    "search-ms",
    "py",
    "pyw",
    "pyz",
    "pyzw",
    "sh",
    "pl",
    "rb",
    "tcl",
    // Opening these makes Windows authenticate to a host they name (NTLM hash leak).
    "theme",
    "themepack",
    "deskthemepack",
    "searchconnector-ms",
];
const MACOS_RUN: &[&str] = &[
    "app", "command", "tool", "pkg", "mpkg", "terminal", "jar", "webloc", "inetloc", "fileloc",
];
const LINUX_RUN: &[&str] = &[
    "desktop",
    "kdesktop",
    "jar",
    "appimage",
    "flatpakref",
    "flatpakrepo",
    // Wine registers these with the desktop.
    "exe",
    "msi",
    "com",
    "bat",
    "lnk",
];

/// Extension, lowercased, of a local name (`None` without one, or for a dot file's name).
pub fn extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    Some(ext.to_lowercase())
}

fn in_pathext(pathext: &str, ext: &str) -> bool {
    pathext
        .split(';')
        .map(|e| e.trim().trim_start_matches('.').to_lowercase())
        .any(|e| !e.is_empty() && e == ext)
}

/// An extension Windows runs (the list, not `%PATHEXT%`).
pub fn runs_on_windows(ext: &str) -> bool {
    WINDOWS_RUN.contains(&ext)
}

/// Windows decides by extension; anything unusual (a `{CLSID}` that names a handler, spaces,
/// non-ASCII) is refused rather than guessed.
fn windows_runs(ext: &str, pathext: &str) -> bool {
    ext.starts_with('{')
        || !ext
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
        || WINDOWS_RUN.contains(&ext)
        || in_pathext(pathext, ext)
}

fn without_bom(head: &[u8]) -> &[u8] {
    head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head)
}

/// The first line that is neither blank nor a `#` comment.
fn first_statement(text: &[u8]) -> &[u8] {
    text.split(|&b| b == b'\n')
        .map(|line| line.trim_ascii())
        .find(|line| !line.is_empty() && !line.starts_with(b"#"))
        .unwrap_or_default()
}

/// Content the Linux desktop runs whatever the name: PE (through Wine), ELF, scripts with a
/// shebang, desktop entries (comments and blank lines may come first).
fn linux_program(head: &[u8]) -> bool {
    let text = without_bom(head);
    if head.starts_with(b"MZ") || head.starts_with(b"\x7fELF") || text.starts_with(b"#!") {
        return true;
    }
    let first = first_statement(text);
    first.starts_with(b"[Desktop Entry]") || first.starts_with(b"[KDE Desktop Entry]")
}

/// Mach-O (thin, 32/64 bit, either byte order), fat binaries, and shebang scripts.
fn mac_program(head: &[u8]) -> bool {
    const MAGIC: [[u8; 4]; 6] = [
        [0xFE, 0xED, 0xFA, 0xCE],
        [0xCE, 0xFA, 0xED, 0xFE],
        [0xFE, 0xED, 0xFA, 0xCF],
        [0xCF, 0xFA, 0xED, 0xFE],
        [0xCA, 0xFE, 0xBA, 0xBE],
        [0xBE, 0xBA, 0xFE, 0xCA],
    ];
    MAGIC.iter().any(|m| head.starts_with(m)) || without_bom(head).starts_with(b"#!")
}

/// Whether the system default opener would run the file instead of opening it for editing.
/// `exec`: the copy carries an execute bit (Unix); `head`: its first bytes.
pub fn would_run(p: &Platform, local_name: &str, exec: bool, head: &[u8]) -> bool {
    let ext = extension(local_name);
    match p.os {
        Os::Windows => ext.is_some_and(|e| windows_runs(&e, &p.pathext)),
        Os::Mac => {
            exec || mac_program(head) || ext.is_some_and(|e| MACOS_RUN.contains(&e.as_str()))
        }
        Os::Linux => {
            exec || linux_program(head)
                || ext.as_deref().is_some_and(|e| {
                    LINUX_RUN.contains(&e) || (p.wsl && windows_runs(e, &p.pathext))
                })
        }
    }
}

/// Names that usually hold keys, passwords or tokens, on a remote path.
pub fn is_sensitive(remote_path: &str) -> bool {
    let lower_path = remote_path.to_lowercase();
    if matches!(
        lower_path.as_str(),
        "/etc/shadow" | "/etc/gshadow" | "/etc/shadow-" | "/etc/gshadow-"
    ) || lower_path.ends_with("/.aws/credentials")
        || lower_path.ends_with("/.kube/config")
    {
        return true;
    }
    let name = lower_path.rsplit('/').next().unwrap_or(&lower_path);
    if (name.starts_with("id_") && !name.ends_with(".pub"))
        || name.starts_with(".env")
        || name.starts_with("secring.")
        || matches!(
            name,
            ".netrc" | "_netrc" | ".pgpass" | ".git-credentials" | ".htpasswd" | "wp-config.php"
        )
    {
        return true;
    }
    matches!(
        extension(name).as_deref(),
        Some(
            "pem"
                | "key"
                | "p12"
                | "pfx"
                | "kdbx"
                | "ppk"
                | "jks"
                | "keystore"
                | "p8"
                | "gpg"
                | "asc"
                | "ovpn"
        )
    )
}

/// Unicode format characters (category Cf): invisible, and some reorder the displayed name
/// (U+202E makes `cod.exe` look like `exe.doc`).
fn is_format(c: char) -> bool {
    matches!(
        c as u32,
        0xAD | 0x600..=0x605
            | 0x61C
            | 0x6DD
            | 0x70F
            | 0x890..=0x891
            | 0x8E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
    )
}

fn reserved_stem(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .to_ascii_uppercase();
    let numbered = |rest: &str| {
        let mut chars = rest.chars();
        matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_digit() || "¹²³".contains(c))
    };
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(numbered)
}

fn cut(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A local name for the copy of the remote file `remote_name`: same name when possible (the
/// editor picks its language from it), with characters no platform accepts and invisible
/// format characters replaced, no reserved device name, never one of the names the edit
/// directory uses itself.
pub fn local_name(remote_name: &str) -> String {
    let mut name: String = remote_name
        .chars()
        .map(|c| {
            if c.is_control() || is_format(c) || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    while name.ends_with(['.', ' ']) {
        name.pop();
    }
    if name.len() > MAX_LOCAL_NAME_BYTES {
        name = match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() && ext.len() <= MAX_EXT_BYTES => {
                format!("{}.{ext}", cut(stem, MAX_LOCAL_NAME_BYTES - ext.len() - 1))
            }
            _ => cut(&name, MAX_LOCAL_NAME_BYTES).to_owned(),
        };
    }
    let lower = name.to_lowercase();
    if reserved_stem(&name)
        || lower.starts_with(".carapace")
        || lower.starts_with("..carapace")
        || lower.ends_with(".carapace-part")
    {
        name.insert(0, '_');
    }
    if name.is_empty() || name == "." || name == ".." || crate::localfs::name(&name).is_err() {
        return "file".into();
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(os: Os) -> Platform {
        Platform {
            os,
            wsl: false,
            pathext: String::new(),
        }
    }

    #[test]
    fn sizes_open_confirm_or_refuse() {
        assert_eq!(size_class(0), Size::Direct);
        assert_eq!(size_class(CONFIRM_BYTES), Size::Direct);
        assert_eq!(size_class(CONFIRM_BYTES + 1), Size::Confirm);
        assert_eq!(size_class(MAX_BYTES), Size::Confirm);
        assert_eq!(size_class(MAX_BYTES + 1), Size::Refused);
    }

    #[test]
    fn windows_blocks_programs_and_anything_unusual() {
        let w = on(Os::Windows);
        for name in [
            "setup.EXE",
            "x.ahk",
            "x.au3",
            "x.a3x",
            "x.jnlp",
            "x.rdp",
            "x.ps1",
            "a.lnk",
            "b.url",
            "c.appref-ms",
            "d.js",
            "e.hta",
            "x.sh",
            "run.py",
            "app.pyw",
            "z.pyz",
            "s.pl",
            "s.rb",
            "s.tcl",
            "w.wsc",
            "w.sct",
            "x.xll",
            "x.appinstaller",
            "x.website",
            "t.theme",
            "t.deskthemepack",
            "q.searchConnector-ms",
            "report.txt.{3050f4d8-98b5-11cf-bb82-00aa00bdce0b}",
            "x.{abc",
            "x.tx t",
            "x.café",
        ] {
            assert!(would_run(&w, name, false, b""), "{name}");
        }
        for name in [
            "nginx.conf",
            "app.yaml",
            "notes",
            ".bashrc",
            "a.tar.gz",
            "x.my-ext_2",
        ] {
            assert!(!would_run(&w, name, true, b"MZ"), "{name}");
        }
        let custom = Platform {
            pathext: ".COM;.EXE;.BAT;.CMD;.VBS;.MYRUN ; .Foo".into(),
            ..w
        };
        assert!(would_run(&custom, "a.myrun", false, b""));
        assert!(would_run(&custom, "a.FOO", false, b""));
        assert!(!would_run(&custom, "a.conf", false, b""));
    }

    #[test]
    fn mac_blocks_bundles_launchers_and_exec_bits() {
        let m = on(Os::Mac);
        for name in ["Tool.app", "run.command", "a.webloc", "p.pkg"] {
            assert!(would_run(&m, name, false, b""), "{name}");
        }
        assert!(!would_run(&m, "x.js", false, b"MZ"));
        assert!(would_run(&m, "tool", true, b""));
        for head in [
            &b"\xFE\xED\xFA\xCF\x07"[..],
            b"\xCF\xFA\xED\xFE\x07",
            b"\xFE\xED\xFA\xCE",
            b"\xCE\xFA\xED\xFE",
            b"\xCA\xFE\xBA\xBE",
            b"\xBE\xBA\xFE\xCA",
            b"#!/bin/sh\nrm -rf ~",
        ] {
            assert!(would_run(&m, "notes.txt", false, head), "{head:?}");
        }
        assert!(!would_run(&m, "notes.txt", false, b"# just notes"));
    }

    #[test]
    fn linux_blocks_by_name_content_and_exec_bit() {
        let l = on(Os::Linux);
        for name in [
            "x.desktop",
            "x.jar",
            "x.exe",
            "x.msi",
            "x.AppImage",
            "x.flatpakref",
            "x.kdesktop",
        ] {
            assert!(would_run(&l, name, false, b""), "{name}");
        }
        assert!(!would_run(&l, "x.js", false, b"var a"));
        assert!(!would_run(&l, "x.ps1", false, b""));
        assert!(would_run(&l, "backup.sh", true, b""));
        assert!(would_run(&l, "notes.txt", false, b"MZ\x90\x00"));
        assert!(would_run(&l, "notes.txt", false, b"\x7fELF\x02"));
        assert!(would_run(
            &l,
            "notes.txt",
            false,
            b"\xEF\xBB\xBF \n[Desktop Entry]\nExec=x"
        ));
        assert!(!would_run(&l, "notes.txt", false, b"# [Desktop Entry]"));
        assert!(would_run(
            &l,
            "notes.txt",
            false,
            b"# a comment\n\n  # another\r\n[Desktop Entry]\nExec=x"
        ));
        assert!(would_run(
            &l,
            "notes.txt",
            false,
            b"[KDE Desktop Entry]\nExec=x"
        ));
        assert!(would_run(
            &l,
            "notes.txt",
            false,
            b"#!/usr/bin/env python3\n"
        ));
        assert!(!would_run(
            &l,
            "notes.txt",
            false,
            b"# comment\nkey = 1\n[Desktop Entry]"
        ));
        let wsl = Platform { wsl: true, ..l };
        assert!(would_run(&wsl, "x.ps1", false, b""));
        assert!(would_run(&wsl, "x.{clsid}", false, b""));
        assert!(!would_run(&wsl, "nginx.conf", false, b""));
    }

    #[test]
    fn sensitive_names_need_a_confirm() {
        for path in [
            "/home/u/.ssh/id_ed25519",
            "/home/u/.ssh/ID_RSA",
            "/srv/tls/server.pem",
            "/srv/tls/server.KEY",
            "/x/cert.p12",
            "/x/cert.pfx",
            "/x/vault.kdbx",
            "/srv/app/.env",
            "/srv/app/.env.production",
            "/etc/shadow",
            "/etc/gshadow",
            "/home/u/.netrc",
            "/home/u/.pgpass",
            "/home/u/.git-credentials",
            "/home/u/.aws/credentials",
            "/home/u/.kube/config",
            "/var/www/.htpasswd",
            "/var/www/wp-config.php",
            "/x/putty.ppk",
            "/x/store.jks",
            "/x/app.keystore",
            "/x/AuthKey.p8",
            "/x/backup.gpg",
            "/x/key.asc",
            "/x/client.ovpn",
            "/home/u/.gnupg/secring.gpg",
        ] {
            assert!(is_sensitive(path), "{path}");
        }
        for path in [
            "/home/u/.ssh/id_ed25519.pub",
            "/etc/nginx/nginx.conf",
            "/srv/app/env",
            "/etc/shadow.d/x",
            "/home/u/shadow",
            "/x/keyboard.txt",
            "/x/pem",
            "/home/u/.aws/config",
            "/home/u/kube/config.yaml",
        ] {
            assert!(!is_sensitive(path), "{path}");
        }
    }

    #[test]
    fn local_names_keep_the_remote_name_when_they_can() {
        assert_eq!(local_name("nginx.conf"), "nginx.conf");
        assert_eq!(local_name(".bashrc"), ".bashrc");
        assert_eq!(local_name("a:b?c*.txt"), "a_b_c_.txt");
        assert_eq!(local_name("back\\slash"), "back_slash");
        assert_eq!(local_name("tab\there"), "tab_here");
        assert_eq!(local_name("trailing. ."), "trailing");
        assert_eq!(local_name("..."), "file");
        assert_eq!(local_name("CON.txt"), "_CON.txt");
        assert_eq!(local_name("lpt1"), "_lpt1");
        assert_eq!(local_name(".carapace-edit.json"), "_.carapace-edit.json");
        assert_eq!(local_name(".x.carapace-part"), "_.x.carapace-part");
        assert_eq!(local_name("invoice\u{202E}fdp.exe"), "invoice_fdp.exe");
        assert_eq!(local_name("a\u{200B}b\u{FEFF}.txt"), "a_b_.txt");
        assert_eq!(local_name("café.txt"), "café.txt");
        let long = format!("{}.yaml", "é".repeat(200));
        let cut = local_name(&long);
        assert!(
            cut.len() <= MAX_LOCAL_NAME_BYTES && cut.ends_with(".yaml"),
            "{cut}"
        );
        assert!(local_name(&"x".repeat(255)).len() <= MAX_LOCAL_NAME_BYTES);
    }
}
