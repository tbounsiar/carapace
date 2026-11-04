//! Starting the editor on a local copy, and showing a copy in the file manager. Only Rust ever
//! names the local path; the copy's path is always absolute, so it can never be read as an
//! option by the editor.

use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::error::EditError;
use super::rules;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opener {
    System,
    /// An app the user chose; the copy's path is its only argument.
    App(PathBuf),
}

pub trait Launcher: Send + Sync + 'static {
    fn open(&self, file: &Path, opener: &Opener) -> Result<(), EditError>;
    /// Shows `file` in the system file manager.
    fn reveal(&self, file: &Path) -> Result<(), EditError>;
}

fn app_label(app: &Path) -> String {
    app.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Interpreters, shells, terminals, script hosts and openers: run or hand over a file instead of
/// editing it. One list for both uses: refused as the custom editor, and a default handler
/// among them makes the system opener run the file.
const RUNNERS: &[&str] = &[
    "powershell",
    "powershell_ise",
    "pwsh",
    "cmd",
    "conhost",
    "wt",
    "wscript",
    "cscript",
    "mshta",
    "rundll32",
    "regsvr32",
    "msiexec",
    "mmc",
    "hh",
    "msbuild",
    "explorer",
    "wsl",
    "wslview",
    "py",
    "pyw",
    "perl",
    "wperl",
    "ruby",
    "rubyw",
    "java",
    "javaw",
    "javaws",
    "php",
    "php-win",
    "tclsh",
    "wish",
    "lua",
    "node",
    "deno",
    "bun",
    "bash",
    "git-bash",
    "mintty",
    "sh",
    "zsh",
    "dash",
    "fish",
    "env",
    "busybox",
    "sudo",
    "nohup",
    "x-terminal-emulator",
    "xterm",
    "konsole",
    "gnome-terminal",
    "kitty",
    "alacritty",
    "open",
    "xdg-open",
    "gio",
    "exo-open",
    "gnome-open",
    "mimeopen",
    "osascript",
    "terminal.app",
    "iterm.app",
];
/// Names that come with any suffix (`python3.12`, `pythonw`, `AutoHotkey64`, `kde-open5`).
const RUNNER_PREFIXES: &[&str] = &["python", "autohotkey", "autoit3", "kde-open"];

/// Whether a program name (a path, a quoted command line's program) is one of `RUNNERS`,
/// also with a version suffix (`perl5.36`, `lua5.4`, `tclsh8.6`).
fn is_runner(program: &str) -> bool {
    let name = program
        .trim()
        .trim_matches('"')
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(program)
        .trim_end_matches(['.', ' '])
        .to_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    RUNNER_PREFIXES.iter().any(|p| stem.starts_with(p))
        || RUNNERS.iter().any(|r| {
            stem.strip_prefix(r)
                .is_some_and(|rest| rest.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
        })
}

fn not_an_editor(app: &Path) -> bool {
    let name = app_label(app);
    let name = name.trim_end_matches(['.', ' ']);
    // A script as the editor runs through its interpreter.
    let script = rules::extension(name)
        .is_some_and(|e| e != "exe" && e != "app" && rules::runs_on_windows(&e));
    script || is_runner(name)
}

/// Whether `app` can be started: a local absolute path to a file (or an `.app` bundle on
/// macOS) that is not an interpreter, shell, terminal, opener or script, by the name given and
/// by its final name (links, and on Windows 8.3 short names, resolved).
pub fn check_app(app: &Path) -> Result<(), EditError> {
    let missing = || EditError::AppNotFound {
        app: app_label(app),
    };
    if !crate::fsutil::is_local_path(app) {
        return Err(missing());
    }
    let refused = || EditError::AppNotEditor {
        app: app_label(app),
    };
    if not_an_editor(app) {
        return Err(refused());
    }
    let real = crate::fsutil::canonical(app).map_err(|_| missing())?;
    if !crate::fsutil::is_local_path(&real) {
        return Err(missing());
    }
    if not_an_editor(&real) {
        return Err(refused());
    }
    match std::fs::metadata(&real) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(m) if m.is_dir() && cfg!(target_os = "macos") && is_bundle(&real) => Ok(()),
        _ => Err(missing()),
    }
}

fn is_bundle(app: &Path) -> bool {
    rules::extension(&app.to_string_lossy()).as_deref() == Some("app")
}

/// Exec bit and first bytes of the copy, opened without following a link.
fn inspect(file: &Path) -> Result<(bool, Vec<u8>), EditError> {
    let f = crate::fsutil::open_regular(file, false).map_err(|_| EditError::Local)?;
    let exec = super::disk::exec_bit(&f.metadata().map_err(|_| EditError::Local)?);
    let mut head = Vec::with_capacity(rules::HEAD_BYTES);
    f.take(rules::HEAD_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|_| EditError::Local)?;
    Ok((exec, head))
}

/// Refuses what the system default opener would run instead of edit. `file` is the copy once
/// it exists: its exec bit and content count too.
pub fn check_type(local_name: &str, file: Option<&Path>, opener: &Opener) -> Result<(), EditError> {
    if *opener != Opener::System {
        return Ok(());
    }
    let (exec, head) = match file {
        Some(f) => inspect(f)?,
        None => (false, Vec::new()),
    };
    let platform = rules::Platform::current();
    if rules::would_run(&platform, local_name, exec, &head) || handler_runs(local_name) {
        return Err(EditError::BlockedType {
            name: local_name.to_owned(),
            ext: rules::extension(local_name).unwrap_or_default(),
        });
    }
    Ok(())
}

/// COM initialised on the current (blocking) thread for the shell calls, as the shell API
/// requires; undone on drop when this call did it.
pub struct ComApartment(#[allow(dead_code)] bool);

impl ComApartment {
    pub fn enter() -> Self {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Com::{
                COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx,
            };
            // SAFETY: no reserved pointer; balanced by CoUninitialize in `drop` on success.
            let hr = unsafe {
                CoInitializeEx(
                    std::ptr::null(),
                    (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
                )
            };
            Self(hr >= 0)
        }
        #[cfg(not(windows))]
        Self(false)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.0 {
            // SAFETY: matches the successful CoInitializeEx of `enter` on this thread.
            unsafe { windows_sys::Win32::System::Com::CoUninitialize() };
        }
    }
}

/// `AssocQueryStringW` result: no program registered for the extension.
#[cfg(windows)]
const NO_ASSOCIATION: i32 = 0x8007_0483_u32 as i32;

/// Windows: whether the program the system opener would start for this extension (default
/// verb, as `open` passes no verb for files) is one of `RUNNERS`. Any failure other than "no
/// association" counts as running: the handler is unknown.
#[cfg(windows)]
fn handler_runs(local_name: &str) -> bool {
    use windows_sys::Win32::UI::Shell::{
        ASSOCF_INIT_IGNOREUNKNOWN, ASSOCF_NOTRUNCATE, ASSOCSTR_EXECUTABLE, AssocQueryStringW,
    };
    let Some(ext) = rules::extension(local_name) else {
        return false;
    };
    let _com = ComApartment::enter();
    let assoc: Vec<u16> = format!(".{ext}").encode_utf16().chain(Some(0)).collect();
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: NUL-terminated input, a writable buffer of `len` UTF-16 units.
    let hr = unsafe {
        AssocQueryStringW(
            ASSOCF_NOTRUNCATE | ASSOCF_INIT_IGNOREUNKNOWN,
            ASSOCSTR_EXECUTABLE,
            assoc.as_ptr(),
            std::ptr::null(),
            buf.as_mut_ptr(),
            &mut len,
        )
    };
    if hr == NO_ASSOCIATION {
        return false;
    }
    if hr < 0 {
        return true;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    is_runner(&String::from_utf16_lossy(&buf[..end]))
}

#[cfg(not(windows))]
fn handler_runs(_local_name: &str) -> bool {
    false
}

/// `%windir%\explorer.exe`, from the system rather than a search of `PATH`.
#[cfg(windows)]
fn explorer() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;
    let mut buf = vec![0u16; 512];
    // SAFETY: a writable buffer of the size given.
    let n = unsafe { GetWindowsDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return None;
    }
    let dir = PathBuf::from(std::ffi::OsString::from_wide(&buf[..n]));
    Some(dir.join("explorer.exe"))
}

pub struct OsLauncher;

fn spawn(mut cmd: Command, app: &Path) -> Result<(), EditError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match cmd.spawn() {
        Ok(mut child) => {
            // Reaped on its own thread so it never lingers as a zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Err(EditError::AppNotFound {
            app: app_label(app),
        }),
        Err(_) => Err(EditError::AppFailed),
    }
}

