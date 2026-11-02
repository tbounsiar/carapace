import { screenshot } from '../helpers/screenshot';

const effectiveTheme = () =>
  browser.execute(() => document.querySelector('tui-root')?.getAttribute('tuiTheme') ?? '');

describe('smoke', () => {
  it('opens the window with the app shell', async () => {
    await $('tui-root').waitForExist({ timeout: 20000 });
    await expect(browser).toHaveTitle(expect.stringContaining('Carapace'));
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`renders the ${mode} theme`, async () => {
      await $(`[data-testid="theme-${mode}"]`).click();
      await browser.waitUntil(async () => (await effectiveTheme()) === mode, { timeout: 5000 });
      await browser.pause(300);
      console.log('screenshot', await screenshot(`smoke-${mode}`));
    });
  }
});
