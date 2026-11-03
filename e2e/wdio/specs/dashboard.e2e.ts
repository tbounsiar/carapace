import { HOST } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  activeTab,
  byId,
  clickId,
  confirmDelete,
  createHost,
  createProject,
  currentScope,
  dialogButton,
  disconnect,
  enterProject,
  fillHost,
  fillName,
  newFromAside,
  openMenu,
  textOf,
  typeInto,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const PROJECT = 'Ops';
const BASTION = { ...HOST, name: 'bastion' };
const API_1 = { ...HOST, name: 'api-1' };
const API_2 = { ...HOST, name: 'api-2' };
const OLD = { ...HOST, name: 'old', hostname: '${db_host}' };
const VPS = { ...HOST, name: 'vps' };

const cards = () =>
  browser.execute(() =>
    [...document.querySelectorAll('[data-testid^="card-host-"]')].map((c) =>
      (c.getAttribute('data-testid') ?? '').slice('card-host-'.length),
    ),
  );

async function waitCards(expected: string[]): Promise<void> {
  await browser.waitUntil(async () => (await cards()).join(',') === expected.join(','), {
    timeout: 10000,
    timeoutMsg: `cards are not ${expected.join(', ')}`,
  });
}

const activeTestId = () =>
  browser.execute(() => document.activeElement?.getAttribute('data-testid') ?? '');

const cardStatus = async (name: string) => (await textOf(`card-status-${name}`)).trim();

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

async function cardMenu(name: string, option: string): Promise<void> {
  await clickId(`card-menu-${name}`);
  await clickId(option);
}

async function filterSidebar(text: string): Promise<void> {
  await typeInto('sidebar-filter', text);
}

