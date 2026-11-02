import { ENV, HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  createEnv,
  createHost,
  createProject,
  rowAction,
  typeInto,
  waitForApp,
} from '../helpers/ui';

const A = { ...HOST, name: 'alpha' };
const B = { ...HOST, name: 'beta' };

const focusedIn = (rowId: string) =>
  browser.execute((id: string) => {
    const active = document.activeElement;
    if (!active) return false;
    return (
      active.closest('[data-testid]')?.getAttribute('data-testid') === id ||
      active.getAttribute('data-testid') === id ||
      active.closest(`[data-testid="${id}"]`) !== null
    );
  }, rowId);

const expectFocus = async (rowId: string) => {
  await browser.waitUntil(() => focusedIn(rowId), {
    timeout: 3000,
    timeoutMsg: `focus is not on ${rowId}`,
  });
};

const expectExpanded = (rowId: string, value: string) =>
  browser.waitUntil(async () => (await byId(rowId).getAttribute('data-expanded')) === value, {
    timeout: 3000,
    timeoutMsg: `${rowId} is not data-expanded=${value}`,
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
    await createEnv(PROJECT, ENV);
    await createHost(ENV, A);
    await createHost(ENV, B);
    for (const row of [`tree-project-${PROJECT}`, `tree-env-${ENV}`]) {
      if (!(await byId(`tree-host-${B.name}`).isExisting())) await byId(row).click();
    }
    await byId(`tree-host-${B.name}`).waitForExist({ timeout: 5000 });
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
    await screenshotThemes('keyboard-01-focus');
  });

  it('collapses and expands with ArrowLeft and ArrowRight', async () => {
    await press('ArrowLeft');
    await expectFocus(`tree-env-${ENV}`);
    await press('ArrowLeft');
    await expectExpanded(`tree-env-${ENV}`, 'false');
    await screenshotThemes('keyboard-02-collapsed');
    await press('ArrowRight');
    await expectExpanded(`tree-env-${ENV}`, 'true');
    await expectFocus(`tree-env-${ENV}`);
    await press('ArrowRight');
    await expectFocus(`tree-host-${A.name}`);
    await press('ArrowRight');
    await expectFocus(`tree-host-${A.name}`);
  });

  it('jumps with Home and End', async () => {
    await press('Home');
    await expectFocus(`tree-project-${PROJECT}`);
    await press('ArrowUp');
    await expectFocus(`tree-project-${PROJECT}`);
    await press('End');
    await expectFocus(`tree-host-${B.name}`);
  });

  it('does not steal arrow keys from a dialog input', async () => {
    await rowAction(`tree-env-${ENV}`, `add-env-${ENV}`);
    const input = byId('host-name');
    await input.waitForDisplayed({ timeout: 10000 });
    await typeInto('host-name', 'abc');
    await press('ArrowLeft');
    await press('ArrowDown');
    expect(await input.getValue()).toBe('abc');
    await byId('dialog-cancel').click();
  });
});
