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
    if (specs.some((spec) => spec.includes('migration'))) seedV2Config();
  },
  afterSession: emptyHome,

  onComplete: () => {
    driver?.kill();
    const home = homeDir();
    if (home) rmSync(home, { recursive: true, force: true });
  },
};
