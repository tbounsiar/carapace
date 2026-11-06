import { Key } from 'webdriverio';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshot, screenshotThemes, setThemeMode } from '../helpers/screenshot';
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
  tabMenu,
  waitActiveTab,
  waitStatus,
} from '../helpers/ui';

const tab = (n: number) => `tab-${HOST.name}-terminal-${n}`;

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

const terminalMenu = () => $('[data-testid="context-menu"][data-surface="terminal"]');

async function openTerminalMenu(n: number): Promise<void> {
  await byId(`terminal-view-${n}`).click({ button: 'right' });
  await terminalMenu().waitForDisplayed({ timeout: 5000 });
  expect(await $$('tui-dropdown').length).toBe(1);
}

async function closeTerminalMenu(): Promise<void> {
  await browser.keys('Escape');
  await terminalMenu().waitForExist({ timeout: 5000, reverse: true });
}

/** Double-clicks the start of the last row beginning with `word`: xterm selects that word. */
async function selectWord(n: number, word: string): Promise<void> {
  const rowsOf = await $$(`${tid(`terminal-view-${n}`)} .xterm-rows > div`);
  let target: (typeof rowsOf)[number] | null = null;
  for (const row of rowsOf) {
    if (((await row.getText()) as string).startsWith(word)) {
      target = row;
    }
  }
  if (!target) {
    throw new Error(`no terminal row starts with "${word}"`);
  }
  // `doubleClick()` aims at the row's centre, which is blank after the text.
  const size = await target.getSize();
  await browser
    .action('pointer')
    .move({ origin: target, x: Math.round(-size.width / 2) + 4, y: 0 })
    .down()
    .up()
    .pause(50)
    .down()
    .up()
    .perform();
  await browser.waitUntil(
    () =>
      browser.execute(
        (sel: string) => !!document.querySelector(`${sel} .xterm-selection div`),
        tid(`terminal-view-${n}`),
      ),
    { timeout: 3000, timeoutMsg: `"${word}" was not selected` },
  );
}

async function occurrences(n: number, text: string): Promise<number> {
  return (await rowsText(n)).split(text).length - 1;
}

