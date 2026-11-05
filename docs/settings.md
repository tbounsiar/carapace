# Settings

Open **Settings** at the bottom of the sidebar. Changes apply right away; there is no Save button.

![The Settings page](images/settings-light.png)

## Theme

**System** (default) follows the light or dark setting of the operating system; **Light** and **Dark** force one. The sun / moon / monitor button in the header switches the theme too.

## Default key type

**Ed25519** (default) or **RSA 4096**: the type preselected when you [generate a key](ssh-keys.md#generate-a-key). You can still change it in the dialog.

## Terminal font size

From 10 to 24 px, 13 px by default. Open terminals update immediately.

## External editor

How [Open in external editor](external-editor.md) opens files:

- **System default**: the app your system uses for the file's type. Files the system would run (scripts, programs) are refused.
- **Custom app**: choose the editor's program file with **Browse…**. The file to edit is passed as its only argument, and any file type can be opened. Shells, terminals, script interpreters and generic openers are refused, because they would run the file instead of editing it. On macOS you can pick an `.app` bundle. **Clear** removes the choice; until an app is chosen, files open with the system default.

**Show a notice before opening a file outside Carapace** turns the first-use explanation back on or off.

## Privacy

Three switches control the anonymous usage data, one per category. All three are on by default:

- **Launch count**: one event when Carapace starts.
- **Feature usage**: which features you use, with setup sizes as ranges.
- **Connection results**: whether connections and connection tests succeed, with the error code.

Turn any of them off here at any time. The same switches are shown at first launch, before anything is sent; **Save choices** keeps them as shown. **View recent events** lists the events of the current session with everything they carry; **How analytics work** opens the privacy page. See [PRIVACY.md](../PRIVACY.md) for exactly what is and is never sent.

If the `DO_NOT_TRACK` environment variable is set (any value other than empty, `0` or `false`), the switches are off and disabled and nothing is sent.

Only official release builds can send usage data. Development builds and your own builds from source never do; the page says so ("This build does not send usage data").

## Where settings are stored

Theme, default key type and terminal font size are stored by the app's web view on this computer. The external editor choice and the usage data choices are stored in `config.json` in the [data folder](faq.md#where-is-my-data).
