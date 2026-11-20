import { readSettings, type Toml } from '../helpers/app-files';
import { restartApp } from '../helpers/app-process';
import { screenshotThemes } from '../helpers/screenshot';
import { byId, clickId, textOf, tid, waitForApp } from '../helpers/ui';

// Runs without a release endpoint of its own: Check now reaches the real one, so the result is
// up to date, an offer or an inline error, whichever the network gives. The notice, download,
// restart decision and installer texts are covered by the unit specs.

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const autoCheckStored = () => (readSettings()?.['updates'] as Toml | undefined)?.['auto_check'];

const switchChecked = () =>
  browser.execute(
    (sel: string) => document.querySelector<HTMLInputElement>(sel)?.checked ?? null,
    tid('settings-updates-auto'),
  );

async function openUpdates(): Promise<void> {
  await clickId('settings');
  await byId('settings-title').waitForDisplayed({ timeout: 10000 });
  await byId('settings-updates').scrollIntoView({ block: 'start' });
  await browser.waitUntil(async () => (await byId('settings-updates-auto').isEnabled()) === true, {
    timeout: 10000,
    timeoutMsg: 'the automatic check switch never loaded',
  });
}

async function waitStored(value: boolean | undefined): Promise<void> {
  await browser.waitUntil(async () => autoCheckStored() === value, {
    timeout: 5000,
    timeoutMsg: `settings.toml never held updates.auto_check = ${value}: ${JSON.stringify(readSettings())}`,
  });
}

describe('in-app updates: Settings > Updates', () => {
  before(waitForApp);

  it('is the last section of Settings, with the version and the automatic check on', async () => {
    await openUpdates();
    const last = await browser.execute(
      () => document.querySelector('section.form')?.lastElementChild?.tagName.toLowerCase() ?? '',
    );
    expect(last).toBe('app-update-settings');
    expect(await textOf('settings-updates-version')).toMatch(/^Carapace \d+\.\d+\.\d+/);
    expect(await byId('settings-updates-notes').isDisplayed()).toBe(true);
    expect(await switchChecked()).toBe(true);
    expect(await byId('settings-updates-auto').getAttribute('aria-describedby')).toBe(
      'settings-updates-auto-note',
    );
    expect(await byId('settings-update-badge').isExisting()).toBe(false);
  });

  it('turning the automatic check off is saved at once and survives a restart', async () => {
    await clickId('settings-updates-auto');
    await waitStored(false);
    await restartApp();
    await waitForApp();
    await openUpdates();
    expect(await switchChecked()).toBe(false);
  });

  it('turning it back on stores it', async () => {
    await clickId('settings-updates-auto');
    await waitStored(true);
    expect(await switchChecked()).toBe(true);
  });

  it('Check now ends in up to date, an offer or an inline check error', async () => {
    await clickId('settings-updates-check');
    await browser.waitUntil(
      async () =>
        (await byId('settings-updates-status').getAttribute('data-state')) !== 'checking' &&
        (await byId('settings-updates-check').getAttribute('aria-busy')) !== 'true',
      { timeout: 30000, timeoutMsg: 'Check now never finished' },
    );
    const status = await byId('settings-updates-status').getAttribute('data-state');
    if (status === 'upToDate') {
      expect(await textOf('settings-updates-status')).toContain('Carapace is up to date.');
      expect(await textOf('settings-updates-last-checked')).toMatch(/^Last checked: /);
      await shot('settings-updates-uptodate');
    } else if (await byId('settings-updates-error').isExisting()) {
      expect(await byId('settings-updates-error').getAttribute('data-kind')).toBe('check');
      expect(await textOf('settings-updates-error')).toContain('Could not check for updates');
      // A manual check failure is inline only.
      expect(await $(`tui-notification ${tid('update-error')}`).isExisting()).toBe(false);
    } else {
      await byId('settings-updates-offer').waitForDisplayed({ timeout: 5000 });
      await byId('update-notice').waitForDisplayed({ timeout: 5000 });
      await shot('settings-updates-available');
    }
  });

  it('the Check now button keeps the focus after a check', async () => {
    await byId('settings-updates-check').click();
    await browser.waitUntil(
      async () => (await byId('settings-updates-status').getAttribute('data-state')) !== 'checking',
      { timeout: 30000 },
    );
    const focused = await browser.execute(
      () => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? '',
    );
    expect(focused).toBe('settings-updates-check');
  });
});
