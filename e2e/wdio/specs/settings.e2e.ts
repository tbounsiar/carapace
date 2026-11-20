import { readSettings, type TomlValue } from '../helpers/app-files';
import { restartApp } from '../helpers/app-process';
import { HOST, PROJECT } from '../helpers/fixture';
import { type Palette, screenshotThemes, setPalette, setThemeMode } from '../helpers/screenshot';
import {
  byId,
  clickId,
  createHost,
  createProject,
  tid,
  waitForApp,
  waitGone,
  typeInto,
  waitStatus,
} from '../helpers/ui';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const effectiveTheme = () =>
  browser.execute(() => document.querySelector('tui-root')?.getAttribute('tuiTheme') ?? '');

const stored = (key: string) =>
  browser.execute((k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }, key);

const OLD_KEYS = ['carapace.keyType', 'carapace.terminalFontSize', 'carapace.keyFolder'];

async function waitSaved(key: string, value: TomlValue): Promise<void> {
  await browser.waitUntil(async () => readSettings()?.[key] === value, {
    timeout: 5000,
    timeoutMsg: `settings.toml never held ${key} = ${value}: ${JSON.stringify(readSettings())}`,
  });
}

const radioChecked = (id: string) =>
  browser.execute(
    (sel: string) => document.querySelector<HTMLInputElement>(`${sel} input`)?.checked ?? false,
    tid(id),
  );

const fontSizeValue = () =>
  browser.execute(
    (sel: string) => document.querySelector<HTMLInputElement>(sel)?.value ?? '',
    tid('settings-font-size'),
  );

const terminalFontSize = () =>
  browser.execute((sel: string) => {
    const rows = document.querySelector(`${sel} .xterm-rows`) as HTMLElement | null;
    return rows ? getComputedStyle(rows).fontSize : '';
  }, tid('terminal-view-1'));

async function openSettings(): Promise<void> {
  await clickId('settings');
  await byId('settings-title').waitForDisplayed({ timeout: 10000 });
}

async function setFontSize(steps: string[]): Promise<void> {
  await browser.execute((sel: string) => {
    document.querySelector<HTMLInputElement>(sel)?.focus();
  }, tid('settings-font-size'));
  await browser.keys(steps);
}

const colorsBelowSubheader = () =>
  browser.execute(() => {
    const legend = document.querySelector('#settings-colors legend');
    const subheader = document.querySelector('nav[tuiSubheader]');
    if (!legend || !subheader) return false;
    return legend.getBoundingClientRect().top >= subheader.getBoundingClientRect().bottom;
  });

/** Scrolls the way the app does: the header theme menu's "Colors…" link to `/settings#colors`. */
async function scrollToColors(): Promise<void> {
  // Through the aside first: a link to the URL already shown would not navigate (nor scroll).
  await openSettings();
  await browser.execute(() => window.scrollTo(0, 0));
  await browser.execute(() => {
    document.querySelector<HTMLElement>('[data-testid="theme-toggle"]')?.click();
  });
  await byId('theme-colors').waitForExist({ timeout: 5000 });
  await browser.execute(() => {
    document.querySelector<HTMLElement>('[data-testid="theme-colors"]')?.click();
  });
  await byId('theme-colors').waitForExist({ timeout: 5000, reverse: true });
  await browser.waitUntil(
    () => browser.execute(() => window.scrollY > 0 && location.hash === '#colors'),
    { timeout: 5000, timeoutMsg: 'the Colors link did not scroll the settings page' },
  );
  expect(await colorsBelowSubheader()).toBe(true);
}

/** Every ANSI foreground, normal then bright, and the black background most prompts use. */
const ANSI_STRIP =
  "for c in 30 31 32 33 34 35 36 37 90 91 92 93 94 95 96 97; do printf '\\033[%sm %s ' $c $c; " +
  "[ $c = 37 ] && printf '\\033[0m\\n'; done; printf '\\033[0m\\n\\033[40;97m black bg \\033[0m\\n'";

