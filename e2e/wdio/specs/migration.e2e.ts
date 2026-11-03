import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  connect,
  enterProject,
  envLabel,
  goHome,
  openGlobalVariables,
  openProjectVariables,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

// The app home was seeded with the v2 backend fixture (plus an `sshd` host in Website) by the
// `beforeSession` hook of wdio.conf.ts, before the app started.
const home = () => process.env['E2E_CARAPACE_HOME'] ?? '';
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
  before(waitForApp);

  it('rewrites the file as v3 and keeps the v2 backup', () => {
    const backup = join(home(), 'config.json.v2.bak');
    expect(existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(backup, 'utf8')).version).toBe(2);
    const migrated = JSON.parse(readFileSync(join(home(), 'config.json'), 'utf8'));
    expect(migrated.version).toBe(3);
    expect(migrated.nodes.every((n: { kind: string }) => n.kind === 'host')).toBe(true);
  });

  it('lists the projects at Home and nothing else', async () => {
    await goHome();
    for (const name of ['Payments', 'Website', 'Empty'])
      await byId(`tree-project-${name}`).waitForExist({ timeout: 10000 });
    await expect($('app-sidebar-tree [data-testid^="tree-collection-"]')).not.toExist();
    await shot('migr-01-home');
  });

  it('keeps the hosts at the project root with the active environment', async () => {
    await enterProject('Payments');
    await browser.waitUntil(async () => (await rootHosts()).length === 3, {
      timeout: 10000,
      timeoutMsg: 'Payments does not show its three hosts at the root',
    });
    expect((await rootHosts()).sort()).toEqual(['api', 'bastion', 'db']);
    expect(await envLabel()).toBe('prod');
    await expect(byId('env-select-kind')).toHaveText('prod');
    await shot('migr-02-payments');
  });

  it('keeps the project, environment and global variables', async () => {
    await openProjectVariables('Payments');
    await byId('vars-scope-env-dev').waitForExist({ timeout: 10000 });
    await byId('vars-scope-env-prod').waitForExist({ timeout: 10000 });
    expect(await values('var-name-')).toEqual(['domain', 'db_password']);
    await clickId('vars-scope-env-dev');
    await browser.waitUntil(async () => (await values('var-name-')).join() === 'host,port', {
      timeout: 5000,
    });
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
    expect(await envLabel()).toBe('No environment');
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
