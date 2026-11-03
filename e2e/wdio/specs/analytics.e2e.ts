import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  createHost,
  createProject,
  tid,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

// The e2e build has no Aptabase key: events reach the in-memory log, nothing leaves the machine.
// `beforeSession` seeds no config for this spec, so the first launch has no consent decision.
const home = () => process.env['E2E_CARAPACE_HOME'] ?? '';
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

/** Rewrites the config with only this analytics field (or none), then restarts the app. */
async function restartWith(analytics?: { consent: string; catalogueVersion: number }) {
  const config = analytics ? { version: 3, analytics } : { version: 3 };
  writeFileSync(join(home(), 'config.json'), JSON.stringify(config, null, 2));
  await browser.reloadSession();
  await waitForApp();
}

async function openSettings(): Promise<void> {
  await clickId('settings');
  await byId('settings-analytics').waitForExist({ timeout: 10000 });
  await browser.waitUntil(async () => await byId('settings-analytics').isEnabled(), {
    timeout: 10000,
    timeoutMsg: 'the analytics switch never loaded',
  });
}

const switchOn = () => byId('settings-analytics').isSelected();

async function openEvents(): Promise<void> {
  await clickId('settings-analytics-events');
  await byId('analytics-events-close').waitForDisplayed({ timeout: 10000 });
}

async function closeEvents(): Promise<void> {
  await clickId('analytics-events-close');
  await waitGone('analytics-events-close');
}

const eventNames = () =>
  browser.execute(() =>
    [...document.querySelectorAll('[data-testid^="analytics-event-"]')].map((row) =>
      row.getAttribute('data-event'),
    ),
  );

const eventRowsText = () =>
  browser.execute(() =>
    [...document.querySelectorAll('[data-testid^="analytics-event-"]')]
      .map((row) => row.textContent ?? '')
      .join('\n'),
  );

async function noDialogFor(ms: number): Promise<void> {
  await browser.pause(ms);
  await expect(byId('consent-dialog')).not.toExist();
}

async function openTerminal(): Promise<void> {
  await clickId(`open-host-${HOST.name}`);
  await byId('host-detail').waitForDisplayed({ timeout: 10000 });
  await clickId('terminal-new');
  const accept = byId('host-key-accept');
  if (
    await accept.waitForExist({ timeout: 15000 }).then(
      () => true,
      () => false,
    )
  ) {
    await clickId('host-key-accept');
    await waitGone('host-key-accept');
  }
  await waitStatus(HOST.name, 'Connected');
}

describe('usage analytics consent', () => {
  before(waitForApp);

  it('asks once on a fresh install, over the Home dashboard, focused on decline', async () => {
    await byId('consent-dialog').waitForDisplayed({ timeout: 20000 });
    expect(await $$(tid('consent-dialog')).length).toBe(1);
    await expect(byId('welcome')).toExist();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.activeElement?.getAttribute('data-testid'))) ===
        'consent-decline',
      { timeout: 5000, timeoutMsg: 'focus is not on "Don\'t share"' },
    );
    await shot('analytics-consent');
  });

  it('declines with Escape and does not ask again', async () => {
    await browser.keys('Escape');
    await waitGone('consent-dialog');
    await openSettings();
    expect(await switchOn()).toBe(false);
    await browser.refresh();
    await waitForApp();
    await noDialogFor(3000);
  });

  it('shares from the dialog: the switch is on and the log shows the start', async () => {
    await restartWith();
    await byId('consent-dialog').waitForDisplayed({ timeout: 20000 });
    await clickId('consent-share');
    await waitGone('consent-dialog');
    await openSettings();
    expect(await switchOn()).toBe(true);
    await byId('settings-analytics-unavailable').waitForDisplayed({ timeout: 10000 });
    await shot('settings-privacy');
    await openEvents();
    const names = await eventNames();
    expect(names).toContain('consent_granted');
    expect(names).toContain('app_started');
    await shot('analytics-events');
    await closeEvents();
  });

  it('logs an opened terminal without any host detail', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT);
    await openTerminal();
    await byId('terminal-tab-1').waitForDisplayed({ timeout: 20000 });
    await openSettings();
    await openEvents();
    expect(await eventNames()).toContain('terminal_opened');
    const text = await eventRowsText();
    for (const detail of [HOST.name, HOST.hostname, HOST.port, HOST.username]) {
      expect(text).not.toContain(detail);
    }
    await closeEvents();
  });

  it('turning it off clears the log and stops logging', async () => {
    await clickId('settings-analytics');
    await browser.waitUntil(async () => !(await switchOn()), { timeout: 5000 });
    await openEvents();
    await byId('analytics-events-empty').waitForDisplayed({ timeout: 10000 });
    await closeEvents();
    await openTerminal();
    await openSettings();
    await openEvents();
    await byId('analytics-events-empty').waitForDisplayed({ timeout: 10000 });
    await expect(byId('analytics-events')).not.toExist();
    await closeEvents();
  });

  it('asks again when a granted consent covers an older catalogue', async () => {
    await restartWith({ consent: 'granted', catalogueVersion: 0 });
    await byId('consent-dialog').waitForDisplayed({ timeout: 20000 });
    await clickId('consent-decline');
    await waitGone('consent-dialog');
  });
});