async function shotTerminalMenu(name: string, n: number): Promise<void> {
  const files: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    await setThemeMode(mode);
    await browser.pause(400);
    await openTerminalMenu(n);
    await browser.pause(400);
    files.push(await screenshot(`${name}-${mode}`));
    await closeTerminalMenu();
  }
  await setThemeMode('system');
  console.log('screenshots', files);
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
    await byId('host-tabs-empty').waitForDisplayed({ timeout: 10000 });
    await expect(byId('workspace-tabs')).not.toExist();
    await shot('term-01-empty');
    await clickId('host-new-terminal');
    await acceptHostKeyIfAsked();
    await waitStatus(HOST.name, 'Connected');
    await byId(tab(1)).waitForDisplayed({ timeout: 20000 });
    await waitActiveTab(tab(1));
    await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
    const focused = await browser
      .waitUntil(() => browser.execute(() => !!document.activeElement?.closest('.xterm')), {
        timeout: 5000,
      })
      .catch(() => false);
    if (!focused) {
      const where = await browser.execute(() => document.activeElement?.outerHTML.slice(0, 200));
      throw new Error(`the focus did not go into the new terminal but to: ${where}`);
    }
    await browser.pause(1000);
    await shot('term-02-first-tab');

    await clickId('crumb-host');
    await byId(`host-tab-${HOST.name}-terminal-1`).waitForDisplayed({ timeout: 10000 });
    await shot('term-02b-host-open-tabs');
    await clickId(`host-tab-${HOST.name}-terminal-1`);
    await waitActiveTab(tab(1));
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

  it('keeps tab 1 output when a second tab is opened, switched with the keyboard and closed', async () => {
    await clickId('tabs-new');
    await byId(tab(2)).waitForDisplayed({ timeout: 20000 });
    await waitActiveTab(tab(2));
    await byId('terminal-view-2').waitForDisplayed({ timeout: 10000 });
    await browser.pause(1000);
    await run(2, 'echo second-$((3*4))');
    await waitOutput(2, 'second-12');
    await shot('term-04-two-tabs');
    // Focus is in xterm: Ctrl+Tab and Ctrl+1 still switch tabs.
    await browser.keys(['Control', 'Tab']);
    await waitActiveTab(tab(1));
    await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
    await waitOutput(1, 'carapace-42');
    await browser.keys(['Control', '2']);
    await waitActiveTab(tab(2));
    await browser.keys(['Control', '1']);
    await waitActiveTab(tab(1));
    await byId(tab(2)).$(tid('tab-close')).click();
    await waitGone(tab(2));
    await expect(byId(tab(1))).toExist();
    await waitOutput(1, 'carapace-42');
    await byId(tab(1)).click();
    await browser.keys('Delete');
    await waitGone(tab(1));
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    // Closing the last tab keeps the connection.
    await waitStatus(HOST.name, 'Connected');
    await clickId('host-new-terminal');
    await waitActiveTab(tab(3));
    await run(3, 'echo carapace-$((20+22))');
    await waitOutput(3, 'carapace-42');
  });

  it('keeps the tab and scrollback after leaving the host page', async () => {
    await clickId('home-link');
    await byId('welcome').waitForDisplayed({ timeout: 10000 });
    await browser.waitUntil(async () => (await currentScope()) === 'Home', { timeout: 10000 });
    await enterProject(PROJECT);
    await byId(tab(3)).waitForDisplayed({ timeout: 10000 });
    expect(await byId(tab(3)).getAttribute('aria-selected')).toBe('false');
    await shot('term-05a-no-active-tab');
    await clickId(tab(3));
    await byId('terminal-view-3').waitForDisplayed({ timeout: 10000 });
    await waitOutput(3, 'carapace-42');
    await shot('term-05-back');
  });

  it('shows the ended banner on disconnect and reopens the shell', async () => {
    await tabMenu(tab(3), 'tab-menu-disconnect');
    await waitStatus(HOST.name, 'Not connected');
    await byId('terminal-ended').waitForDisplayed({ timeout: 15000 });
    await expect(byId(tab(3)).$(tid('tab-status'))).toHaveAttribute('data-state', 'ended');
    await shot('term-06-ended');
    await clickId('terminal-reopen');
    await waitStatus(HOST.name, 'Connected');
    await expect(byId('host-key-accept')).not.toExist();
    await waitGone('terminal-ended');
    await browser.pause(1000);
    await run(3, 'echo reopened-$((1+1))');
    await waitOutput(3, 'reopened-2');
    expect(await rowsText(3)).toContain('carapace-42');
    await shot('term-07-reopened');
  });

  it('copies and pastes from the terminal menu and its keys, Ctrl+C still interrupts', async () => {
    await run(3, 'clear');
    await run(3, 'echo ctx-copy-$((5*5))');
    await waitOutput(3, 'ctx-copy-25');
    await shotTerminalMenu('ctx-10-terminal-no-selection', 3);
    await openTerminalMenu(3);
    await expect(byId('terminal-menu-copy')).toHaveAttribute('aria-disabled', 'true');
    await closeTerminalMenu();

    await selectWord(3, 'ctx-copy-25');
    await shotTerminalMenu('ctx-09-terminal', 3);
    await openTerminalMenu(3);
    await expect(byId('terminal-menu-copy')).not.toHaveAttribute('aria-disabled');
    await clickId('terminal-menu-copy');
    const before = await occurrences(3, 'ctx-copy-25');
    await browser.keys('echo '.split(''));
    await openTerminalMenu(3);
    await clickId('terminal-menu-paste');
    await browser.keys('Enter');
    await browser.waitUntil(async () => (await occurrences(3, 'ctx-copy-25')) >= before + 2, {
      timeout: 10000,
      timeoutMsg: 'the pasted selection never ran',
    });
    await browser.pause(500);
    expect(await occurrences(3, 'ctx-copy-25')).toBe(before + 2);

    await selectWord(3, 'ctx-copy-25');
    await browser.keys(['Control', 'Shift', 'c']);
    const typed = await occurrences(3, 'ctx-copy-25');
    await browser.keys('echo '.split(''));
    await browser.keys(['Control', 'Shift', 'v']);
    await browser.keys('Enter');
    await browser.waitUntil(async () => (await occurrences(3, 'ctx-copy-25')) >= typed + 2, {
      timeout: 10000,
      timeoutMsg: 'Ctrl+Shift+V never pasted',
    });
    // Exactly once: the key's own paste, not also the browser's native paste event.
    await browser.pause(500);
    expect(await occurrences(3, 'ctx-copy-25')).toBe(typed + 2);

    // A program reading the mouse owns the plain right click; Shift+right click opens the menu.
    await run(3, "printf '\\033[?1000h'; cat > /dev/null");
    await browser.pause(500);
    await byId('terminal-view-3').click({ button: 'right' });
    await browser.pause(500);
    await expect(terminalMenu()).not.toExist();
    await browser.action('key').down(Key.Shift).perform(true);
    await byId('terminal-view-3').click({ button: 'right' });
    await browser.action('key').up(Key.Shift).perform();
    await terminalMenu().waitForDisplayed({ timeout: 5000 });
    await closeTerminalMenu();
    await browser.keys(['Control', 'c']);
    await run(3, "printf '\\033[?1000l'");

    await run(3, 'sleep 30; echo slept-$((2+2))');
    await browser.pause(500);
    await browser.keys(['Control', 'c']);
    await run(3, 'echo after-$((6*7))');
    await waitOutput(3, 'after-42');
    expect(await rowsText(3)).not.toContain('slept-4');

    await openTerminalMenu(3);
    await clickId('terminal-menu-clear');
    await terminalMenu().waitForExist({ timeout: 5000, reverse: true });
    await run(3, 'echo cleared-ok');
    await waitOutput(3, 'cleared-ok');
  });
});
