import { HOST } from '../helpers/fixture';
import { screenshotThemes, shotWithMenu } from '../helpers/screenshot';
import {
  byId,
  clickId,
  confirmDialog,
  connect,
  createHost,
  createProject,
  currentScope,
  dialogButton,
  enterProject,
  fillHost,
  fillName,
  goHome,
  newFromAside,
  openMenu,
  textOf,
  tid,
  typeInto,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const PROJECT = 'Payments';
const VPS = { ...HOST, name: 'vps' };
const PI = { ...HOST, name: 'pi' };
const API = { ...HOST, name: 'api' };

const pageText = () => browser.execute(() => document.body.innerText);

async function waitText(text: string): Promise<void> {
  await browser.waitUntil(async () => (await pageText()).includes(text), {
    timeout: 10000,
    timeoutMsg: `page never showed "${text}"`,
  });
}

/** The collection a host or collection item sits in, by its head test id; '' at the scope root. */
const parentOf = (id: string) =>
  browser.execute((value: string) => {
    const item = document.querySelector(`[data-testid="${value}"]`);
    const group = item?.closest('tui-expand')?.closest('tui-aside-group');
    const head = group?.querySelector('[data-testid^="tree-collection-"]');
    return head?.getAttribute('data-testid')?.replace('tree-collection-', '') ?? '';
  }, id);

async function waitParent(id: string, parent: string): Promise<void> {
  await browser.waitUntil(async () => (await parentOf(id)) === parent, {
    timeout: 10000,
    timeoutMsg: `${id} is not inside "${parent}"`,
  });
}

const crumbs = () =>
  browser.execute(() =>
    [...document.querySelectorAll('[data-testid^="crumb-"]')]
      .map((el) => (el as HTMLElement).innerText.trim())
      .filter(Boolean),
  );

async function waitCrumbs(expected: string[]): Promise<void> {
  await browser.waitUntil(async () => (await crumbs()).join(' / ') === expected.join(' / '), {
    timeout: 10000,
    timeoutMsg: `breadcrumbs are not ${expected.join(' / ')}`,
  });
}

const expanded = async (name: string) =>
  (await byId(`tree-collection-${name}`).getAttribute('aria-expanded')) === 'true';

async function expand(name: string): Promise<void> {
  if (!(await expanded(name))) await clickId(`tree-collection-${name}`);
  await browser.waitUntil(() => expanded(name), { timeout: 5000 });
}

async function newCollectionIn(parent: string, name: string): Promise<void> {
  await openMenu('collection', parent, 'menu-add-collection');
  await fillName(name);
  await byId(`tree-collection-${name}`).waitForExist({ timeout: 10000 });
}

const focus = (id: string) =>
  browser.execute((value: string) => {
    document.querySelector<HTMLElement>(`[data-testid="${value}"]`)?.focus();
  }, id);

type DragWindow = Window & { __drag?: DataTransfer };

/**
 * HTML5 drag and drop with one shared DataTransfer (WebDriver does not drive WebView2 drags).
 * Starts the drag and hovers the target; `dropOn` finishes it, so the highlight can be checked.
 */
const dragOver = (source: string, target: string) =>
  browser.execute(
    (s: string, t: string) => {
      const from = document.querySelector(s);
      const to = document.querySelector(t);
      if (!from || !to) throw new Error('drag source or target missing');
      const dataTransfer = new DataTransfer();
      (window as DragWindow).__drag = dataTransfer;
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      fire(from, 'dragstart');
      fire(to, 'dragenter');
      return !fire(to, 'dragover');
    },
    tid(source),
    tid(target),
  );

const dropOn = (source: string, target: string) =>
  browser.execute(
    (s: string, t: string) => {
      const dataTransfer = (window as DragWindow).__drag;
      const fire = (el: Element | null, type: string) =>
        el?.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      fire(document.querySelector(t), 'drop');
      fire(document.querySelector(s), 'dragend');
    },
    tid(source),
    tid(target),
  );

const dropHighlighted = (target: string) =>
  browser.execute(
    (t: string) => !!document.querySelector(t)?.closest('[data-drop-target="true"]'),
    tid(target),
  );

async function moveWithDialog(host: string, target: string): Promise<void> {
  await openMenu('host', host, 'menu-move');
  await byId('move-search').waitForDisplayed({ timeout: 10000 });
  await clickId(`move-target-${target}`);
}

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

describe('collections', () => {
  before(waitForApp);

  it('starts on an empty Home', async () => {
    await expect(byId('project-select')).toHaveText('Home');
    await expect(byId('sidebar-empty')).toHaveText(expect.stringContaining('Nothing here yet'));
    await byId('welcome-new-project').waitForDisplayed({ timeout: 10000 });
    await expect(byId('project-variables')).not.toExist();
    await shot('coll-01-home-empty');
  });

  it('creates collections three levels deep', async () => {
    await newFromAside('new-collection');
    await fillName('Lab');
    await byId('tree-collection-Lab').waitForExist({ timeout: 10000 });
    await newCollectionIn('Lab', 'Rack');
    await newCollectionIn('Rack', 'Shelf');
    await waitParent('tree-collection-Rack', 'Lab');
    await waitParent('tree-collection-Shelf', 'Rack');
    await byId('empty-add-Shelf').waitForDisplayed({ timeout: 10000 });
  });

  it('adds a host at Home and one inside the deepest collection', async () => {
    await createHost(null, VPS);
    await waitParent('tree-host-vps', '');
    await openMenu('collection', 'Shelf', 'menu-add');
    await expect(byId('host-location')).toHaveText(
      expect.stringContaining('Home / Lab / Rack / Shelf'),
    );
    await fillHost(PI);
    await waitParent('tree-host-pi', 'Shelf');
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await waitCrumbs(['Home', 'Lab', 'Rack', 'Shelf', 'pi']);
    await expect(byId('host-detail-address')).toHaveText('carapace@127.0.0.1:2223');
    await shot('coll-02-host-page');
  });

  it('renames from the menu and with F2', async () => {
    await openMenu('collection', 'Rack', 'menu-edit');
    await fillName('Rack-1');
    await byId('tree-collection-Rack-1').waitForExist({ timeout: 10000 });
    await focus('tree-collection-Shelf');
    await browser.keys('F2');
    await byId('name-input').waitForDisplayed({ timeout: 10000 });
    await expect(byId('name-input')).toHaveValue('Shelf');
    await fillName('Shelf-A');
    await byId('tree-collection-Shelf-A').waitForExist({ timeout: 10000 });
    await waitCrumbs(['Home', 'Lab', 'Rack-1', 'Shelf-A', 'pi']);
  });

  it('creates a project with a host, listed at Home', async () => {
    await createProject(PROJECT);
    await byId('project-empty').waitForDisplayed({ timeout: 10000 });
    await createHost(PROJECT, API);
    await goHome();
    await byId(`tree-project-${PROJECT}`).waitForDisplayed({ timeout: 10000 });
    await expect(byId('tree-host-api')).not.toExist();
    await expand('Lab');
    await shot('coll-03-home-collections-projects');
    await shotWithMenu('coll-03b-project-selector', 'project-select', 'project-option-new');
    await shotWithMenu('coll-03c-new-menu', 'aside-new', 'new-project');
  });

  it('enters and leaves a project in every way', async () => {
    await byId(`tree-project-${PROJECT}`).doubleClick();
    await browser.waitUntil(async () => (await currentScope()) === PROJECT, { timeout: 10000 });
    await byId('project-home').waitForDisplayed({ timeout: 10000 });
    await waitCrumbs(['Home', PROJECT]);
    await expect(byId('aside-project')).toHaveText(expect.stringContaining(PROJECT));
    await expect(byId('tree-collection-Lab')).not.toExist();
    await shot('coll-04-project-home');

    await clickId('crumb-home');
    await browser.waitUntil(async () => (await currentScope()) === 'Home', { timeout: 10000 });
    await expect(byId(`tree-project-${PROJECT}`)).not.toHaveAttribute('data-state');
    await expect(byId(`tree-project-${PROJECT}`)).toHaveAttribute('tabindex', '0');

    await enterProject(PROJECT);
    await focus('open-host-api');
    await browser.keys(['Alt', 'ArrowUp']);
    await browser.waitUntil(async () => (await currentScope()) === 'Home', { timeout: 10000 });
    await browser.waitUntil(
      () =>
        browser.execute(
          (id: string) => document.activeElement?.getAttribute('data-testid') === id,
          `tree-project-${PROJECT}`,
        ),
      { timeout: 5000, timeoutMsg: 'the project left was not focused' },
    );
    await browser.keys('Enter');
    await browser.waitUntil(async () => (await currentScope()) === PROJECT, { timeout: 10000 });
  });

  it('offers project variables inside the project only', async () => {
    await clickId('project-variables');
    await expect(byId('vars-title')).toHaveText(`${PROJECT}: variables`);
    await goHome();
    await expect(byId('project-variables')).not.toExist();
  });

  it('moves a host within Home and undoes it', async () => {
    await moveWithDialog('pi', 'Home/Lab');
    await expect(byId('move-target-Home/Lab/Rack-1/Shelf-A')).toBeDisabled();
    await expect(byId('move-warning')).not.toExist();
    await clickId('move-submit');
    await waitGone('move-submit');
    await waitParent('tree-host-pi', 'Lab');
    await byId('move-undo').waitForExist({ timeout: 5000 });
    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-testid="move-undo"]')?.click(),
    );
    await waitText('Move undone');
    await waitParent('tree-host-pi', 'Shelf-A');
  });

  it('moves a host into a project after the warning', async () => {
    await moveWithDialog('pi', PROJECT);
    const warning = byId('move-warning');
    await warning.waitForDisplayed({ timeout: 10000 });
    await expect(warning).toHaveText(expect.stringContaining('Moving into a project'));
    await expect(warning).toHaveText(expect.stringContaining('saved passwords are forgotten'));
    await shot('coll-06-move-warning');
    await clickId('move-submit');
    await waitGone('move-submit');
    await waitText(`Moved “pi” to ${PROJECT}`);
    await waitGone('tree-host-pi');
    await enterProject(PROJECT);
    await byId('tree-host-pi').waitForExist({ timeout: 10000 });
    await goHome();
  });

  it('drags a host into a collection', async () => {
    // dragover is cancelled (drop allowed) and the target is highlighted while hovered.
    expect(await dragOver('open-host-vps', 'tree-collection-Lab')).toBe(true);
    await browser.waitUntil(() => dropHighlighted('tree-collection-Lab'), {
      timeout: 5000,
      timeoutMsg: 'the drop target was not highlighted',
    });
    await shot('coll-07-drag-over');
    await dropOn('open-host-vps', 'tree-collection-Lab');
    await waitParent('tree-host-vps', 'Lab');
  });

  it('connects a Home host', async () => {
    await connect(VPS.name);
    await acceptHostKeyIfAsked(
      async () => (await byId('status-host-vps').getAttribute('aria-label')) === 'Connected',
    );
    await waitStatus(VPS.name, 'Connected');
    await clickId('open-host-vps');
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await expect(byId('host-detail-title')).toHaveText(VPS.name);
    await clickId('terminal-new');
    await byId('terminal-tab-1').waitForDisplayed({ timeout: 20000 });
    expect(await textOf('terminal-tab-1')).toBe('Terminal 1');
    await shot('coll-08-home-host-connected');
  });

  it('deletes with the Delete key and counts the contents recursively', async () => {
    await newFromAside('new-collection');
    await fillName('Tmp');
    await byId('tree-collection-Tmp').waitForExist({ timeout: 10000 });
    await focus('tree-collection-Tmp');
    await browser.keys('Delete');
    await waitText('“Tmp” is empty.');
    await confirmDialog('Delete');
    await waitGone('tree-collection-Tmp');

    await openMenu('collection', 'Lab', 'menu-delete');
    await dialogButton('Delete').waitForClickable({ timeout: 10000 });
    await waitText('“Lab” contains 2 collections and 1 host.');
    await shot('coll-09-delete-confirm');
    await confirmDialog('Delete');
    await waitGone('tree-collection-Lab');
    await waitGone('tree-host-vps');
    await byId('welcome').waitForDisplayed({ timeout: 10000 });
  });

  it('filters the Move dialog and cancels it', async () => {
    await enterProject(PROJECT);
    await moveWithDialog('api', 'Home');
    await typeInto('move-search', 'zzz');
    await waitText('No location matches “zzz”.');
    await clickId('dialog-cancel');
    await waitGone('move-search');
    await waitParent('tree-host-api', '');
  });
});
