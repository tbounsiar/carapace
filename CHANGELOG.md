# Changelog

## 0.1.0 (2026-11-05)

First public release, for Windows (x64, ARM64), macOS (Apple Silicon, Intel) and Linux (x64, ARM64: AppImage, deb, rpm).

### Features

- Hosts at Home or in projects, grouped in nested collections and movable between them, with a host filter and dashboards for Home and each project.
- Global and per-project variables (the project value wins) and `${var}` templates in host fields; secret variables live in the OS keychain.
- Host key verification against the app `known_hosts` and `~/.ssh/known_hosts`, with explicit prompts for unknown and changed keys.
- Password, passphrase-protected key, unencrypted key and SSH agent authentication, and a test connection in the host dialog. Passwords and passphrases are stored in the OS keychain.
- Terminal tabs sharing one SSH connection per host.
- Dual-pane SFTP explorer (local and remote) and a transfer queue with progress, cancel, conflict handling, multi-selection and drag and drop.
- A built-in editor for remote text files, and opening remote files in a local editor of your choice: saves are uploaded back with conflict detection, listed on the Edited files page.
- SSH key generation (Ed25519, RSA 4096) in a folder of your choice, import, and deployment to `authorized_keys`, with owner-only private key files.
- Dark and light themes following the system, with a manual toggle.
- Settings: theme, default key type, terminal font size, external editor, privacy, stored in a readable `settings.toml`; data (projects, collections, hosts, variables, key paths) in `data.json`.
- Anonymous usage data and crash reports in four categories (launch count, feature usage, connection results, crash reports), shown at first launch before anything is sent and switchable per category, in that question and in Settings > Privacy. `DO_NOT_TRACK` turns it all off. See PRIVACY.md.
- Import and export of data as JSON (everything, Home or one project), with a preview, merge / replace / keep both, a backup before every import and Undo. Secret values are never exported.
- Installers with fixed file names, so the README download links always point to the latest version, and user documentation in `docs/`.

### Known limitations

- Installers are not code-signed: Windows SmartScreen and macOS Gatekeeper warn on first launch.
- Host key checked on the initial key exchange only, not on rekey.
- No keyboard-interactive authentication; SSH agent use is less tested on Windows.
- Heavy terminal output can stall the shared connection.
- Transfers on one host share a single SFTP channel.
- Concurrent edits of `authorized_keys` during a key deployment can be lost.
- Downloaded files on Windows inherit the folder permissions; leftover `.carapace-part` files are not removed automatically.
- Secret variables must exist before a host can reference them.
- RSA signing depends on a crate with an unfixed advisory (RUSTSEC-2023-0071).
