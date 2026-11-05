import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { appHome, homeFile, readData, readSettings } from '../helpers/app-files';
import { NOOP_EDITOR } from '../helpers/fixture';
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

// The app home was seeded with a v3 `config.json` still holding environment fields by the
// `beforeSession` hook of wdio.conf.ts, before the app started.
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

  it('splits the file into data.json without the environment fields and settings.toml', () => {
    expect(existsSync(homeFile('config.json'))).toBe(false);
    const backup = JSON.parse(readFileSync(homeFile('config.json.v4.bak'), 'utf8'));
    expect(Object.keys(backup.projects[0])).toContain('environments');
    expect(backup.externalEditor).toEqual({
      mode: 'custom',
      appPath: NOOP_EDITOR,
      noticeSeen: true,
    });
    // Only the preferences the old file held move; the consent comes from `before`.
    const settings = readSettings();
    expect(settings?.['external_editor']).toEqual({
      mode: 'custom',
      app_path: NOOP_EDITOR,
      notice_seen: true,
    });
    for (const key of ['default_key_type', 'terminal_font_size', 'key_folder'])
      expect(Object.keys(settings ?? {})).not.toContain(key);
    const config = readData();
    expect(Object.keys(config)).not.toContain('externalEditor');
    expect(config.version).toBe(3);
    expect(Object.keys(config.projects[0])).not.toContain('environments');
    expect(Object.keys(config.projects[0])).not.toContain('activeEnvironmentId');
    expect(config.projects[0].variables).toEqual([{ name: 'port', kind: 'plain', value: '2223' }]);
    expect(config.nodes.map((n: { name: string }) => n.name)).toEqual(['Servers', 'sshd']);
    expect(readdirSync(appHome()).filter((f) => f.endsWith('.bak'))).toEqual([
      'config.json.v4.bak',
    ]);
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
