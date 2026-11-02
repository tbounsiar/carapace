# End-to-end UI tests

WebdriverIO drives the real desktop app through `tauri-driver` and `msedgedriver` (WebView2).

## Prerequisites

- `tauri-driver` and `msedgedriver` on the cargo bin directory (or `PATH`).
- `msedgedriver` major version must equal the installed WebView2 runtime major. Check both:
  `msedgedriver --version` and the `pv` value of
  `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`.
  Use `msedgedriver-tool` (see the Tauri WebDriver docs) to fetch the matching driver from Microsoft.

## Run

```
npm run e2e:build   # debug binary, no bundle
npm run e2e:ui      # runs e2e/wdio/specs/*.e2e.ts
```

The binary embeds the frontend, so rerun `e2e:build` after any change in `src/` or `src-tauri/`.

Each session starts with an empty temporary `CARAPACE_HOME`, so the real `~/.carapace` is never touched.
Screenshots are written to `e2e/.work/screenshots/` (git-ignored).