impl Launcher for OsLauncher {
    fn open(&self, file: &Path, opener: &Opener) -> Result<(), EditError> {
        match opener {
            Opener::System => {
                let _com = ComApartment::enter();
                open::that_detached(file).map_err(|_| EditError::AppFailed)
            }
            Opener::App(app) => {
                check_app(app)?;
                if cfg!(target_os = "macos") && is_bundle(app) {
                    let mut cmd = Command::new("/usr/bin/open");
                    cmd.arg("-a").arg(app).arg(file);
                    return spawn(cmd, app);
                }
                let mut cmd = Command::new(app);
                cmd.arg(file);
                spawn(cmd, app)
            }
        }
    }

    fn reveal(&self, file: &Path) -> Result<(), EditError> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let exe = explorer().ok_or(EditError::AppFailed)?;
            let mut cmd = Command::new(&exe);
            // The copy's name never holds a quote (see `rules::local_name`).
            cmd.raw_arg(format!("/select,\"{}\"", file.display()));
            spawn(cmd, &exe).map_err(|_| EditError::AppFailed)
        }
        #[cfg(target_os = "macos")]
        {
            let mut cmd = Command::new("/usr/bin/open");
            cmd.arg("-R").arg(file);
            spawn(cmd, Path::new("open")).map_err(|_| EditError::AppFailed)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let dir = file.parent().ok_or(EditError::AppFailed)?;
            open::that_detached(dir).map_err(|_| EditError::AppFailed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_types_apply_to_the_system_opener_only() {
        #[cfg(windows)]
        let program = "setup.exe";
        #[cfg(target_os = "macos")]
        let program = "run.command";
        #[cfg(not(any(windows, target_os = "macos")))]
        let program = "x.desktop";
        let err = check_type(program, None, &Opener::System).unwrap_err();
        assert_eq!(err.code(), "blocked_type");
        assert!(!err.to_string().contains(std::path::MAIN_SEPARATOR));
        assert!(check_type(program, None, &Opener::App("/x".into())).is_ok());
        assert!(check_type("nginx.conf", None, &Opener::System).is_ok());
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn the_content_of_the_copy_counts_on_linux() {
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("notes.txt");
        std::fs::write(&copy, b"MZ\x90\x00").unwrap();
        let err = check_type("notes.txt", Some(&copy), &Opener::System).unwrap_err();
        assert_eq!(err.code(), "blocked_type");
        std::fs::write(&copy, b"plain").unwrap();
        assert!(check_type("notes.txt", Some(&copy), &Opener::System).is_ok());
    }

    #[test]
    fn runners_are_recognised_by_name_and_version() {
        for h in [
            r"C:\Windows\py.exe",
            r#""C:\Python312\python.exe""#,
            r"C:\Python312\pythonw.exe",
            r"C:\Program Files\Git\git-bash.exe",
            r"C:\Windows\System32\WScript.exe",
            r"C:\Windows\System32\mshta.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Windows\System32\rundll32.exe",
            "/usr/bin/bash",
            r"C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe",
            r"C:\Program Files (x86)\AutoIt3\AutoIt3_x64.exe",
            r"C:\Program Files\Java\bin\javaws.exe",
            r"C:\php\php-win.exe",
            r"C:\Strawberry\perl\bin\wperl.exe",
            r"C:\Ruby\bin\rubyw.exe",
            "/usr/bin/tclsh8.6",
            "/usr/bin/wish",
            "/usr/bin/lua5.4",
            "/usr/bin/perl5.36",
            r"C:\Program Files\Git\usr\bin\mintty.exe",
            r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\wt.exe",
            r"C:\Windows\System32\conhost.exe",
            r"C:\Program Files\Git\git-bash.exe",
            "cmd.exe. . ",
            "/usr/bin/kde-open5",
        ] {
            assert!(is_runner(h), "{h}");
        }
        for h in [
            r"C:\Windows\System32\notepad.exe",
            r"C:\VSCode\Code.exe",
            r"C:\JetBrains\phpstorm64.exe",
            r"C:\x\perlscript-editor.exe",
            "/usr/bin/kate",
            "/usr/bin/luakit-editor",
        ] {
            assert!(!is_runner(h), "{h}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_registered_handler_is_queried_without_failing() {
        assert!(
            !handler_runs("nothing.zz-carapace-unknown"),
            "no association"
        );
        assert!(!handler_runs("noext"));
        let exe = explorer().unwrap();
        assert!(
            exe.is_absolute() && exe.ends_with("explorer.exe"),
            "{exe:?}"
        );
    }

    #[test]
    fn a_link_to_a_runner_is_judged_by_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("pwsh.exe");
        std::fs::write(&shell, b"").unwrap();
        let link = dir.path().join("editor.exe");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&shell, &link).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&shell, &link).is_ok();
        if linked {
            assert_eq!(check_app(&link).unwrap_err().code(), "app_not_editor");
        }
    }

    #[test]
    fn a_missing_or_remote_app_is_not_found_by_name_only() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("editor.exe");
        let err = check_app(&app).unwrap_err();
        assert_eq!(
            err,
            EditError::AppNotFound {
                app: "editor.exe".into()
            }
        );
        std::fs::write(&app, b"").unwrap();
        assert!(check_app(&app).is_ok());
        assert!(check_app(dir.path()).is_err());
        assert_eq!(
            check_app(Path::new("relative.exe")).unwrap_err().code(),
            "app_not_found"
        );
        #[cfg(windows)]
        assert_eq!(
            check_app(Path::new(r"\\host\share\e.exe"))
                .unwrap_err()
                .code(),
            "app_not_found"
        );
    }

    #[test]
    fn interpreters_shells_and_openers_are_not_editors() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "powershell.exe",
            "pwsh",
            "CMD.EXE",
            "wscript.exe",
            "cscript.exe",
            "mshta.exe",
            "python3.12",
            "pythonw.exe",
            "py.exe",
            "bash",
            "sh",
            "zsh",
            "node.exe",
            "explorer.exe",
            "rundll32.exe",
            "open",
            "xdg-open",
            "gio",
            "Terminal.app",
            "iTerm.app",
            "open.cmd",
            "edit.bat",
            "edit.ps1",
            "edit.vbs",
            "edit.sh",
            "cmd.exe.",
            "Perl.exe",
            "env",
            "busybox",
            "wslview",
            "regsvr32.exe",
            "msbuild.exe",
            "konsole",
            "kde-open5",
        ] {
            let app = dir.path().join(name);
            std::fs::write(&app, b"").unwrap();
            let err = check_app(&app).unwrap_err();
            assert_eq!(err.code(), "app_not_editor", "{name}");
            assert!(
                !err.to_string().contains(std::path::MAIN_SEPARATOR),
                "{err}"
            );
        }
        for name in [
            "Code.exe",
            "notepad++.exe",
            "subl",
            "vim",
            "pycharm64.exe",
            "phpstorm64.exe",
        ] {
            let app = dir.path().join(name);
            std::fs::write(&app, b"").unwrap();
            assert!(check_app(&app).is_ok(), "{name}");
        }
    }
}