async function runInTerminal(command: string): Promise<void> {
  await browser.execute((sel: string) => {
    document.querySelector<HTMLTextAreaElement>(`${sel} textarea`)?.focus();
  }, tid('terminal-view-1'));
  await browser.keys(command.split(''));
  await browser.keys('Enter');
  await browser.pause(500);
}

async function acceptHostKeyIfAsked(outcome: () => Promise<boolean>): Promise<void> {
  await browser.waitUntil(
    async () => {
      if (await byId('host-key-accept').isExisting()) {
        await clickId('host-key-accept');
        await waitGone('host-key-accept');
      }
      return outcome();
    },
    { timeout: 30000, timeoutMsg: 'neither a host key prompt nor an outcome appeared' },
  );
}

describe('settings', () => {
  before(waitForApp);

  // The preferences live in the app home, emptied between spec files; the theme cache in the
  // webview storage outlives it, so the next spec starts from System again.
  after(() => setThemeMode('system'));

  it('opens from the sidebar and changes the theme in sync with the header', async () => {
    await openSettings();
    await expect(byId('settings')).toHaveAttribute('aria-current', 'page');
    await clickId('settings-theme-dark');
    await browser.waitUntil(async () => (await effectiveTheme()) === 'dark', { timeout: 5000 });
    await expect(byId('theme-toggle')).toHaveAttribute('aria-label', 'Theme: Dark');
    await waitSaved('theme', 'dark');
    // First-paint cache only.
    expect(await stored('carapace.theme')).toBe('dark');

    await setThemeMode('light');
    await expect(byId('theme-toggle')).toHaveAttribute('aria-label', 'Theme: Light');
    await browser.waitUntil(async () => (await effectiveTheme()) === 'light', { timeout: 5000 });
    await browser.waitUntil(() => radioChecked('settings-theme-light'), { timeout: 5000 });
    await shot('settings-01-page');
  });

  it('uses the default key type in the generate dialog', async () => {
    await clickId('settings-key-type-rsa4096');
    await waitSaved('default_key_type', 'rsa4096');
    expect(await stored('carapace.keyType')).toBeNull();
    await clickId('ssh-keys');
    await byId('keys-title').waitForDisplayed({ timeout: 10000 });
    await clickId('keys-generate');
    await byId('keygen-name').waitForDisplayed({ timeout: 10000 });
    expect(await radioChecked('keygen-type-rsa')).toBe(true);
    await expect(byId('keygen-name')).toHaveValue('id_rsa');
    await shot('settings-02-keygen-rsa');
    await $('//tui-dialog//button[normalize-space()="Cancel"]').click();
    await waitGone('keygen-name');
  });

  it('sets the terminal font size and applies it to open terminals', async () => {
    await openSettings();
    await setFontSize(['End']);
    await browser.waitUntil(async () => (await fontSizeValue()) === '24', { timeout: 5000 });
    await setFontSize(['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']);
    await waitSaved('terminal_font_size', 20);
    expect(await stored('carapace.terminalFontSize')).toBeNull();
    await expect(byId('settings-font-size-value')).toHaveText('20 px');
    await shot('settings-03-font-size');

    await createProject(PROJECT);
    await createHost(PROJECT);
    await clickId(`open-host-${HOST.name}`);
    await byId('host-tabs-empty').waitForDisplayed({ timeout: 10000 });
    await clickId('host-new-terminal');
    await acceptHostKeyIfAsked(async () => byId('terminal-view-1').isExisting());
    await waitStatus(HOST.name, 'Connected');
    await browser.waitUntil(async () => (await terminalFontSize()) === '20px', {
      timeout: 10000,
      timeoutMsg: 'the terminal did not use the 20 px font size',
    });
    await shot('settings-04-terminal-20px');

    await openSettings();
    await setFontSize(['Home']);
    const reached = await browser
      .waitUntil(async () => (await fontSizeValue()) === '10', { timeout: 5000 })
      .catch(() => false);
    if (!reached) {
      const where = await browser.execute(() => document.activeElement?.outerHTML.slice(0, 160));
      throw new Error(`font size not reset; focus on: ${where}`);
    }
    await clickId(`tab-${HOST.name}-terminal-1`);
    await browser.waitUntil(async () => (await terminalFontSize()) === '10px', {
      timeout: 10000,
      timeoutMsg: 'the open terminal did not switch to 10 px',
    });
    await shot('settings-05-terminal-10px');
  });

  it('applies each color set to the app and the terminal, and adjusts a custom accent', async () => {
    const palettes: Palette[] = ['default', 'high-contrast', 'pine', 'plum'];
    // The previous test left the smallest size; the shots use the default one.
    await openSettings();
    await setFontSize(['Home', 'ArrowRight', 'ArrowRight', 'ArrowRight']);
    await waitSaved('terminal_font_size', 13);
    await clickId(`tab-${HOST.name}-terminal-1`);
    await runInTerminal('clear; ls --color=always -la /');
    await runInTerminal(ANSI_STRIP);
    for (const palette of palettes) {
      await openSettings();
      await setPalette(palette);
      if (palette !== 'default') await waitSaved('palette', palette);
      await scrollToColors();
      await shot(`settings-06-colors-${palette}`);
      await clickId(`tab-${HOST.name}-terminal-1`);
      await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
      await shot(`settings-06-colors-${palette}-terminal`);
    }

    await openSettings();
    await setPalette('default');
    await clickId('settings-accent');
    await byId('settings-accent-input').waitForDisplayed({ timeout: 5000 });
    await typeInto('settings-accent-input', '#ffff00');
    await waitSaved('accent_color', '#ffff00');
    await expect(byId('settings-accent-adjusted')).toHaveText(
      'Made darker in light mode so text stays readable.',
    );
    await scrollToColors();
    await shot('settings-07-accent-adjusted');
    await clickId('settings-accent');
    await waitGone('settings-accent-input');
    await browser.waitUntil(async () => readSettings()?.['accent_color'] === undefined, {
      timeout: 5000,
      timeoutMsg: 'the accent was not removed from settings.toml',
    });

    for (const palette of ['high-contrast', 'pine'] as const) {
      await setPalette(palette);
      await scrollToColors();
      // Keyboard focus: from the checked Theme radio, Tab lands on the checked color set.
      await browser.execute((sel: string) => {
        document.querySelector<HTMLInputElement>(`${sel} input`)?.focus();
      }, tid('settings-theme-light'));
      await browser.keys('Tab');
      expect(
        await browser.execute(
          (sel: string) => document.activeElement === document.querySelector(`${sel} input`),
          tid(`settings-palette-${palette}`),
        ),
      ).toBe(true);
      console.log(
        'screenshots',
        await screenshotThemes(`settings-08-focus-${palette}`, { keepFocus: true }),
      );
    }

    // The restart test checks that the 10 px size from the font size test survives.
    await setFontSize(['Home']);
    await waitSaved('terminal_font_size', 10);
  });

  it('keeps the preferences after an app restart', async () => {
    await waitSaved('terminal_font_size', 10);
    await waitSaved('theme', 'light');
    await openSettings();
    await setPalette('pine');
    await waitSaved('palette', 'pine');
    await restartApp();
    await waitForApp();
    await openSettings();
    await browser.waitUntil(async () => (await fontSizeValue()) === '10', {
      timeout: 10000,
      timeoutMsg: 'the font size was not restored',
    });
    await browser.waitUntil(() => radioChecked('settings-key-type-rsa4096'), { timeout: 10000 });
    await browser.waitUntil(() => radioChecked('settings-theme-light'), { timeout: 10000 });
    expect(await effectiveTheme()).toBe('light');
    await browser.waitUntil(() => radioChecked('settings-palette-pine'), { timeout: 10000 });
    expect(
      await browser.execute(() => document.documentElement.getAttribute('data-app-palette')),
    ).toBe('pine');
    for (const key of OLD_KEYS) expect(await stored(key)).toBeNull();
    expect(readSettings()).toEqual(
      expect.objectContaining({
        theme: 'light',
        palette: 'pine',
        default_key_type: 'rsa4096',
        terminal_font_size: 10,
      }),
    );
  });
});
