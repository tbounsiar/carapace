import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');

export const PROJECT = 'E2E Project';
export const HOST = {
  name: 'sshd',
  hostname: '127.0.0.1',
  port: '2223',
  username: 'carapace',
  keyPath: resolve(root, 'e2e', '.work', 'id_ed25519'),
};

/**
 * Stands in for the external editor app (Custom app): a program that exits at once whatever its
 * argument. `whoami.exe` only prints an "invalid argument" error for the file path; it reads and
 * changes nothing. The spec edits the local copy itself to simulate a save.
 */
export const NOOP_EDITOR = resolve(
  process.env['SystemRoot'] ?? 'C:/Windows',
  'System32',
  'whoami.exe',
);

export function rotateHostKey(): void {
  execFileSync(process.execPath, [resolve(root, 'e2e', 'sshd', 'setup.mjs'), 'rotate-host-key'], {
    stdio: 'inherit',
  });
}

/**
 * Seeded for the DO_NOT_TRACK spec: launch and feature usage granted, connections never
 * answered, so without the variable the app would send events and ask for connections.
 */
export const DNT_ANALYTICS = {
  categories: {
    launch: { consent: 'granted', version: 2 },
    features: { consent: 'granted', version: 2 },
  },
};
