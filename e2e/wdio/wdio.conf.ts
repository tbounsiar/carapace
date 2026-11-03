import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');
const application = resolve(root, 'src-tauri', 'target', 'debug', 'carapace.exe');
const driverBin = join(
  process.env['CARGO_HOME'] ?? join(homedir(), '.cargo'),
  'bin',
  'tauri-driver.exe',
);
// Created by `npm run e2e:driver`; must match the installed WebView2 version.
const nativeDriver = resolve(root, 'e2e', '.work', 'driver', 'msedgedriver.exe');

let driver: ChildProcess | undefined;
const homeDir = () => process.env['E2E_CARAPACE_HOME'] ?? '';

function emptyHome(): void {
  const home = homeDir();
  if (!home) return;
  for (const entry of readdirSync(home))
    rmSync(join(home, entry), { recursive: true, force: true });
}

/** A v2 config (the backend fixture) plus a host reaching the e2e sshd, for the migration spec. */
function seedV2Config(): void {
  const home = homeDir();
  if (!home) return;
  const fixture = resolve(root, 'src-tauri', 'tests', 'fixtures', 'config-v2.json');
  const config = JSON.parse(readFileSync(fixture, 'utf8'));
  const website = config.projects.find((p: { name: string }) => p.name === 'Website');
  website.hosts.push({
    id: '0b6f2a52-6c1e-4c55-9d1e-3f1d2b7a9e01',
    name: 'sshd',
    hostname: '127.0.0.1',
    port: '2223',
    username: 'carapace',
    auth: { kind: 'key', keyPath: resolve(root, 'e2e', '.work', 'id_ed25519'), passphrase: null },
  });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
}

/**
 * A v3 config written while projects still had environments: the leftover fields must be
 * dropped on load. No environment is active, so the project variables stay as they are.
 */
function seedV3ConfigWithEnvironments(): void {
  const home = homeDir();
  if (!home) return;
  const projectId = 'c3a1f0d2-5b7e-4f61-9a0c-2d4e6f8a1b3c';
  const collectionId = 'e5b2c4d6-7f81-4a93-8b05-1c3e5a7b9d2f';
  const config = {
    version: 3,
    variables: [{ name: 'user', kind: 'plain', value: 'carapace' }],
    projects: [
      {
        id: projectId,
        name: 'Legacy',
        variables: [{ name: 'port', kind: 'plain', value: '2223' }],
        environments: [
          {
            id: 'a7d3e9f1-2b4c-4d6e-8f01-3a5c7e9b1d4f',
            name: 'dev',
            variables: [{ name: 'port', kind: 'plain', value: '1' }],
          },
        ],
        activeEnvironmentId: null,
      },
    ],
    nodes: [
      { kind: 'collection', id: collectionId, name: 'Servers', projectId, parentId: null },
      {
        kind: 'host',
        id: 'f1e2d3c4-b5a6-4978-8695-a4b3c2d1e0f9',
        name: 'sshd',
        projectId,
        parentId: collectionId,
        hostname: '127.0.0.1',
        port: '${port}',
        username: '${user}',
        auth: {
          kind: 'key',
          keyPath: resolve(root, 'e2e', '.work', 'id_ed25519'),
          passphrase: null,
        },
      },
    ],
    keys: [],
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [resolve(__dirname, 'specs', '**', '*.e2e.ts')],
  maxInstances: 1,
  hostname: '127.0.0.1',
  port: 4444,
  capabilities: [
    {
      browserName: 'wry',
      'tauri:options': { application },
    } as WebdriverIO.Capabilities,
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { timeout: 60000 },
  logLevel: 'warn',

  onPrepare: async () => {
    if (!existsSync(application))
      throw new Error(`Missing ${application}; run "npm run e2e:build"`);
    if (!existsSync(nativeDriver))
      throw new Error(`Missing ${nativeDriver}; run "npm run e2e:driver"`);
    const home = mkdtempSync(join(tmpdir(), 'carapace-e2e-'));
    process.env['E2E_CARAPACE_HOME'] = home;
    const bin = existsSync(driverBin) ? driverBin : 'tauri-driver';
    driver = spawn(bin, ['--native-driver', nativeDriver], {
      stdio: [null, process.stdout, process.stderr],
      env: { ...process.env, CARAPACE_HOME: home },
    });
    await new Promise((r) => setTimeout(r, 1500));
  },

  afterTest: async (test, _context, { passed }) => {
    if (passed) return;
    const { screenshot } = await import('./helpers/screenshot');
    const name = `FAIL-${test.parent}-${test.title}`.replace(/[^\w-]+/g, '_');
    console.log('failure screenshot', await screenshot(name));
  },

  beforeSession: (_config, _capabilities, specs) => {
    emptyHome();
    if (specs.some((spec) => spec.includes('migration-v3'))) seedV3ConfigWithEnvironments();
    else if (specs.some((spec) => spec.includes('migration'))) seedV2Config();
  },
  afterSession: emptyHome,

  onComplete: () => {
    driver?.kill();
    const home = homeDir();
    if (home) rmSync(home, { recursive: true, force: true });
  },
};
