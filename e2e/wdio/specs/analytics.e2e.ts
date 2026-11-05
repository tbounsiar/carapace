import { existsSync } from 'node:fs';
import {
  homeFile,
  readSettings,
  removeHomeFiles,
  writeConfigJson,
  writeSettings,
  type Toml,
} from '../helpers/app-files';
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
// `beforeSession` seeds no file for this spec, so the first launch has no consent decision.
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const CATEGORIES = ['launch', 'features', 'connections', 'crashes'] as const;
type Category = (typeof CATEGORIES)[number];
type Stored = Partial<Record<Category, 'granted' | 'denied'>>;

/** Restarts with these `[analytics.*]` categories in `settings.toml`, or no settings file. */
async function restartWith(categories?: Toml) {
  await restartApp(() => {
    if (categories) writeSettings({ analytics: categories });
    else removeHomeFiles('settings.toml');
  });
  await waitForApp();
}

/**
 * Restarts from a pre-split `config.json` holding only this analytics field, in a shape of the
 * first release; the app splits it into `data.json` and `settings.toml`.
 */
async function restartWithConfigJson(analytics: object) {
  await restartApp(() => {
    removeHomeFiles('data.json', 'settings.toml', 'config.json.v4.bak');
    writeConfigJson({ version: 3, analytics });
  });
  await waitForApp();
  expect(existsSync(homeFile('config.json'))).toBe(false);
  expect(existsSync(homeFile('config.json.v4.bak'))).toBe(true);
  expect(existsSync(homeFile('data.json'))).toBe(true);
}

/** The consent of each category as written in `settings.toml`; an unset one is not written. */
function storedConsent(): Stored {
  const analytics = (readSettings()?.['analytics'] ?? {}) as Toml;
  // Display order, whatever the file order: the comparison below is on the serialized form.
  return Object.fromEntries(
    CATEGORIES.filter((c) => c in analytics).map((c) => [c, (analytics[c] as Toml)['consent']]),
  ) as Stored;
}

