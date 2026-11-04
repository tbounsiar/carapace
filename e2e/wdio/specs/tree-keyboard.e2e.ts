import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  createHost,
  createProject,
  fillHost,
  fillName,
  newFromAside,
  openMenu,
  typeInto,
  waitForApp,
} from '../helpers/ui';

const A = { ...HOST, name: 'alpha' };
const B = { ...HOST, name: 'beta' };
const C = { ...HOST, name: 'gamma' };
const GROUP = 'group';

const focusedIn = (rowId: string) =>
  browser.execute((id: string) => {
    const active = document.activeElement;
    if (!active) return false;
    return (
      active.getAttribute('data-testid') === id || active.closest(`[data-testid="${id}"]`) !== null
    );
  }, rowId);

const expectFocus = async (rowId: string) => {
  await browser.waitUntil(() => focusedIn(rowId), {
    timeout: 3000,
    timeoutMsg: `focus is not on ${rowId}`,
  });
};

const expanded = async (name: string) =>
  (await byId(`tree-collection-${name}`).getAttribute('aria-expanded')) === 'true';

const expectExpanded = (name: string, value: boolean) =>
  browser.waitUntil(async () => (await expanded(name)) === value, {
    timeout: 3000,
    timeoutMsg: `collection ${name} is not ${value ? 'expanded' : 'collapsed'}`,
  });

const press = (key: string) => browser.keys(key);

const focusTestId = (id: string) =>
  browser.execute((value: string) => {
    (document.querySelector(`[data-testid="${value}"]`) as HTMLElement | null)?.focus();
  }, id);

describe('tree keyboard navigation', () => {
  before(async () => {
    await waitForApp();
    await createProject(PROJECT);
    await createHost(PROJECT, A);
    await createHost(PROJECT, B);
    await newFromAside('new-collection');
    await fillName(GROUP);
    await byId(`tree-collection-${GROUP}`).waitForExist({ timeout: 10000 });
    await openMenu('collection', GROUP, 'menu-add');
    await fillHost(C);
    if (await expanded(GROUP)) await clickId(`tree-collection-${GROUP}`);
    await expectExpanded(GROUP, false);
  });

  it('moves between rows with ArrowDown and ArrowUp', async () => {
    await focusTestId(`open-host-${A.name}`);
    await expectFocus(`tree-host-${A.name}`);
    await press('ArrowDown');
    await expectFocus(`tree-host-${B.name}`);
    await press('ArrowDown');
    await expectFocus(`tree-host-${B.name}`);
    await press('ArrowUp');
    await expectFocus(`tree-host-${A.name}`);
    await press('ArrowUp');
    await expectFocus(`tree-collection-${GROUP}`);
    await screenshotThemes('keyboard-01-focus', { keepFocus: true });
    await expectFocus(`tree-collection-${GROUP}`);
  });

  it('expands and collapses a collection with ArrowRight and ArrowLeft', async () => {
    await press('ArrowRight');
    await expectExpanded(GROUP, true);
    await expectFocus(`tree-collection-${GROUP}`);
    await press('ArrowRight');
    await expectFocus(`tree-host-${C.name}`);
    await press('ArrowRight');
    await expectFocus(`tree-host-${C.name}`);
    await press('ArrowLeft');
    await expectFocus(`tree-collection-${GROUP}`);
    await press('ArrowLeft');
    await expectExpanded(GROUP, false);
    await screenshotThemes('keyboard-02-collapsed', { keepFocus: true });
  });

  it('jumps with Home and End', async () => {
    await press('End');
    await expectFocus(`tree-host-${B.name}`);
    await press('Home');
    await expectFocus(`tree-collection-${GROUP}`);
    await press('ArrowUp');
    await expectFocus('sidebar-filter');
  });

  it('keeps a single tab stop in the tree', async () => {
    const tabStops = await browser.execute(
      () =>
        [...document.querySelectorAll('app-sidebar-tree [data-item]')].filter(
          (el) => (el as HTMLElement).tabIndex === 0,
        ).length,
    );
    expect(tabStops).toBe(1);
  });

  it('does not steal arrow keys from a dialog input', async () => {
    await newFromAside('new-host');
    const input = byId('host-name');
    await input.waitForDisplayed({ timeout: 10000 });
    await typeInto('host-name', 'abc');
    await press('ArrowLeft');
    await press('ArrowDown');
    expect(await input.getValue()).toBe('abc');
    await byId('dialog-cancel').click();
  });
});
