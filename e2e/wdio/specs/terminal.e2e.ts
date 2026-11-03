import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes, setThemeMode } from '../helpers/screenshot';
import {
  byId,
  clickId,
  createHost,
  createProject,
  currentScope,
  enterProject,
  tid,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const rows = (n: number) => $(`${tid(`terminal-view-${n}`)} .xterm-rows`);

async function rowsText(n: number): Promise<string> {
  return (await rows(n)
    .getText()
    .catch(() => '')) as string;
}

async function waitOutput(n: number, text: string): Promise<void> {
  await browser.waitUntil(async () => (await rowsText(n)).includes(text), {
    timeout: 20000,
    timeoutMsg: `terminal ${n} never showed "${text}"`,
  });
}

async function run(n: number, command: string): Promise<void> {
  const view = byId(`terminal-view-${n}`);
  await view.waitForDisplayed({ timeout: 10000 });
  await browser.execute(
    (sel: string) => {
      document.querySelector<HTMLTextAreaElement>(`${sel} textarea`)?.focus();
    },
    tid(`terminal-view-${n}`),
  );
  await browser.keys(command.split(''));
  await browser.keys('Enter');
}

const terminalBackground = () =>
  browser.execute((sel: string) => {
    const bg = document.querySelector(`${sel} .xterm`) as HTMLElement | null;
    const fg = document.querySelector(`${sel} .xterm-rows`) as HTMLElement | null;
    if (!bg || !fg) return '';
    return `${getComputedStyle(bg).backgroundColor}|${getComputedStyle(fg).color}`;
  }, tid('terminal-view-1'));

const selectMode = setThemeMode;

async function acceptHostKeyIfAsked(): Promise<void> {
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
}

describe('terminal tabs', () => {
  before(waitForApp);

  it('opens the first tab on a disconnected host after the host key prompt', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT);
    await clickId(`open-host-${HOST.name}`);
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await byId('terminal-empty').waitForDisplayed({ timeout: 10000 });
    await shot('term-01-empty');
    await clickId('terminal-new');
    await acceptHostKeyIfAsked();
    await waitStatus(HOST.name, 'Connected');
    await byId('terminal-tab-1').waitForDisplayed({ timeout: 20000 });
    await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
    await expect(byId('terminal-empty')).not.toExist();
    await browser.pause(1000);
    await shot('term-02-first-tab');
  });

  it('runs a command and themes the terminal', async () => {
    await run(1, 'echo carapace-$((20+22))');
    await waitOutput(1, 'carapace-42');
    await selectMode('light');
    await browser.pause(500);
    const light = await terminalBackground();
    await shot('term-03-output');
    await selectMode('dark');
    await browser.pause(500);
    const dark = await terminalBackground();
    console.log('terminal background light/dark', light, dark);
    expect(light).not.toBe(dark);
  });

  it('keeps tab 1 output when a second tab is opened and closed', async () => {
    await clickId('terminal-new');
    await byId('terminal-tab-2').waitForDisplayed({ timeout: 20000 });
    await byId('terminal-view-2').waitForDisplayed({ timeout: 10000 });
    await browser.pause(1000);
    await run(2, 'echo second-$((3*4))');
    await waitOutput(2, 'second-12');
    await shot('term-04-two-tabs');
    await clickId('terminal-tab-1');
    await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
    await waitOutput(1, 'carapace-42');
    await clickId('terminal-close-2');
    await waitGone('terminal-tab-2');
    await expect(byId('terminal-tab-1')).toExist();
    await waitOutput(1, 'carapace-42');
  });

  it('keeps the tab and scrollback after leaving the host page', async () => {
    await clickId('home-link');
    await byId('welcome').waitForDisplayed({ timeout: 10000 });
    await browser.waitUntil(async () => (await currentScope()) === 'Home', { timeout: 10000 });
    await enterProject(PROJECT);
    await clickId(`open-host-${HOST.name}`);
    await byId('terminal-tab-1').waitForDisplayed({ timeout: 10000 });
    await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
    await waitOutput(1, 'carapace-42');
    await shot('term-05-back');
  });

  it('shows the ended banner on disconnect and reopens the shell', async () => {
    await clickId('host-disconnect');
    await waitStatus(HOST.name, 'Not connected');
    await byId('terminal-ended').waitForDisplayed({ timeout: 15000 });
    await shot('term-06-ended');
    await clickId('terminal-reopen');
    await waitStatus(HOST.name, 'Connected');
    await expect(byId('host-key-accept')).not.toExist();
    await waitGone('terminal-ended');
    await browser.pause(1000);
    await run(1, 'echo reopened-$((1+1))');
    await waitOutput(1, 'reopened-2');
    expect(await rowsText(1)).toContain('carapace-42');
    await shot('term-07-reopened');
  });
});
