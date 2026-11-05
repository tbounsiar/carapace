import { join } from 'node:path';
import { appHome, readSettings } from '../helpers/app-files';
import { screenshotThemes, setThemeMode } from '../helpers/screenshot';
import { byId, clickId, tid, waitForApp, waitGone } from '../helpers/ui';

// Versions before settings.toml kept the preferences in the webview storage. The app imports
// them once at startup, then removes them; `carapace.theme` stays as the first-paint cache.
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const OLD_KEYS = ['carapace.keyType', 'carapace.terminalFontSize', 'carapace.keyFolder'];
const IMPORTED = 'carapace.settingsImported';

const stored = (key: string) =>
  browser.execute((k: string): string | null => localStorage.getItem(k), key);

/** Writes the webview storage as an older version left it, then starts the frontend again. */
async function reloadWith(values: Record<string, string>): Promise<void> {
  await browser.execute(
    (entries: Record<string, string>, imported: string) => {
      localStorage.removeItem(imported);
      for (const key of Object.keys(entries)) localStorage.setItem(key, entries[key]);
    },
    values,
    IMPORTED,
  );
  // A reload keeps the process: WebView2 drops recent storage writes when the driver ends it.
  await browser.refresh();
  await waitForApp();
}

const radioChecked = (id: string) =>
  browser.execute(
    (sel: string) => document.querySelector<HTMLInputElement>(`${sel} input`)?.checked ?? false,
    tid(id),
  );

describe('preferences left in the webview storage by an older version', () => {
  const folder = () => join(appHome(), 'old-keys');

  before(waitForApp);

  after(() => setThemeMode('system'));

  it('moves them to settings.toml and removes the old keys', async () => {
    const analytics = readSettings()?.['analytics'];
    expect(readSettings()?.['legacy_imported']).toBeUndefined();
    await reloadWith({
      'carapace.keyType': 'rsa4096',
      'carapace.terminalFontSize': '17',
      'carapace.keyFolder': folder(),
      'carapace.theme': 'dark',
    });
    await browser.waitUntil(async () => readSettings()?.['legacy_imported'] === true, {
      timeout: 10000,
      timeoutMsg: `the import never reached settings.toml: ${JSON.stringify(readSettings())}`,
    });
    expect(readSettings()).toEqual({
      language: 'en',
      theme: 'dark',
      default_key_type: 'rsa4096',
      terminal_font_size: 17,
      key_folder: folder(),
      legacy_imported: true,
      analytics,
    });
    await browser.waitUntil(async () => (await stored(IMPORTED)) === '1', { timeout: 5000 });
    for (const key of OLD_KEYS) expect(await stored(key)).toBeNull();
    expect(await stored('carapace.theme')).toBe('dark');

    await clickId('settings');
    await byId('settings-title').waitForDisplayed({ timeout: 10000 });
    await expect(byId('settings-font-size-value')).toHaveText('17 px');
    await browser.waitUntil(() => radioChecked('settings-key-type-rsa4096'), { timeout: 5000 });
    await browser.waitUntil(() => radioChecked('settings-theme-dark'), { timeout: 5000 });
    await shot('legacy-01-imported');

    await clickId('ssh-keys');
    await clickId('keys-generate');
    await byId('keygen-folder').waitForDisplayed({ timeout: 10000 });
    await expect(byId('keygen-folder')).toHaveValue(folder());
    const cancel = $('//tui-dialog//button[normalize-space()="Cancel"]');
    await cancel.click();
    await waitGone('keygen-folder');
  });

  it('never imports twice', async () => {
    // The webview marker is cleared too: the settings file alone must refuse a second import.
    await reloadWith({ 'carapace.keyType': 'ed25519', 'carapace.terminalFontSize': '11' });
    await browser.waitUntil(async () => (await stored(IMPORTED)) === '1', { timeout: 10000 });
    for (const key of OLD_KEYS) expect(await stored(key)).toBeNull();
    expect(readSettings()).toEqual(
      expect.objectContaining({ default_key_type: 'rsa4096', terminal_font_size: 17 }),
    );
    await clickId('settings');
    await byId('settings-title').waitForDisplayed({ timeout: 10000 });
    await expect(byId('settings-font-size-value')).toHaveText('17 px');
    await browser.waitUntil(() => radioChecked('settings-key-type-rsa4096'), { timeout: 5000 });
  });
});
