import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const application = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'src-tauri',
  'target',
  'debug',
  'carapace.exe',
);

/** Running instances of the e2e binary only, never another Carapace install. */
export function appPids(): number[] {
  const script =
    'Get-Process carapace -ErrorAction SilentlyContinue | Where-Object Path -eq $env:E2E_APP | ForEach-Object Id; exit 0';
  const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, E2E_APP: application },
  }).toString();
  return out
    .split(/\s+/)
    .filter(Boolean)
    .map((pid) => Number(pid));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ending a session closes the app, but its process and WebView2 profile outlive the WebDriver
 * reply. A new app started meanwhile shares that profile and sometimes never renders, or the
 * driver drops the new-session connection.
 */
export async function waitAppExited(pids: number[] = appPids(), timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (pids.some(alive)) {
    if (Date.now() > deadline)
      throw new Error(`${application} is still running (pid ${pids.filter(alive).join(', ')})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Restarts the app: a new session, started once the previous app process has exited.
 * `whileStopped` runs in between, for files the running app could otherwise overwrite.
 */
export async function restartApp(whileStopped?: () => void): Promise<void> {
  const pids = appPids();
  await browser.deleteSession();
  await waitAppExited(pids);
  whileStopped?.();
  await browser.reloadSession();
}
