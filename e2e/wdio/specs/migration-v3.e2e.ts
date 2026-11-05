import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  connect,
  saveConsentDefaults,
  enterProject,
  openGlobalVariables,
  openProjectVariables,
  textOf,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

// The app home was seeded with a v3 config still holding environment fields by the
// `beforeSession` hook of wdio.conf.ts, before the app started.
const home = () => process.env['E2E_CARAPACE_HOME'] ?? '';
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const values = (prefix: string) =>
  browser.execute(
    (p: string) =>
      [...document.querySelectorAll<HTMLInputElement>(`[data-testid^="${p}"]`)].map((i) => i.value),
    prefix,
  );

describe('v3 config with leftover environments', () => {
  // An upgraded config has no analytics decision yet: the consent dialog is shown once.
  before(async () => {
    await waitForApp();
    await saveConsentDefaults();
  });

  it('rewrites the file without the environment fields', () => {
    const config = JSON.parse(readFileSync(join(home(), 'config.json'), 'utf8'));
    expect(config.version).toBe(3);
    expect(Object.keys(config.projects[0])).not.toContain('environments');
    expect(Object.keys(config.projects[0])).not.toContain('activeEnvironmentId');
    expect(config.projects[0].variables).toEqual([{ name: 'port', kind: 'plain', value: '2223' }]);
    expect(config.nodes.map((n: { name: string }) => n.name)).toEqual(['Servers', 'sshd']);
    expect(readdirSync(home()).filter((f) => f.endsWith('.bak'))).toEqual([]);
    expect(existsSync(join(home(), 'config.json.v2.bak'))).toBe(false);
  });

  it('keeps the project and global variables', async () => {
    await openProjectVariables('Legacy');
    await browser.waitUntil(async () => (await values('var-name-')).join() === 'port', {
      timeout: 10000,
      timeoutMsg: 'the project variables were not kept',
    });
    expect(await values('var-value-')).toEqual(['2223']);
    await openGlobalVariables();
    await browser.waitUntil(async () => (await values('var-name-')).join() === 'user', {
      timeout: 10000,
      timeoutMsg: 'the global variables were not kept',
    });
  });

  it('connects the host with the project value', async () => {
    await enterProject('Legacy');
    await expect(byId('env-select')).not.toExist();
    const head = byId('tree-collection-Servers');
    await head.waitForExist({ timeout: 10000 });
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    await byId('open-host-sshd').waitForDisplayed({ timeout: 10000 });
    await clickId('open-host-sshd');
    await browser.waitUntil(
      async () => (await textOf('host-detail-address')) === 'carapace@127.0.0.1:2223',
      { timeout: 10000, timeoutMsg: 'the host did not resolve with the project port' },
    );
    await connect('sshd');
    await browser.waitUntil(
      async () => {
        if (await byId('host-key-accept').isExisting()) {
          await clickId('host-key-accept');
          await waitGone('host-key-accept');
        }
        return (await byId('status-host-sshd').getAttribute('aria-label')) === 'Connected';
      },
      { timeout: 30000, timeoutMsg: 'the host did not connect' },
    );
    await waitStatus('sshd', 'Connected');
    await shot('migr-04-v3-leftover-connected');
  });
});
