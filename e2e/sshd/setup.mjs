#!/usr/bin/env node
// Usage: node e2e/sshd/setup.mjs <up|down|rotate-host-key>
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, '..', '.work');
const compose = ['compose', '-f', join(here, 'compose.yaml'), '--env-file', join(work, 'sshd.env')];
const PORT = 2222;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

function genKey(name, type, extra) {
  const path = join(work, name);
  rmSync(path, { force: true });
  rmSync(`${path}.pub`, { force: true });
  run('ssh-keygen', [
    '-q',
    '-t',
    type,
    ...extra,
    '-N',
    '',
    '-C',
    `carapace-e2e-${name}`,
    '-f',
    path,
  ]);
}

function provision() {
  mkdirSync(work, { recursive: true });
  genKey('id_ed25519', 'ed25519', []);
  genKey('id_rsa', 'rsa', ['-b', '4096']);
  genKey('id_wrong', 'ed25519', []);
  const keys = ['id_ed25519', 'id_rsa'].map((n) =>
    readFileSync(join(work, `${n}.pub`), 'utf8').trim(),
  );
  writeFileSync(join(work, 'authorized_keys'), keys.join('\n') + '\n');
  writeFileSync(join(work, 'password'), randomBytes(18).toString('base64url'));
  writeFileSync(
    join(work, 'sshd.env'),
    `CARAPACE_PASSWORD=${readFileSync(join(work, 'password'), 'utf8')}\n`,
  );
}

function probe() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    let banner = false;
    s.setTimeout(1000, () => s.destroy());
    s.on('data', (d) => {
      banner = d.toString().startsWith('SSH-');
      s.destroy();
    });
    s.on('close', () => resolve(banner));
    s.on('error', () => {});
  });
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('sshd did not become ready on 127.0.0.1:' + PORT);
}

const action = process.argv[2];
if (action === 'up') {
  provision();
  run('docker', [...compose, 'up', '-d', '--build', '--force-recreate']);
  await waitReady();
  console.log(`sshd ready on 127.0.0.1:${PORT}, work dir ${work}`);
} else if (action === 'rotate-host-key') {
  if (!existsSync(join(work, 'sshd.env'))) throw new Error('run "up" first');
  run('docker', [...compose, 'exec', '-T', 'sshd', 'sh', '-c', 'rm -f /etc/ssh/ssh_host_*']);
  run('docker', [...compose, 'restart', 'sshd']);
  await waitReady();
  console.log('host keys regenerated');
} else if (action === 'down') {
  if (existsSync(join(work, 'sshd.env'))) run('docker', [...compose, 'down', '-v']);
} else {
  console.error('usage: setup.mjs <up|down|rotate-host-key>');
  process.exit(2);
}
