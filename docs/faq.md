# FAQ and troubleshooting

## Installing

### Windows says "Windows protected your PC"

The installers are not code-signed, so SmartScreen does not know them. Choose **More info**, then **Run anyway**. Check the download against `SHA256SUMS.txt` first if you want to be sure it is the published file; see [Verify a download](../README.md#download).

### macOS says Carapace cannot be opened, or is damaged

The app is ad-hoc signed, not notarized by Apple, so Gatekeeper blocks it. Open System Settings > Privacy & Security and choose **Open Anyway** next to the Carapace message, or run:

```
xattr -dr com.apple.quarantine /Applications/Carapace.app
```

### The AppImage does not start

Make it executable (`chmod +x carapace-linux-x64.AppImage`) and install FUSE 2: `libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and later. See [Installation](installation.md#appimage).

## Connecting

### "Host key has changed"

The server presented a key that differs from the one stored for this host, so the connection was refused. Common reasons are a reinstalled server, regenerated host keys, or a different machine now answering at that address (a new VM on a reused IP). It can also mean someone is intercepting the connection.

Ask the server administrator for the new fingerprint, or read it on the server:

```
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
```

If it matches the **Presented** fingerprint, choose **Replace stored key** and connect again. If the old key came from your `~/.ssh/known_hosts`, Carapace stores the new key in its own file and leaves yours unchanged; update yours with `ssh-keygen -R <host>` if you also use `ssh`.

### "Missing variables: …"

The host uses `${name}` references that are not defined for its scope. A host at Home sees only global variables; a project host sees its project's variables and the global ones. Define them in the variables editor, or edit the host. See [Variables](variables.md#missing-variables).

### Authentication fails although the password is right

Carapace supports password, public key and SSH agent authentication. Servers that only allow keyboard-interactive authentication (some two-factor setups) are not supported yet. Check the server's `sshd_config` for `PasswordAuthentication yes`.

If a saved password was refused, Carapace deletes it and asks again on the next connection.

### "the server cannot replace authorized_keys atomically"

Deploying a key to a host that already has an `authorized_keys` file needs the `posix-rename@openssh.com` SFTP extension, which OpenSSH provides. Add the public key by hand on such servers: use **Copy public key** on the SSH keys page.

## Keychain

### The keychain is unavailable on Linux

Messages such as "Unlock or enable the system keychain, then try again" mean Carapace could not reach a Secret Service provider. Carapace needs one to store and read passwords, passphrases and secret variables.

- Check that GNOME Keyring or KWallet is installed and running in your session, and that the keyring is unlocked. On GNOME it usually starts with the session; on KDE enable KWallet and its Secret Service integration.
- On minimal window managers, start `gnome-keyring-daemon` with your session (with the `secrets` component), or install another Secret Service provider such as KeePassXC with its Secret Service integration turned on.
- Over SSH or without a desktop session there is usually no Secret Service.

### Where are my passwords?

In the system keychain under the service `org.tbounsiar.carapace`: Credential Manager on Windows, Keychain Access on macOS, Seahorse or KWalletManager on Linux. See [Security](security.md#secrets-and-the-system-keychain).

## Data

### Where is my data?

In the data folder: `~/.carapace` by default, `%USERPROFILE%\.carapace` on Windows.

| Path | Content |
| - | - |
| `config.json` | Projects, collections, hosts, variables (secret ones without value), registered key paths, external editor setting, usage data answer |
| `known_hosts` | Host keys you accepted in Carapace |
| `keys/` | Keys generated in the default folder |
| `edit/` | Copies of files open in an external editor |

Theme, default key type and terminal font size are stored by the app itself, not in this folder. Passwords and passphrases are in the system keychain.

### Using another data folder (`$CARAPACE_HOME`)

Set the `CARAPACE_HOME` environment variable before starting Carapace. It must be an absolute path or start with `~/`; an empty value is ignored.

macOS:

```
CARAPACE_HOME=~/work-carapace /Applications/Carapace.app/Contents/MacOS/Carapace
```

Linux:

```
CARAPACE_HOME=~/work-carapace ./carapace-linux-x64.AppImage
```

Windows (PowerShell), for the current user:

```powershell
[Environment]::SetEnvironmentVariable('CARAPACE_HOME', 'D:\carapace-data', 'User')
```

On Windows, sign out and in again (or restart Explorer) so apps started from the Start menu see the new variable. Keychain entries are not tied to the folder: two data folders share the same keychain service.

### Backing up or moving to another computer

Copy the data folder. Secret variable values and saved passwords are in the keychain and do not move with it: set them again on the new computer. Keys imported from elsewhere stay at their original path, so copy them too and fix their path if needed.

### "config.json" cannot be read

If `config.json` is damaged or was edited by hand into an invalid state, Carapace does not overwrite it and reports an error on every action. Move `config.json` out of the data folder to start fresh, or restore it from a backup. When Carapace upgrades the file format it keeps the previous file next to it (for example `config.json.v2.bak`).

### Leftover `.carapace-part` files

An interrupted transfer (crash, lost connection) can leave a hidden `.name.carapace-part` file next to the target. Carapace never deletes these on its own, because it cannot tell them from a transfer still running in another instance of Carapace. Delete them by hand.
