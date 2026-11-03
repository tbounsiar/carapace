import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes, setThemeMode } from '../helpers/screenshot';
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

  after(async () => {
    // The webview keeps localStorage across spec files; leave the defaults for the next one.
    await browser.execute(() => {
      try {
        localStorage.removeItem('carapace.keyType');
        localStorage.removeItem('carapace.terminalFontSize');
      } catch {
        // Nothing to restore.
      }
    });
    await setThemeMode('system');
  });

  it('opens from the sidebar and changes the theme in sync with the header', async () => {
    await openSettings();
    await expect(byId('settings')).toHaveAttribute('aria-current', 'page');
    await clickId('settings-theme-dark');
    await browser.waitUntil(async () => (await effectiveTheme()) === 'dark', { timeout: 5000 });
    await expect(byId('theme-toggle')).toHaveAttribute('aria-label', 'Theme: Dark');
    expect(await stored('carapace.theme')).toBe('dark');

    await setThemeMode('light');
    await expect(byId('theme-toggle')).toHaveAttribute('aria-label', 'Theme: Light');
    await browser.waitUntil(async () => (await effectiveTheme()) === 'light', { timeout: 5000 });
    await browser.waitUntil(() => radioChecked('settings-theme-light'), { timeout: 5000 });
    await shot('settings-01-page');
  });

  it('uses the default key type in the generate dialog', async () => {
    await clickId('settings-key-type-rsa4096');
    await browser.waitUntil(async () => (await stored('carapace.keyType')) === 'rsa4096', {
      timeout: 5000,
    });
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
    await browser.waitUntil(async () => (await stored('carapace.terminalFontSize')) === '20', {
      timeout: 5000,
    });
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
});
