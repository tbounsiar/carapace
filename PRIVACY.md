# Privacy

Carapace is an SSH client: it handles your servers, credentials and files. It keeps all of that on your machine. The only thing it can send is anonymous usage data, which you control category by category.

## Your data stays local

- Hosts, projects, collections, variables and key paths are stored in `config.json` under `~/.carapace` (or `$CARAPACE_HOME`).
- Passwords and passphrases are stored in your operating system's keychain.
- Accepted host keys are stored in `~/.carapace/known_hosts`.
- Carapace has no account and no server of its own. Your SSH connections go directly from your machine to your servers.

## Anonymous usage data

Carapace can send anonymous usage data in three categories, each with its own switch. On first launch, Carapace shows what each category sends, and nothing is sent before you save your choices. You can change each category at any time in **Settings > Privacy**, where **View recent events** shows the events of the current session with every detail they carry.

| Category               | Default | What it is for                                                         |
| ---------------------- | ------- | ---------------------------------------------------------------------- |
| **Launch count**       | On      | Counting how many people use Carapace, on which versions and platforms |
| **Feature usage**      | On      | Knowing which features are used                                        |
| **Connection results** | On      | Knowing which connection errors are most common                        |

All three categories are on by default. They are used only to produce anonymous statistics for this project: how many people use Carapace, which features are used and which connection problems are most common. You can turn any of them off in the first-launch question, before anything is sent, or in Settings at any time.

If the `DO_NOT_TRACK` environment variable is set to any value other than empty, `0` or `false`, nothing is sent and the question is not shown.

### Where it goes

Events are sent over HTTPS to [Aptabase](https://aptabase.com), a privacy-focused analytics service, hosted in the European Union. Aptabase does not use cookies or device fingerprinting. Carapace creates no install ID: each launch uses a new random session ID kept in memory only, so two launches cannot be linked to each other.

Like any web request, sending an event reveals your computer's public IP address to Aptabase. Aptabase derives the country and region from it. According to the [Aptabase privacy policy](https://aptabase.com/legal/privacy), the IP address and the request's user agent are processed in memory only, never stored, and only used in a keyed hash that yields a pseudonymous daily identifier. Aptabase keeps the anonymous events for up to 5 years.

Only official release builds send events. Development builds and forks never send anything.

### What is sent

With every event: the Carapace version (also as an SDK version such as `carapace@0.1.0`), the operating system name and version (for example `Windows 10.0.26100`), the system locale (for example `fr-FR`), the session ID and the time of the event.

| Event               | Category           | When                                        | Details                                                                                                   |
| ------------------- | ------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `session_started`   | Launch count       | Once per launch                             | None                                                                                                      |
| `app_started`       | Feature usage      | Once per launch                             | Theme (`system`, `light` or `dark`); number of hosts, projects and keys as a range                        |
| `host_created`      | Feature usage      | A host is saved for the first time          | Authentication type (`password`, `key` or `agent`)                                                        |
| `terminal_opened`   | Feature usage      | A terminal tab opens                        | None                                                                                                      |
| `files_opened`      | Feature usage      | The remote file pane opens for a connection | None                                                                                                      |
| `transfer_finished` | Feature usage      | A transfer ends                             | Direction (`upload` or `download`); outcome (`done`, `failed` or `cancelled`); number of files as a range |
| `key_generated`     | Feature usage      | A key is generated                          | Key type (`ed25519` or `rsa4096`); whether a custom folder was used                                       |
| `key_imported`      | Feature usage      | A key is imported                           | Key type (`ed25519`, `rsa`, `ecdsa` or `other`)                                                           |
| `variables_saved`   | Feature usage      | Variables are saved                         | Scope (`global` or `project`); number of variables as a range                                             |
| `connect_succeeded` | Connection results | A connection opens                          | Authentication type; time to connect as a range (`<1s`, `1-3s`, `3-10s`, `10s+`)                          |
| `connect_failed`    | Connection results | A connection attempt fails                  | Authentication type; error code (for example `auth_failed` or `timeout`)                                  |
| `host_test_run`     | Connection results | A connection test ends                      | Result (`success`, `failure` or `cancelled`); error code on failure                                       |

Numbers are only sent as ranges: `0`, `1`, `2-5`, `6-20`, `21-50`, `51+` for hosts, projects, keys and variables; `1`, `2-10`, `11-100`, `101+` for files.

When you turn a category off, its events still waiting to be sent are discarded. A request already on its way at that moment (at most 25 events) may still complete.

### What is never sent

- The hostnames, IP addresses or ports of your servers, and your usernames
- Passwords, passphrases, private keys, fingerprints or key comments
- File, folder or path names, and file contents
- Names of hosts, projects, collections, keys or variables, and variable values
- Terminal input or output
- Error messages or any other free text
- Exact counts or sizes
- Anything before you saved your choices on first launch, anything from a category you turned off, and the fact that you turned a category off

### Changes

If a future version needs to send a new kind of data, this page is updated and Carapace asks again about the category that changed.

## Contact

Questions about privacy: open an issue on [GitHub](https://github.com/tbounsiar/carapace/issues). For security issues, see [SECURITY.md](SECURITY.md).