describe('dashboards', () => {
  before(waitForApp);

  it('builds a project with nested collections and a host missing a variable', async () => {
    await createProject(PROJECT);
    await byId('project-empty').waitForDisplayed({ timeout: 10000 });
    await shot('dash-07-empty-project');
    await newFromAside('new-collection');
    await fillName('Backend');
    await openMenu('collection', 'Backend', 'menu-add-collection');
    await fillName('Legacy');
    await openMenu('collection', 'Backend', 'menu-add');
    await fillHost(API_1);
    await openMenu('collection', 'Backend', 'menu-add');
    await fillHost(API_2);
    await openMenu('collection', 'Legacy', 'menu-add');
    await fillHost(OLD);
    await createHost(PROJECT, BASTION);
  });

  it('shows the project hosts as cards grouped by collection path', async () => {
    await clickId('crumb-project');
    await byId('project-home').waitForDisplayed({ timeout: 10000 });
    await expect(byId('project-home-title')).toHaveText(PROJECT);
    await expect(byId('project-home-stats')).toHaveText('4 hosts · 2 collections');
    await expect(byId('project-tab-hosts')).toHaveElementClass('_active');
    await waitCards(['bastion', 'api-1', 'api-2', 'old']);
    await expect(byId('host-group-Ops')).toHaveText(expect.stringContaining('Ops (top level)'));
    await expect(byId('host-group-Ops/Backend/Legacy')).toHaveText(
      expect.stringContaining('Backend / Legacy'),
    );
    await expect(byId('card-address-bastion')).toHaveText('carapace@127.0.0.1:2223');
    await expect(byId('card-address-old')).toHaveText('Missing: db_host');
    await expect(byId('card-status-api-1')).toHaveText(expect.stringContaining('Not connected'));
  });

  it('connects from a card, then opens its terminal and files', async () => {
    await clickId('card-connect-bastion');
    await acceptHostKeyIfAsked(async () => (await cardStatus('bastion')) === 'Connected');
    await byId('card-terminal-bastion').waitForDisplayed({ timeout: 10000 });
    await clickId('card-connect-api-1');
    await acceptHostKeyIfAsked(async () => (await cardStatus('api-1')) === 'Connected');
    await expect(byId('project-home-stats')).toHaveText('4 hosts · 2 collections · 2 connected');
    await shot('dash-01-project-mixed');

    await clickId('card-files-api-1');
    await byId('files-panel').waitForDisplayed({ timeout: 10000 });
    expect(await activeTab()).toBe('tab-api-1-files');
    expect(await browser.getUrl()).toContain('/tabs/');
    await clickId('crumb-project');
    await clickId('card-terminal-bastion');
    await byId('terminal-view-1').waitForDisplayed({ timeout: 20000 });
    expect(await activeTab()).toBe('tab-bastion-terminal-1');
    await clickId('crumb-project');
    await clickId('card-terminal-bastion');
    await browser.waitUntil(async () => (await activeTab()) === 'tab-bastion-terminal-1', {
      timeout: 10000,
    });
    await expect(byId('tab-bastion-terminal-2')).not.toExist();
    await clickId('crumb-project');
    await byId('card-host-bastion').waitForDisplayed({ timeout: 10000 });
  });

  it('narrows the board with the search and the Connected switch', async () => {
    await typeInto('hosts-search', 'legacy');
    await waitCards(['old']);
    await expect(byId('hosts-count')).toHaveText('1 of 4 hosts');
    await typeInto('hosts-search', 'zzz');
    await byId('hosts-no-match').waitForDisplayed({ timeout: 10000 });
    await expect(byId('hosts-no-match')).toHaveText(expect.stringContaining('No host matches'));
    await shot('dash-03-search-no-match');
    await clickId('hosts-clear-search');
    await waitCards(['bastion', 'api-1', 'api-2', 'old']);
    await expect(await activeTestId()).toBe('hosts-search');

    await $('[data-testid="hosts-filter-connected"]').parentElement().click();
    await waitCards(['bastion', 'api-1']);
    await expect(byId('hosts-count')).toHaveText('2 of 4 hosts');
    await shot('dash-02-connected-filter');
    await $('[data-testid="hosts-filter-all"]').parentElement().click();
    await waitCards(['bastion', 'api-1', 'api-2', 'old']);
  });

  it('moves and deletes a host from its card menu', async () => {
    await cardMenu('api-2', 'menu-move');
    await byId('move-search').waitForDisplayed({ timeout: 10000 });
    await clickId(`move-target-${PROJECT}`);
    await clickId('move-submit');
    await waitGone('move-submit');
    await waitCards(['api-2', 'bastion', 'api-1', 'old']);

    await cardMenu('api-2', 'menu-delete');
    await confirmDelete();
    await waitCards(['bastion', 'api-1', 'old']);
  });

  it('keeps the Variables tab on a deep link and while edits are unsaved', async () => {
    await clickId('project-tab-variables');
    await byId('vars-add').waitForDisplayed({ timeout: 10000 });
    await expect(byId('vars-title')).not.toExist();
    await shot('dash-04-variables-tab');
    await browser.refresh();
    await waitForApp();
    await byId('vars-add').waitForDisplayed({ timeout: 20000 });
    await expect(byId('project-tab-variables')).toHaveElementClass('_active');

    await clickId('vars-add');
    await typeInto('var-name-0', 'db_host');
    await clickId('project-tab-hosts');
    const keep = $('//tui-dialog//button[contains(normalize-space(),"Keep editing")]');
    await keep.waitForClickable({ timeout: 10000 });
    await keep.click();
    await expect(byId('project-tab-variables')).toHaveElementClass('_active');
    await expect(byId('var-name-0')).toHaveValue('db_host');
    await clickId('project-tab-hosts');
    const discard = dialogButton('Discard');
    await discard.waitForClickable({ timeout: 10000 });
    await discard.click();
    await byId('card-host-bastion').waitForDisplayed({ timeout: 10000 });
    await expect(byId('project-tab-hosts')).toHaveElementClass('_active');
  });

  it('filters the sidebar, and Enter opens, connects and shows a terminal', async () => {
    await filterSidebar('old');
    await byId('tree-host-old').waitForDisplayed({ timeout: 10000 });
    await expect(byId('tree-collection-Legacy')).toHaveAttribute('aria-expanded', 'true');
    await expect(byId('tree-host-bastion')).not.toExist();
    await shot('dash-05-sidebar-filter');
    await browser.keys('Escape');
    await byId('tree-host-bastion').waitForExist({ timeout: 10000 });

    await filterSidebar('zzz');
    await byId('sidebar-no-match').waitForDisplayed({ timeout: 10000 });
    await shot('dash-06-sidebar-no-match');
    await clickId('sidebar-clear-filter');
    await byId('tree-host-bastion').waitForExist({ timeout: 10000 });

    await disconnect('bastion');
    await filterSidebar('bast');
    await browser.keys('Enter');
    await acceptHostKeyIfAsked(
      async () => (await activeTab())?.startsWith('tab-bastion-terminal-') ?? false,
    );
    await waitStatus('bastion', 'Connected');
    await expect(byId('sidebar-filter')).toHaveValue('');
    // The focus goes into the terminal, not the sidebar row.
    expect(await browser.execute(() => !!document.activeElement?.closest('.xterm'))).toBe(true);
  });

  it('focuses the filter with Ctrl+K, except inside a terminal', async () => {
    await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-testid="terminal-view-1"] textarea')?.focus(),
    );
    await browser.keys(['Control', 'k']);
    expect(await browser.execute(() => document.activeElement?.tagName.toLowerCase() ?? '')).toBe(
      'textarea',
    );
    await clickId('breadcrumbs');
    await browser.keys(['Control', 'k']);
    await browser.waitUntil(async () => (await activeTestId()) === 'sidebar-filter', {
      timeout: 5000,
      timeoutMsg: 'Ctrl+K did not focus the sidebar filter',
    });
    await browser.keys('Escape');
  });

  it('says when a project has collections but no host', async () => {
    await createProject('Blank');
    await byId('project-empty').waitForDisplayed({ timeout: 10000 });
    await clickId('project-home-new-collection');
    await fillName('Racks');
    await byId('project-no-hosts').waitForDisplayed({ timeout: 10000 });
    await shot('dash-08-no-hosts');
  });

  it('shows the projects first at Home, then the hosts outside projects', async () => {
    await createHost(null, VPS);
    await clickId('home-link');
    await byId('home-title').waitForDisplayed({ timeout: 10000 });
    await byId(`project-card-${PROJECT}`).waitForDisplayed({ timeout: 10000 });
    await expect(byId(`project-card-${PROJECT}`)).toHaveText(
      expect.stringContaining('3 hosts · 2 connected'),
    );
    await byId('home-new-project').waitForDisplayed({ timeout: 10000 });
    await byId('card-host-vps').waitForDisplayed({ timeout: 10000 });
    const order = await browser.execute(() =>
      [
        ...document.querySelectorAll(
          '[data-testid^="project-card-"], [data-testid="home-new-project"], [data-testid^="host-group-"]',
        ),
      ].map((e) => e.getAttribute('data-testid')),
    );
    expect(order).toEqual([
      'project-card-Blank',
      `project-card-${PROJECT}`,
      'home-new-project',
      'host-group-Home',
    ]);
    await shot('dash-09-home');

    await openMenu('host', 'vps', 'menu-delete');
    await confirmDelete();
    await waitGone('card-host-vps');
    await shot('dash-10-home-projects-only');

    await clickId(`project-card-${PROJECT}`);
    await browser.waitUntil(async () => (await currentScope()) === PROJECT, { timeout: 10000 });
    await expect(byId('project-home-title')).toHaveText(PROJECT);
  });

  it('keeps one column of cards and the header on one line at 900 px', async () => {
    const size = await browser.getWindowSize();
    try {
      await browser.setWindowSize(900, size.height);
      await enterProject(PROJECT);
      await byId('card-host-bastion').waitForDisplayed({ timeout: 10000 });
      await shot('dash-11-900px');
    } finally {
      await browser.setWindowSize(size.width, size.height);
    }
  });
});
