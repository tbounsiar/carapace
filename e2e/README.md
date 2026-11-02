# End-to-end SSH tests

A disposable OpenSSH server (Docker, alpine) bound to `127.0.0.1:2222` only, used by the gated Rust tests in `src-tauri/src/ssh/manager/e2e_tests.rs`, `src-tauri/src/terminal/manager/e2e_tests.rs` (PTY shell: echo, resize via `stty size`, exit status, close, disconnect) `src-tauri/src/sftp/manager/e2e_tests.rs` (SFTP through `internal-sftp`: listing, mkdir, rename, delete, symlinks not followed) and `src-tauri/src/commands/ssh/e2e_tests.rs` (hosts with `${var}` templates resolved per environment, two environments of one host connected at once on ports 2222 and 2223, a broken environment failing while the others stay connected, a password taken from a secret variable). The same server is also published on `127.0.0.1:2223` for the UI tests (`e2e/wdio/`): the app reads `~/.ssh/known_hosts`, and a personal entry for port 2222 would turn the first-connect prompt into a changed-key warning.

Requirements: Docker, Node, and `ssh-keygen` (OpenSSH client) on the PATH.

```
node e2e/sshd/setup.mjs up                # fresh keys + password in e2e/.work/, build, start, wait for the port
cd src-tauri
CARAPACE_E2E=1 cargo test e2e_tests       # PowerShell: $env:CARAPACE_E2E=1
node e2e/sshd/setup.mjs rotate-host-key   # regenerate the server host keys and restart sshd
node e2e/sshd/setup.mjs down              # stop and remove the container
```

- Without `CARAPACE_E2E=1` the tests return immediately, so plain `cargo test` needs no Docker.
- `e2e/.work/` is gitignored: Ed25519, RSA 4096, an Ed25519 key encrypted with a random passphrase (`id_ed25519_enc`, passphrase in `passphrase`) and an unauthorized ("wrong") key pair, `authorized_keys`, and the generated password of the `carapace` user (`password`). Nothing in it is committed.
- Password, passphrase and secret-variable tests use an in-memory secret store, never the system keychain.
- Each test uses its own temporary known_hosts files; the user's home is never touched.
- SFTP tests work in a fresh `e2e-sftp-<uuid>` directory under `/home/carapace` and delete it at the end. Changing `sshd_config` needs `setup.mjs up` again (it rebuilds the image).
- The host key rotation test calls `rotate-host-key` itself and runs exclusively.
- The agent test runs only when the local agent already holds `e2e/.work/id_ed25519` (`ssh-add e2e/.work/id_ed25519`); otherwise it prints a skip message.
