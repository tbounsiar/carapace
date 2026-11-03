# Changelog

## Unreleased

### Changed

- Hosts can live at Home or in a project, grouped in nested collections, and be moved between them.
- Variables are global or per project; the project value wins.

### Removed

- Environments. On upgrade, the active environment of each project becomes that project's variables (its values win over project variables of the same name), so hosts resolve as before. Other environments are dropped and their keychain entries deleted. The previous `config.json` is kept as `config.json.v2.bak`.

## 0.1.0

First release (Windows).

### Features

- Projects, environments and variables with layered resolution (global, project, active environment) and `${var}` templates in host fields.
- Hosts connected per environment, several environments of one host at once.
- Host key verification against the app `known_hosts` and `~/.ssh/known_hosts`, with explicit prompts for unknown and changed keys.
- Password, passphrase-protected key, unencrypted key and SSH agent authentication; secrets stored in the OS keychain.
- Terminal tabs sharing one SSH connection per host.
- Dual-pane SFTP explorer (local and remote).
- Transfer queue with progress, cancel, conflict handling, multi-selection and drag and drop.
- SSH key generation (Ed25519, RSA 4096), import and deployment to `authorized_keys`, with owner-only private key files.
- Dark and light themes following the system, with a manual toggle.
- Settings page: theme, default key type, terminal font size.

### Known limitations

- Host key checked on the initial key exchange only, not on rekey.
- No keyboard-interactive authentication; SSH agent untested on Windows.
- Heavy terminal output can stall the shared connection.
- Transfers on one host share a single SFTP channel.
- Concurrent edits of `authorized_keys` during a key deployment can be lost.
- Downloaded files on Windows inherit the folder permissions; leftover `.carapace-part` files are not removed automatically.
- Secret variables must exist before a host can reference them.
- RSA signing depends on a crate with an unfixed advisory (RUSTSEC-2023-0071).
- Linux and macOS builds are untested.
