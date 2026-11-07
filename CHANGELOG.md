# Changelog

## 0.2.0 (2026-11-07)

### Features

- Right-click menus on file and folder rows, the empty area of a pane, transfers, SSH keys, edited files, Home project cards and the empty part of the sidebar. They open at the pointer and offer the same entries as the row's **…** menu.
- In the file panes, a right click on a selected row acts on the whole selection: transfer, copy paths, or delete with one confirmation. New entries **Open**, **Upload to remote** / **Download to local** and **Copy path**.
- Terminal menu with **Copy**, **Paste**, **Select all** and **Clear scrollback**, and the shortcuts Ctrl+Shift+C / V / A (Cmd+C / V / A on macOS). Shift+right-click opens the menu while a program uses the mouse.
- Tab titles show the collections above the host (`clavis / production · Terminal 1`); the hint gives the full location.
- When a server refuses another session on the host's connection (OpenSSH `MaxSessions`, Dropbear's channel limit), the new terminal or file explorer opens on an extra connection to the same host. It is limited to four extra connections. The server must present the same host key, and only credentials that need no input are reused.
- A log file in the app log folder records connection ids, error codes and refusal reasons, never secrets or terminal content. See the FAQ.

### Changes

- Delete removes the whole selection in a file pane, not only the focused row.
- The webview's own menu (Back, Refresh, Print) no longer opens outside text fields: its Refresh reloaded the app and closed every session.
- "Open files" is now "Browse files".
- Opening a terminal or the file explorer reports why it failed: the server refused another session, a terminal (pty), a shell or SFTP, or did not answer in time. Before, every case said to check the network.

### Fixes

- A right click on a sidebar row opened two menus at once, and the menu was squeezed against the window edge.
- A long name in a nested collection scrolled the sidebar sideways.
- The tab hint covered the sidebar.

### Security

- Pasted text loses its control characters (except tabs and line breaks), so a copied escape sequence cannot end bracketed paste and run commands.
- The clipboard is read through the Tauri clipboard plugin, allowed to read and write plain text only.

### Known limitations

- Installers are not code-signed: Windows SmartScreen and macOS Gatekeeper warn on first launch.
- Host key checked on the initial key exchange only, not on rekey.
- No keyboard-interactive authentication; SSH agent use is less tested on Windows.
- Heavy terminal output can stall the shared connection.
- Transfers on one host share a single SFTP channel.
- The right-click menus and the clipboard were checked by hand on Windows only, and the Dropbear session limit against a test server only.

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
- English and French interface, following the system language or chosen in Settings.
- Settings: theme, language, default key type, terminal font size, external editor, privacy, stored in a readable `settings.toml`; data (projects, collections, hosts, variables, key paths) in `data.json`.
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
