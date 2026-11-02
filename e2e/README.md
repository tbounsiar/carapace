# End-to-end SSH tests

A disposable OpenSSH server (Docker, alpine) bound to `127.0.0.1:2222` only, used by the gated Rust tests in `src-tauri/src/ssh/manager/e2e_tests.rs`.

Requirements: Docker, Node, and `ssh-keygen` (OpenSSH client) on the PATH.

```
node e2e/sshd/setup.mjs up                # fresh keys + password in e2e/.work/, build, start, wait for the port
cd src-tauri
CARAPACE_E2E=1 cargo test e2e_tests       # PowerShell: $env:CARAPACE_E2E=1
node e2e/sshd/setup.mjs rotate-host-key   # regenerate the server host keys and restart sshd
node e2e/sshd/setup.mjs down              # stop and remove the container
```

- Without `CARAPACE_E2E=1` the tests return immediately, so plain `cargo test` needs no Docker.
- `e2e/.work/` is gitignored: Ed25519, RSA 4096 and an unauthorized ("wrong") key pair, `authorized_keys`, and the generated password of the `carapace` user. Nothing in it is committed.
- Each test uses its own temporary known_hosts files; the user's home is never touched.
- The host key rotation test calls `rotate-host-key` itself and runs exclusively.
- The agent test runs only when the local agent already holds `e2e/.work/id_ed25519` (`ssh-add e2e/.work/id_ed25519`); otherwise it prints a skip message.
