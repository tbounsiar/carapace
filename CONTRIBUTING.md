# Contributing

Thanks for your interest in Carapace. Bug reports, ideas and pull requests are welcome.

## Before you start

- For anything larger than a small fix, open an issue first to agree on the approach.
- Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

Prerequisites: Node 26, Rust (stable, 1.90 or later) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```
npm ci
npm run tauri dev
```

## Checks

Every pull request must pass the same checks as CI:

```
npx ng test --watch=false
npm run lint
npx prettier --check src e2e

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

End-to-end tests need Docker; see [e2e/README.md](e2e/README.md).

## Guidelines

- Keep changes small and focused, with tests for what they change.
- Frontend: Angular standalone components with signals, built from Taiga UI components. Components never call `invoke` directly; they go through the typed services in `src/app/core/ipc/`.
- Backend: Tauri commands stay thin (validate input, call a module, map errors). Each command has its own permission, granted only to the window that uses it.
- Security rules are not negotiable: no secret in clear text anywhere (files, logs, errors, messages to the interface), host key verification always on, generated private keys owner-only.
- Code, comments and commit messages are in English. Comments explain why, not what.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
