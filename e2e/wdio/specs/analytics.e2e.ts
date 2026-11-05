import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restartApp } from '../helpers/app-process';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  connect,
  createHost,
  createProject,
  disconnect,
  tid,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

// The e2e build has no Aptabase key: events reach the in-memory log, nothing leaves the machine.
// `beforeSession` seeds no config for this spec, so the first launch has no consent decision.
const home = () => process.env['E2E_CARAPACE_HOME'] ?? '';
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const CATEGORIES = ['launch', 'features', 'connections'] as const;
type Category = (typeof CATEGORIES)[number];
type Stored = Partial<Record<Category, 'granted' | 'denied'>>;

/** Rewrites the config with only this analytics field (or none), then restarts the app. */
async function restartWith(analytics?: object) {
  const config = analytics ? { version: 3, analytics } : { version: 3 };
  writeFileSync(join(home(), 'config.json'), JSON.stringify(config, null, 2));
  await restartApp();
  await waitForApp();
}

/** The consent of each category as written in `config.json`; an unset one is not written. */
function storedConsent(): Stored {
  const file = join(home(), 'config.json');
  if (!existsSync(file)) return {};
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const categories = config.analytics?.categories ?? {};
  return Object.fromEntries(
    Object.entries(categories).map(([c, v]) => [c, (v as { consent: string }).consent]),
  ) as Stored;
}

async function waitStored(expected: Stored): Promise<void> {
  await browser.waitUntil(
    async () => JSON.stringify(storedConsent()) === JSON.stringify(expected),
    {
      timeout: 5000,
      timeoutMsg: `config.json never held ${JSON.stringify(expected)}: ${JSON.stringify(storedConsent())}`,
    },
  );
}

const consentSwitch = (c: Category) => byId(`consent-${c}`);
const settingsSwitch = (c: Category) => byId(`settings-analytics-${c}`);

async function dialogShows(expected: Record<Category, boolean>): Promise<void> {
  for (const c of CATEGORIES) expect(await consentSwitch(c).isSelected()).toBe(expected[c]);
}

async function waitDialog(): Promise<void> {
  await byId('consent-dialog').waitForDisplayed({ timeout: 20000 });
  expect(await $$(tid('consent-dialog')).length).toBe(1);
}

const focusedId = () =>
  browser.execute(() => document.activeElement?.getAttribute('data-testid') ?? '');

async function openSettings(): Promise<void> {
  await clickId('settings');
  for (const c of CATEGORIES) {
    await settingsSwitch(c).waitForExist({ timeout: 10000 });
    await browser.waitUntil(async () => await settingsSwitch(c).isEnabled(), {
      timeout: 10000,
      timeoutMsg: `the ${c} switch never loaded`,
    });
  }
}

async function settingsShow(expected: Record<Category, boolean>): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const c of CATEGORIES)
        if ((await settingsSwitch(c).isSelected()) !== expected[c]) return false;
      return true;
    },
    { timeout: 5000, timeoutMsg: `Settings never showed ${JSON.stringify(expected)}` },
  );
}

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

async function eventsAre(expected: string[]): Promise<void> {
  await openEvents();
  if (expected.length === 0) {
    await byId('analytics-events-empty').waitForDisplayed({ timeout: 10000 });
    await expect(byId('analytics-events')).not.toExist();
  } else {
    await byId('analytics-events').waitForDisplayed({ timeout: 10000 });
    expect([...(await eventNames())].sort()).toEqual([...expected].sort());
  }
}

async function noDialogFor(ms: number): Promise<void> {
  await browser.pause(ms);
  await expect(byId('consent-dialog')).not.toExist();
}

