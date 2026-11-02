import { screenshot } from '../helpers/screenshot';

describe('smoke', () => {
  it('opens the window with the app shell', async () => {
    await $('tui-root').waitForExist({ timeout: 20000 });
    await expect(browser).toHaveTitle(expect.stringContaining('Carapace'));
  });

  it('captures both themes', async () => {
    const theme = () => browser.execute(() => document.body.getAttribute('tuiTheme') ?? 'light');
    const first = await theme();
    console.log('screenshot', await screenshot(`smoke-${first}`));

    const toggle = await $('[aria-label*="theme" i]');
    if (await toggle.isExisting()) {
      await toggle.click();
    } else {
      await browser.execute((t) => document.body.setAttribute('tuiTheme', t), first === 'dark' ? 'light' : 'dark');
    }
    await browser.pause(500);
    const second = await theme();
    console.log('screenshot', await screenshot(`smoke-${second}-after-toggle`));
    expect(second).not.toBe(first);
  });
});
