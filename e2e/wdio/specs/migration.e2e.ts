import { existsSync, readFileSync } from 'node:fs';
import { homeFile, readData, readSettings } from '../helpers/app-files';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  connect,
  saveConsentDefaults,
  enterProject,
  goHome,
  openGlobalVariables,
  openProjectVariables,
  textOf,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

// The app home was seeded with the v2 backend fixture (plus an `sshd` host in Website) by the
// `beforeSession` hook of wdio.conf.ts, before the app started.
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const values = (prefix: string) =>
  browser.execute(
    (p: string) =>
      [...document.querySelectorAll<HTMLInputElement>(`[data-testid^="${p}"]`)].map((i) => i.value),
    prefix,
  );

const rootHosts = () =>
  browser.execute(() =>
    [...document.querySelectorAll('app-sidebar-tree [data-testid^="tree-host-"]')]
      .filter((el) => !el.closest('tui-expand'))
      .map((el) => el.getAttribute('data-testid')?.replace('tree-host-', '')),
  );

describe('migration from a v2 config', () => {
  // An upgraded config has no analytics decision yet: the consent dialog is shown once.
  before(async () => {
    await waitForApp();
    await saveConsentDefaults();
  });

  it('splits the file into data.json (v3, no environments) and settings.toml, keeping a v2 backup', () => {
    const backup = homeFile('config.json.v2.bak');
    expect(existsSync(backup)).toBe(true);
    const original = JSON.parse(readFileSync(backup, 'utf8'));
    expect(original.version).toBe(2);
    expect(original.projects[0].environments.length).toBe(2);
    expect(existsSync(homeFile('config.json'))).toBe(false);
    expect(existsSync(homeFile('config.json.v4.bak'))).toBe(false);
    // The consent saved in `before` went to the settings file, not to the data file.
    expect(readSettings()?.['analytics']).toEqual({
      launch: { consent: 'granted', version: 3 },
      features: { consent: 'granted', version: 3 },
      connections: { consent: 'granted', version: 3 },
      crashes: { consent: 'granted', version: 3 },
    });
    const migrated = readData();
    expect(Object.keys(migrated).sort()).toEqual([
      'keys',
      'nodes',
      'projects',
      'variables',
      'version',
    ]);
    expect(migrated.version).toBe(3);
    expect(migrated.nodes.every((n: { kind: string }) => n.kind === 'host')).toBe(true);
    expect(migrated.nodes.length).toBe(6);
    for (const project of migrated.projects) {
      expect(Object.keys(project)).not.toContain('environments');
      expect(Object.keys(project)).not.toContain('activeEnvironmentId');
    }
    const vars = (name: string) =>
      migrated.projects.find((p: { name: string }) => p.name === name).variables;
    // Payments: the active `prod` environment is flattened in, `dev` (host, port) is dropped.
    expect(vars('Payments')).toEqual(
      expect.arrayContaining([
        { name: 'domain', kind: 'plain', value: 'pay.example.com' },
        { name: 'db_password', kind: 'secret', value: null },
        { name: 'host', kind: 'plain', value: 'prod.pay.example.com' },
        { name: 'prod_pass', kind: 'secret', value: null },
      ]),
    );
    expect(vars('Payments').length).toBe(4);
    // No active environment: the project variables are unchanged.
    expect(vars('Website')).toEqual([]);
    expect(vars('Empty')).toEqual([]);
  });

  it('lists the projects at Home and nothing else', async () => {
    await goHome();
    for (const name of ['Payments', 'Website', 'Empty'])
      await byId(`tree-project-${name}`).waitForExist({ timeout: 10000 });
    await expect($('app-sidebar-tree [data-testid^="tree-collection-"]')).not.toExist();
    await shot('migr-01-home');
  });

  it('keeps the hosts at the project root, with no environment selector', async () => {
    await enterProject('Payments');
    await browser.waitUntil(async () => (await rootHosts()).length === 3, {
      timeout: 10000,
      timeoutMsg: 'Payments does not show its three hosts at the root',
    });
    expect((await rootHosts()).sort()).toEqual(['api', 'bastion', 'db']);
    await expect(byId('env-select')).not.toExist();
    await byId('project-tab-variables').waitForDisplayed({ timeout: 10000 });
    await shot('migr-02-payments');
  });

  it('resolves a host as the active environment did', async () => {
    // `prod` defined `host` but no `port`, so only `port` was missing before the migration too.
    await clickId('open-host-api');
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await browser.waitUntil(
      async () => (await textOf('host-detail-address')) === 'Missing variables: port',
      {
        timeout: 10000,
        timeoutMsg: 'api does not resolve as with the prod environment',
      },
    );
  });

  it('shows the active environment variables as project variables', async () => {
    await openProjectVariables('Payments');
    await browser.waitUntil(
      async () => (await values('var-name-')).sort().join() === 'db_password,domain,host,prod_pass',
      {
        timeout: 10000,
        timeoutMsg: 'the project variables are not the project ones plus the prod ones',
      },
    );
    const plain = await values('var-value-');
    expect(plain).toContain('pay.example.com');
    expect(plain).toContain('prod.pay.example.com');
    expect(plain).not.toContain('dev.pay.example.com');
    expect(plain).not.toContain('2222');
    const names = await values('var-name-');
    const secret = names.indexOf('prod_pass');
    await expect(byId(`var-status-${secret}`)).toHaveAttribute('aria-label', 'Not set');
    await openGlobalVariables();
    await browser.waitUntil(
      async () => (await values('var-name-')).join() === 'user,vault_token,empty',
      { timeout: 10000, timeoutMsg: 'the global variables were not kept' },
    );
    await shot('migr-03-variables');
  });

  it('connects a migrated host', async () => {
    await enterProject('Website');
    await byId('tree-host-sshd').waitForExist({ timeout: 10000 });
    await connect('sshd');
    await browser.waitUntil(
      async () => {
        if (await byId('host-key-accept').isExisting()) {
          await clickId('host-key-accept');
          await waitGone('host-key-accept');
        }
        return (await byId('status-host-sshd').getAttribute('aria-label')) === 'Connected';
      },
      { timeout: 30000, timeoutMsg: 'the migrated host did not connect' },
    );
    await waitStatus('sshd', 'Connected');
  });
});