async function openTerminal(): Promise<void> {
  await clickId(`open-host-${HOST.name}`);
  await byId('host-detail').waitForDisplayed({ timeout: 10000 });
  await clickId('host-new-terminal');
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

const ALL_ON = { launch: true, features: true, connections: true };
const LAUNCH_ONLY = { launch: true, features: false, connections: false };
const ALL_OFF = { launch: false, features: false, connections: false };

describe('usage analytics consent', () => {
  before(waitForApp);

  it('asks once on a fresh install, every category on, focus on the launch count', async () => {
    await waitDialog();
    await expect(byId('welcome')).toExist();
    await dialogShows(ALL_ON);
    await expect(byId('consent-allow-all')).not.toExist();
    await browser.waitUntil(async () => (await focusedId()) === 'consent-launch', {
      timeout: 5000,
      timeoutMsg: 'focus is not on the launch count switch',
    });
    expect(storedConsent()).toEqual({});
    await shot('analytics-consent');
  });

  it('Escape saves the switches as shown and does not ask again', async () => {
    await browser.keys('Tab');
    expect(await focusedId()).toBe('consent-features');
    await browser.keys('Space');
    await browser.waitUntil(async () => !(await consentSwitch('features').isSelected()), {
      timeout: 5000,
    });
    await browser.keys('Escape');
    await waitGone('consent-dialog');
    await waitStored({ launch: 'granted', features: 'denied', connections: 'granted' });
    await openSettings();
    await settingsShow({ launch: true, features: false, connections: true });
    await browser.refresh();
    await waitForApp();
    await noDialogFor(3000);
  });

  it('Save choices with the defaults stores all three granted', async () => {
    await restartWith();
    await waitDialog();
    await dialogShows(ALL_ON);
    await clickId('consent-save');
    await waitGone('consent-dialog');
    await waitStored({ launch: 'granted', features: 'granted', connections: 'granted' });
    await openSettings();
    await settingsShow(ALL_ON);
    await byId('settings-analytics-unavailable').waitForDisplayed({ timeout: 10000 });
    for (const id of ['settings-analytics-common', 'settings-analytics-never'])
      await expect(byId(id)).toBeDisplayed();
    await byId('settings-analytics-launch').scrollIntoView({ block: 'center' });
    await shot('settings-privacy');
    await eventsAre(['session_started', 'app_started']);
    await closeEvents();
  });

  it('switches turned off before Save choices are stored denied', async () => {
    await restartWith();
    await waitDialog();
    await clickId('consent-features');
    await clickId('consent-connections');
    await dialogShows(LAUNCH_ONLY);
    await clickId('consent-save');
    await waitGone('consent-dialog');
    await waitStored({ launch: 'granted', features: 'denied', connections: 'denied' });
    await openSettings();
    await settingsShow(LAUNCH_ONLY);
  });

  it('with only the launch count on, the log holds session_started only', async () => {
    await eventsAre(['session_started']);
    await shot('analytics-events');
    await closeEvents();
  });

  it('turning feature usage on in Settings stores that category only and logs the start', async () => {
    await clickId('settings-analytics-features');
    await settingsShow({ launch: true, features: true, connections: false });
    await waitStored({ launch: 'granted', features: 'granted', connections: 'denied' });
    await eventsAre(['session_started', 'app_started']);
    await closeEvents();
  });

  it('logs an opened terminal without any host detail, and no connection result', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT);
    await openTerminal();
    await byId(`tab-${HOST.name}-terminal-1`).waitForDisplayed({ timeout: 20000 });
    await openSettings();
    await openEvents();
    const names = await eventNames();
    expect(names).toContain('terminal_opened');
    expect(names).toContain('host_created');
    expect(names.filter((n) => n?.startsWith('connect_'))).toEqual([]);
    const text = await eventRowsText();
    for (const detail of [HOST.name, HOST.hostname, HOST.port, HOST.username]) {
      expect(text).not.toContain(detail);
    }
    await shot('analytics-events-features');
    await closeEvents();
  });

  it('turning connection results on logs the next connect', async () => {
    await clickId('settings-analytics-connections');
    await settingsShow(ALL_ON);
    await waitStored({ launch: 'granted', features: 'granted', connections: 'granted' });
    await disconnect(HOST.name);
    await connect(HOST.name);
    await waitStatus(HOST.name, 'Connected');
    await openSettings();
    await openEvents();
    expect(await eventNames()).toContain('connect_succeeded');
    expect(await eventRowsText()).not.toContain(HOST.hostname);
    await closeEvents();
  });

  it('turning each category off removes its events from the log', async () => {
    await clickId('settings-analytics-launch');
    await settingsShow({ launch: false, features: true, connections: true });
    await openEvents();
    expect(await eventNames()).not.toContain('session_started');
    expect(await eventNames()).toContain('terminal_opened');
    await closeEvents();
    await clickId('settings-analytics-features');
    await clickId('settings-analytics-connections');
    await settingsShow(ALL_OFF);
    await waitStored({ launch: 'denied', features: 'denied', connections: 'denied' });
    await eventsAre([]);
    await expect(byId('analytics-events-empty')).toHaveText(/Usage data is off\./);
    await shot('analytics-events-empty');
    await closeEvents();
  });

  it('a first-release grant migrates to all three granted, with no dialog', async () => {
    await restartWith({ consent: 'granted', catalogueVersion: 1 });
    await noDialogFor(3000);
    await openSettings();
    await settingsShow(ALL_ON);
    await eventsAre(['session_started', 'app_started']);
    await closeEvents();
  });

  it('a first-release refusal migrates to all three denied, with no dialog', async () => {
    await restartWith({ consent: 'denied', catalogueVersion: 1 });
    await noDialogFor(3000);
    await openSettings();
    await settingsShow(ALL_OFF);
    await eventsAre([]);
    await closeEvents();
  });

  it('asks again when a first-release grant covers an older catalogue', async () => {
    await restartWith({ consent: 'granted', catalogueVersion: 0 });
    await waitDialog();
    await dialogShows(ALL_ON);
    await clickId('consent-save');
    await waitGone('consent-dialog');
    await waitStored({ launch: 'granted', features: 'granted', connections: 'granted' });
  });

  it('re-asks only an outdated category, keeping the others as stored', async () => {
    await restartWith({
      categories: {
        launch: { consent: 'granted', version: 1 },
        features: { consent: 'granted', version: 2 },
        connections: { consent: 'denied', version: 2 },
      },
    });
    await waitDialog();
    await byId('consent-reask').waitForDisplayed({ timeout: 5000 });
    await dialogShows({ launch: true, features: true, connections: false });
    await shot('analytics-consent-reask');
    await browser.keys('Escape');
    await waitGone('consent-dialog');
    await waitStored({ launch: 'granted', features: 'granted', connections: 'denied' });
    const config = JSON.parse(readFileSync(join(home(), 'config.json'), 'utf8'));
    expect(config.analytics.categories.launch.version).toBe(2);
  });
});
