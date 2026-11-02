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

export function rotateHostKey(): void {
  execFileSync(process.execPath, [resolve(root, 'e2e', 'sshd', 'setup.mjs'), 'rotate-host-key'], {
    stdio: 'inherit',
  });
}
