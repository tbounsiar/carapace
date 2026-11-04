# Terminal

Open a terminal with **Terminal** on a host card, **New terminal** on the host page or in the host's sidebar menu, or the **+** at the end of the tab strip (new terminal on the host of the current tab). Carapace connects first if needed.

![A terminal tab](images/terminal-light.png)

All terminals and the file explorer of a host share one SSH connection, so opening another tab does not log in again. A host can have up to 32 terminals open at once.

The terminal is xterm-compatible (`TERM=xterm-256color`), resizes with the window and keeps 10,000 lines of scrollback. The font size is set in [Settings](settings.md) and applies to open terminals immediately.

## Tabs

Terminal, file and editor tabs of every host share one tab strip. Each tab shows the host name and a status dot; a warning icon means the connection was lost. When tabs do not fit, the extra ones go into a **More** menu. Right-click a tab (or Shift+F10) for its menu, which includes **Close other tabs** and closing the tabs of a host.

| Shortcut | Action |
| - | - |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+1 … Ctrl+8 | Go to tab 1 to 8 |
| Ctrl+9 | Go to the last tab |
| Ctrl+Shift+T | New terminal on the current host |
| Ctrl+Shift+W | Close the current tab |
| Ctrl+W | Close the current tab, except in a terminal, where the shell receives it |

These use Ctrl on macOS too. Other combinations, such as Ctrl+C, Ctrl+R or Ctrl+K inside a terminal, go to the shell.

## When a terminal ends

A banner explains why: **The shell exited.**, **The terminal was closed.** or **The connection was lost.** Choose **Reopen** to start a new shell in the same tab; the previous output stays above it. If the connection was lost, Reopen connects again.

**Disconnect** on a host closes its terminals, its file explorer and its running transfers.
