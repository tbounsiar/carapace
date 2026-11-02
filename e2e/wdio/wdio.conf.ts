import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

  beforeSession: emptyHome,
  afterSession: emptyHome,

  onComplete: () => {
    driver?.kill();
    const home = homeDir();
    if (home) rmSync(home, { recursive: true, force: true });
  },
};
