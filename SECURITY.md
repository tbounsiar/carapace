# Security policy

Carapace handles SSH credentials, host keys and private keys, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: **Security** tab of this repository, then **Report a vulnerability**. Include the version, your OS, steps to reproduce and the impact you expect.

You should get a first answer within a week. Once a fix is released, the advisory is published with credit to the reporter unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Scope

In scope, for example:

- a secret (password, passphrase, private key) written in clear text to disk, logs, error messages or sent to the interface;
- a host key accepted without the user's decision, or a changed key not reported;
- private keys created with permissions readable by other users;
- a way for remote content (server output, file names) to run code in the app or reach the backend commands.

Out of scope: issues that require an attacker who already controls your user account, and the known limitations listed in the README.
