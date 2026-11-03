import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  activeTab,
  byId,
  clickId,
  createHost,
  createProject,
  currentScope,
  goHome,
  tabMenu,
  tid,
  waitActiveTab,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const HOME_HOST = { ...HOST, name: 'home-sshd' };
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));
const tab = (host: string, n: number) => `tab-${host}-terminal-${n}`;

async function acceptHostKeyIfAsked(): Promise<void> {
  const accept = byId('host-key-accept');
  if (
    await accept.waitForExist({ timeout: 10000 }).then(
      () => true,
      () => false,
    )
  ) {
    await clickId('host-key-accept');
    await waitGone('host-key-accept');
  }
}

describe('workspace tabs', () => {
  before(waitForApp);

  it('opens a terminal by double-clicking a sidebar host, then focuses it again', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT);
    await byId(`open-host-${HOST.name}`).doubleClick();
    await acceptHostKeyIfAsked();
    await waitStatus(HOST.name, 'Connected');
    await waitActiveTab(tab(HOST.name, 1));
    expect(await browser.getUrl()).toContain('/tabs/');
    await expect(byId(`tree-host-${HOST.name}`)).toHaveElementClass('_selected');
    await clickId('crumb-host');
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await byId(`open-host-${HOST.name}`).doubleClick();
    await waitActiveTab(tab(HOST.name, 1));
    await expect(byId(tab(HOST.name, 2))).not.toExist();
  });

  it('switches scope with the active tab across Home and a project', async () => {
    await createHost(null, HOME_HOST);
    await byId(`open-host-${HOME_HOST.name}`).doubleClick();
    await acceptHostKeyIfAsked();
    await waitActiveTab(tab(HOME_HOST.name, 1));
    expect(await currentScope()).toBe('Home');
    await browser.keys(['Control', 'Tab']);
    await waitActiveTab(tab(HOST.name, 1));
    await browser.waitUntil(async () => (await currentScope()) === PROJECT, { timeout: 10000 });
    await shot('ws-01-two-scopes');
    await browser.keys(['Control', 'Shift', 'Tab']);
    await waitActiveTab(tab(HOME_HOST.name, 1));
    await browser.waitUntil(async () => (await currentScope()) === 'Home', { timeout: 10000 });
  });

  it('collects the hidden tabs in More at 800 px', async () => {
    const size = await browser.getWindowSize();
    try {
      await browser.setWindowSize(800, size.height);
      for (let i = 0; i < 5; i++) {
        await browser.keys(['Control', 'Shift', 't']);
        await waitActiveTab(tab(HOME_HOST.name, i + 2));
      }
      await byId('tabs-more').waitForDisplayed({ timeout: 10000 });
      await shot('ws-02-more-800px');
      await clickId('tabs-more');
      const option = $$(`[data-testid^="tabs-more-option-"]`)[0];
      await option.waitForDisplayed({ timeout: 10000 });
      const id = ((await option.getAttribute('data-testid')) ?? '').replace(
        'tabs-more-option-',
        'tab-',
      );
      await option.click();
      await waitActiveTab(id);
    } finally {
      await browser.setWindowSize(size.width, size.height);
    }
  });

  it('closes other tabs from the tab menu and keeps the connections', async () => {
    const keep = tab(HOST.name, 1);
    await tabMenu(keep, 'tab-menu-close-others');
    await browser.waitUntil(
      async () => (await $$('[data-testid="workspace-tabs"] [role="tab"]').length) === 1,
      { timeout: 10000 },
    );
    expect(await activeTab()).toBe(keep);
    await waitStatus(HOST.name, 'Connected');
    await expect(byId(keep).$(tid('tab-status'))).toHaveAttribute('data-state', 'connected');
    await goHome();
    await waitStatus(HOME_HOST.name, 'Connected');
  });
});
