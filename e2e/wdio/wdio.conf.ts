import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { application, waitAppExited } from './helpers/app-process';
import { DNT_ANALYTICS, NOOP_EDITOR } from './helpers/fixture';

const root = resolve(__dirname, '..', '..');
const driverBin = join(
  process.env['CARGO_HOME'] ?? join(homedir(), '.cargo'),
  'bin',
  'tauri-driver.exe',
);
// Created by `npm run e2e:driver`; must match the installed WebView2 version.
const nativeDriver = resolve(root, 'e2e', '.work', 'driver', 'msedgedriver.exe');

let driver: ChildProcess | undefined;
let dntDriver: ChildProcess | undefined;
const homeDir = () => process.env['E2E_CARAPACE_HOME'] ?? '';

/**
 * Killing tauri-driver alone leaves its msedgedriver running on the native port, and the next
 * run's driver then fails to bind it (every session fails). Ends the tree of this run's drivers.
 */
function stopDriver(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    child.kill();
  }
}

function emptyHome(): void {
  const home = homeDir();
  if (!home) return;
  for (const entry of readdirSync(home))
    rmSync(join(home, entry), { recursive: true, force: true });
}

/** Every analytics category refused for the current catalogue (2): no consent dialog. */
const DECLINED_ANALYTICS = {
  categories: Object.fromEntries(
    ['launch', 'features', 'connections'].map((c) => [c, { consent: 'denied', version: 2 }]),
  ),
};

/**
 * The DO_NOT_TRACK spec runs on its own tauri-driver, started with that variable set, and its
 * own app home, so no file of another spec can reach it.
 */
const DNT_SPEC = resolve(__dirname, 'specs', 'analytics-dnt.e2e.ts');
const DNT_PORT = 4446;
const isDntSpec = (specs: string[]) => specs.some((spec) => spec.includes('analytics-dnt'));

/** Both drivers and their msedgedriver (native) ports. */
const DRIVER_PORTS = [4444, 4445, DNT_PORT, DNT_PORT + 1];

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer()
      .once('error', () => done(false))
      .once('listening', () => server.close(() => done(true)))
      .listen(port, '127.0.0.1');
  });
}

/**
 * A driver already on these ports (another e2e run, or one left by a killed run) would serve
 * this run's sessions with its own app home, and its teardown would kill this run's apps; the
 * new driver only logs its bind error. Refuse to start instead. Exits: wdio logs an error thrown
 * by `onPrepare` and goes on (its SevereServiceError check is an `instanceof` across two module
 * copies of webdriverio), and nothing has started yet.
 */
async function assertDriverPortsFree(): Promise<void> {
  for (const port of DRIVER_PORTS)
    if (!(await portFree(port))) {
      console.error(
        `Port ${port} is in use: another e2e run or a leftover tauri-driver/msedgedriver is running`,
      );
      process.exit(1);
    }
}

/**
 * Specs that do not test analytics start with every category denied, so the first-launch
 * consent dialog never covers them. Every other field defaults when missing.
 */
function seedDeclinedConfig(): void {
  const home = homeDir();
  if (!home) return;
  const config = { version: 3, analytics: DECLINED_ANALYTICS };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
}

function seedDoNotTrackConfig(): void {
  const home = homeDir();
  if (!home) return;
  const config = { version: 3, analytics: DNT_ANALYTICS };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
}

/** Consent denied, and the external editor set to the no-op program; the notice still shows. */
function seedExternalEditorConfig(): void {
  const home = homeDir();
  if (!home) return;
  const config = {
    version: 3,
    analytics: DECLINED_ANALYTICS,
    externalEditor: { mode: 'custom', appPath: NOOP_EDITOR, noticeSeen: false },
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
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
  // One app at a time across both capabilities: every instance of the e2e binary shares one
  // WebView2 profile, and `beforeSession` waits for any running instance.
  maxInstances: 1,
  maxInstancesPerCapability: 1,
  hostname: '127.0.0.1',
  port: 4444,
  capabilities: [
    {
      browserName: 'wry',
      'tauri:options': { application },
      'wdio:exclude': [DNT_SPEC],
    } as WebdriverIO.Capabilities,
    {
      browserName: 'wry',
      'tauri:options': { application },
      'wdio:specs': [DNT_SPEC],
      // `wdio:specs` does not filter a `--spec` given on the command line; `wdio:exclude` does.
      'wdio:exclude': readdirSync(resolve(__dirname, 'specs'))
        .map((name) => resolve(__dirname, 'specs', name))
        .filter((spec) => spec !== DNT_SPEC),
      port: DNT_PORT,
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
    await assertDriverPortsFree();
    const home = mkdtempSync(join(tmpdir(), 'carapace-e2e-'));
    const dntHome = mkdtempSync(join(tmpdir(), 'carapace-e2e-dnt-'));
    process.env['E2E_CARAPACE_HOME'] = home;
    process.env['E2E_DNT_HOME'] = dntHome;
    const bin = existsSync(driverBin) ? driverBin : 'tauri-driver';
    // The app inherits the driver's environment, fixed at spawn: a DO_NOT_TRACK of the user's
    // shell must not switch analytics off in every spec.
    const env: NodeJS.ProcessEnv = { ...process.env, CARAPACE_HOME: home };
    delete env['DO_NOT_TRACK'];
    driver = spawn(bin, ['--native-driver', nativeDriver], {
      stdio: [null, process.stdout, process.stderr],
      env,
    });
    dntDriver = spawn(
      bin,
      [
        '--port',
        String(DNT_PORT),
        '--native-port',
        String(DNT_PORT + 1),
        '--native-driver',
        nativeDriver,
      ],
      {
        stdio: [null, process.stdout, process.stderr],
        env: { ...env, CARAPACE_HOME: dntHome, DO_NOT_TRACK: '1' },
      },
    );
    await new Promise((r) => setTimeout(r, 1500));
  },

  afterTest: async (test, _context, { passed }) => {
    if (passed) return;
    const { screenshot } = await import('./helpers/screenshot');
    const name = `FAIL-${test.parent}-${test.title}`.replace(/[^\w-]+/g, '_');
    console.log('failure screenshot', await screenshot(name));
  },

  beforeSession: async (_config, _capabilities, specs) => {
    // Worker-local: the hooks and the spec of this worker then use the DNT driver's app home.
    if (isDntSpec(specs)) process.env['E2E_CARAPACE_HOME'] = process.env['E2E_DNT_HOME'];
    await waitAppExited();
    emptyHome();
    if (isDntSpec(specs)) seedDoNotTrackConfig();
    else if (specs.some((spec) => spec.includes('migration-v3'))) seedV3ConfigWithEnvironments();
    else if (specs.some((spec) => spec.includes('migration'))) seedV2Config();
    else if (specs.some((spec) => spec.includes('external-editor'))) seedExternalEditorConfig();
    else if (!specs.some((spec) => spec.includes('analytics'))) seedDeclinedConfig();
  },
  afterSession: emptyHome,

  onComplete: () => {
    for (const child of [driver, dntDriver]) stopDriver(child);
    for (const home of [process.env['E2E_CARAPACE_HOME'], process.env['E2E_DNT_HOME']])
      if (home) rmSync(home, { recursive: true, force: true });
  },
};