async function waitStored(expected: Stored): Promise<void> {
  await browser.waitUntil(
    async () => JSON.stringify(storedConsent()) === JSON.stringify(expected),
    {
      timeout: 5000,
      timeoutMsg: `settings.toml never held ${JSON.stringify(expected)}: ${JSON.stringify(storedConsent())}`,
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

/** The categories whose dialog block carries the "New" badge, in display order. */
const newBadges = () =>
  browser.execute(() =>
    [...document.querySelectorAll('[data-testid="consent-dialog"] label')]
      .filter((label) => label.querySelector('[tuiBadge]'))
      .map((label) => label.querySelector('input')?.getAttribute('data-testid') ?? ''),
  );

/** The consent dialog fits the window without scrolling its overlay. */
const dialogFits = () =>
  browser.execute(() => {
    const rect = document.querySelector('tui-dialog')?.getBoundingClientRect();
    return !!rect && rect.top >= 0 && rect.bottom <= window.innerHeight;
  });

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

const ALL_ON = { launch: true, features: true, connections: true, crashes: true };
const LAUNCH_ONLY = { launch: true, features: false, connections: false, crashes: false };
const ALL_OFF = { launch: false, features: false, connections: false, crashes: false };
const GRANTED_V2 = { consent: 'granted', version: 2 };
const DENIED_V2 = { consent: 'denied', version: 2 };
const ALL_GRANTED: Stored = {
  launch: 'granted',
  features: 'granted',
  connections: 'granted',
  crashes: 'granted',
};
const ALL_DENIED: Stored = {
  launch: 'denied',
  features: 'denied',
  connections: 'denied',
  crashes: 'denied',
};

describe('usage analytics consent', () => {
  before(waitForApp);

  it('asks once on a fresh install, every category on, focus on the launch count', async () => {
    await waitDialog();
    await expect(byId('welcome')).toExist();
    await dialogShows(ALL_ON);
    await expect(byId('consent-allow-all')).not.toExist();
    await expect(byId('consent-reask')).not.toExist();
    expect(await newBadges()).toEqual([]);
    await expect(byId('consent-crashes-note')).toHaveText(
      'If Carapace crashes: crash type, app area and, in its own code, the source line. No messages or paths.',
    );
    await browser.waitUntil(async () => (await focusedId()) === 'consent-launch', {
      timeout: 5000,
      timeoutMsg: 'focus is not on the launch count switch',
    });
    expect(storedConsent()).toEqual({});
    expect(await dialogFits()).toBe(true);
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
    await waitStored({ ...ALL_GRANTED, features: 'denied' });
    await openSettings();
    await settingsShow({ ...ALL_ON, features: false });
    await browser.refresh();
    await waitForApp();
    await noDialogFor(3000);
  });

  it('Save choices with the defaults stores all four granted', async () => {
    await restartWith();
    await waitDialog();
    await dialogShows(ALL_ON);
    await clickId('consent-save');
    await waitGone('consent-dialog');
    await waitStored(ALL_GRANTED);
    await openSettings();
    await settingsShow(ALL_ON);
    await byId('settings-analytics-unavailable').waitForDisplayed({ timeout: 10000 });
    for (const id of [
      'settings-analytics-common',
      'settings-analytics-never',
      'settings-analytics-crashes-note',
    ])
      await expect(byId(id)).toBeDisplayed();
    await byId('settings-analytics-launch').scrollIntoView({ block: 'center' });
    await shot('settings-privacy');
    await eventsAre(['session_started', 'app_started']);
    await expect(byId('analytics-crash-note')).not.toExist();
    await closeEvents();
  });

  it('switches turned off before Save choices are stored denied', async () => {
    await restartWith();
    await waitDialog();
    await clickId('consent-features');
    await clickId('consent-connections');
    await clickId('consent-crashes');
    await dialogShows(LAUNCH_ONLY);
    await clickId('consent-save');
    await waitGone('consent-dialog');
    await waitStored({ ...ALL_DENIED, launch: 'granted' });
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
    await settingsShow({ ...LAUNCH_ONLY, features: true });
    await waitStored({ ...ALL_DENIED, launch: 'granted', features: 'granted' });
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
    await settingsShow({ ...ALL_ON, crashes: false });
    await waitStored({ ...ALL_GRANTED, crashes: 'denied' });
    await disconnect(HOST.name);
    await connect(HOST.name);
    await waitStatus(HOST.name, 'Connected');
    await openSettings();
    await openEvents();
    expect(await eventNames()).toContain('connect_succeeded');
    expect(await eventRowsText()).not.toContain(HOST.hostname);
    await closeEvents();
  });

  it('turning crash reports on in Settings stores that category only', async () => {
    await clickId('settings-analytics-crashes');
    await settingsShow(ALL_ON);
    await waitStored(ALL_GRANTED);
  });

  it('turning each category off removes its events from the log', async () => {
    await clickId('settings-analytics-launch');
    await settingsShow({ ...ALL_ON, launch: false });
    await openEvents();
    expect(await eventNames()).not.toContain('session_started');
    expect(await eventNames()).toContain('terminal_opened');
    await closeEvents();
    await clickId('settings-analytics-features');
    await clickId('settings-analytics-connections');
    await clickId('settings-analytics-crashes');
    await settingsShow(ALL_OFF);
    await waitStored(ALL_DENIED);
    await eventsAre([]);
    await expect(byId('analytics-events-empty')).toHaveText(/Usage data is off\./);
    await shot('analytics-events-empty');
    await closeEvents();
  });

  it('a first-release grant migrates to three granted and asks about crash reports', async () => {
    await restartWithConfigJson({ consent: 'granted', catalogueVersion: 1 });
    await waitDialog();
    await byId('consent-reask').waitForDisplayed({ timeout: 5000 });
    expect(await newBadges()).toEqual(['consent-crashes']);
    await dialogShows(ALL_ON);
    await clickId('consent-save');
    await waitGone('consent-dialog');
    await waitStored(ALL_GRANTED);
    await openSettings();
    await settingsShow(ALL_ON);
    await eventsAre(['session_started', 'app_started']);
    await closeEvents();
  });

  it('a first-release refusal migrates to all four denied, with no dialog', async () => {
    await restartWithConfigJson({ consent: 'denied', catalogueVersion: 1 });
    await noDialogFor(3000);
    await waitStored(ALL_DENIED);
    await openSettings();
    await settingsShow(ALL_OFF);
    await eventsAre([]);
    await closeEvents();
  });

  it('asks again when a first-release grant covers an older catalogue', async () => {
    await restartWithConfigJson({ consent: 'granted', catalogueVersion: 0 });
    await waitDialog();
    await expect(byId('consent-reask')).not.toExist();
    await dialogShows(ALL_ON);
    await clickId('consent-save');
    await waitGone('consent-dialog');
    await waitStored(ALL_GRANTED);
  });

  it('asks an upgrading user about crash reports only, marked New and on', async () => {
    await restartWith({ launch: GRANTED_V2, features: DENIED_V2, connections: GRANTED_V2 });
    await waitDialog();
    await expect(byId('consent-reask')).toHaveText(
      'What Carapace can send has changed. Check what is marked New.',
    );
    expect(await newBadges()).toEqual(['consent-crashes']);
    await dialogShows({ ...ALL_ON, features: false });
    expect(await dialogFits()).toBe(true);
    await shot('analytics-consent-reask');
    await browser.keys('Escape');
    await waitGone('consent-dialog');
    await waitStored({ ...ALL_GRANTED, features: 'denied' });
    expect(((readSettings()?.['analytics'] as Toml)['crashes'] as Toml)['version']).toBe(3);
    await browser.refresh();
    await waitForApp();
    await noDialogFor(3000);
  });

  it('starts crash reports off for a user who refused the three other categories', async () => {
    await restartWith({ launch: DENIED_V2, features: DENIED_V2, connections: DENIED_V2 });
    await waitDialog();
    await byId('consent-reask').waitForDisplayed({ timeout: 5000 });
    expect(await newBadges()).toEqual(['consent-crashes']);
    await dialogShows(ALL_OFF);
    await browser.keys('Escape');
    await waitGone('consent-dialog');
    await waitStored(ALL_DENIED);
  });

  it('re-asks only an outdated category, keeping the others as stored', async () => {
    await restartWith({
      launch: { consent: 'granted', version: 1 },
      features: GRANTED_V2,
      connections: DENIED_V2,
      crashes: { consent: 'granted', version: 3 },
    });
    await waitDialog();
    await byId('consent-reask').waitForDisplayed({ timeout: 5000 });
    expect(await newBadges()).toEqual(['consent-launch']);
    await dialogShows({ ...ALL_ON, connections: false });
    await browser.keys('Escape');
    await waitGone('consent-dialog');
    await waitStored({ ...ALL_GRANTED, connections: 'denied' });
    expect(((readSettings()?.['analytics'] as Toml)['launch'] as Toml)['version']).toBe(3);
  });
});
