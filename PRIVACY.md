# Privacy

Carapace is an SSH client: it handles your servers, credentials and files. It keeps all of that on your machine. The only thing it can send is anonymous usage data, and only if you agree.

## Your data stays local

- Hosts, projects, collections, variables and key paths are stored in `config.json` under `~/.carapace` (or `$CARAPACE_HOME`).
- Passwords and passphrases are stored in your operating system's keychain.
- Accepted host keys are stored in `~/.carapace/known_hosts`.
- Carapace has no account and no server of its own. Your SSH connections go directly from your machine to your servers.

## Anonymous usage data (opt-in)

On first launch, Carapace asks whether you want to share anonymous usage data. Nothing is sent until you choose **Share usage data**. Closing the question or choosing **Don't share** means no, and you are not asked again. You can change your answer at any time in **Settings > Privacy**, where **View recent events** shows the events of the current session with every detail they carry.

Usage data helps decide what to improve: which features are used, which connection errors are most common, which platforms to support.

### Where it goes

Events are sent over HTTPS to [Aptabase](https://aptabase.com), a privacy-focused analytics service, hosted in the European Union. Aptabase does not use cookies or device fingerprinting. Carapace creates no install ID: each launch uses a new random session ID kept in memory only, so two launches cannot be linked to each other.

Like any web request, sending an event reveals your computer's public IP address to Aptabase. According to the [Aptabase privacy policy](https://aptabase.com/legal/privacy), the IP address and the request's user agent are processed in memory only, never stored, and only used in a keyed hash that yields a pseudonymous identifier.

Only official release builds send events. Development builds and forks never send anything.

### What is sent

With every event: the Carapace version (also as an SDK version such as `carapace@0.2.0`), the operating system name and version (for example `Windows 10.0.26100`), the system locale (for example `fr-FR`), the session ID and the time of the event.

| Event               | When                                        | Details                                                                                                   |
| ------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `app_started`       | Once per launch                             | Theme (`system`, `light` or `dark`); number of hosts, projects and keys as a range                        |
| `consent_granted`   | You turn analytics on                       | None                                                                                                      |
| `host_created`      | A host is saved for the first time          | Authentication type (`password`, `key` or `agent`)                                                        |
| `connect_succeeded` | A connection opens                          | Authentication type; time to connect as a range (`<1s`, `1-3s`, `3-10s`, `10s+`)                          |
| `connect_failed`    | A connection attempt fails                  | Authentication type; error code (for example `auth_failed` or `timeout`)                                  |
| `host_test_run`     | A connection test ends                      | Result (`success`, `failure` or `cancelled`); error code on failure                                       |
| `terminal_opened`   | A terminal tab opens                        | None                                                                                                      |
| `files_opened`      | The remote file pane opens for a connection | None                                                                                                      |
| `transfer_finished` | A transfer ends                             | Direction (`upload` or `download`); outcome (`done`, `failed` or `cancelled`); number of files as a range |
| `key_generated`     | A key is generated                          | Key type (`ed25519` or `rsa4096`); whether a custom folder was used                                       |
| `key_imported`      | A key is imported                           | Key type (`ed25519`, `rsa`, `ecdsa` or `other`)                                                           |
| `variables_saved`   | Variables are saved                         | Scope (`global` or `project`); number of variables as a range                                             |

Numbers are only sent as ranges: `0`, `1`, `2-5`, `6-20`, `21-50`, `51+` for hosts, projects, keys and variables; `1`, `2-10`, `11-100`, `101+` for files.

### What is never sent

- The hostnames, IP addresses or ports of your servers, and your usernames
- Passwords, passphrases, private keys, fingerprints or key comments
- File, folder or path names, and file contents
- Names of hosts, projects, collections, keys or variables, and variable values
- Terminal input or output
- Error messages or any other free text
- Exact counts or sizes
- Anything at all when you have not agreed, including the fact that you said no

### Changes

If a future version needs to send a new kind of data, this page is updated and Carapace asks again those who agreed before.

## Contact

Questions about privacy: open an issue on [GitHub](https://github.com/tbounsiar/carapace/issues). For security issues, see [SECURITY.md](SECURITY.md).
