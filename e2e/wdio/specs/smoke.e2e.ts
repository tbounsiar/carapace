import { screenshot, setThemeMode } from '../helpers/screenshot';
import { waitForApp } from '../helpers/ui';

const effectiveTheme = () =>
  browser.execute(() => document.querySelector('tui-root')?.getAttribute('tuiTheme') ?? '');

describe('smoke', () => {
  it('opens the window with the app shell', async () => {
    await waitForApp();
    await expect(browser).toHaveTitle(expect.stringContaining('Carapace'));
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`renders the ${mode} theme`, async () => {
      await setThemeMode(mode);
      await browser.waitUntil(async () => (await effectiveTheme()) === mode, { timeout: 5000 });
      await browser.pause(300);
      console.log('screenshot', await screenshot(`smoke-${mode}`));
    });
  }
});
