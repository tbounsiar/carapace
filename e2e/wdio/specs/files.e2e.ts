import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { HOST, PROJECT } from '../helpers/fixture';
import {
  closeContextMenu,
  contextMenu,
  menuEdges,
  openDropdowns,
  shotContextMenu,
} from '../helpers/context-menu';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  confirmDelete,
  createHost,
  createProject,
  dialogButton,
  remoteSh,
  tid,
  typeInto,
  waitForApp,
  waitGone,
  tabMenu,
  waitActiveTab,
  waitStatus,
} from '../helpers/ui';

type Side = 'local' | 'remote';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const dirName = `carapace-e2e-${randomBytes(4).toString('hex')}`;
const dirPath = join(homedir(), dirName);

const pane = (side: Side) => $(tid(`pane-${side}`));
const inPane = (side: Side, id: string) => $(`${tid(`pane-${side}`)} ${tid(id)}`);
const entry = (side: Side, name: string) => inPane(side, `entry-${name}`);

async function paneClick(side: Side, id: string): Promise<void> {
  const el = inPane(side, id);
  await el.waitForClickable({ timeout: 10000 });
  await el.click();
}

async function waitEntry(side: Side, name: string, present = true): Promise<void> {
  await entry(side, name).waitForExist({
    timeout: 15000,
    reverse: !present,
    timeoutMsg: `${side} entry ${name} ${present ? 'never appeared' : 'never went away'}`,
  });
}

async function openEntry(side: Side, name: string): Promise<void> {
  const el = entry(side, name);
  await el.waitForExist({ timeout: 15000 });
  await el.scrollIntoView({ block: 'center' });
  await el.doubleClick();
}

async function pathText(side: Side): Promise<string> {
  return (await inPane(side, 'pane-path').getText()).replace(/\s+/g, ' ').trim();
}

async function waitPath(side: Side, part: string): Promise<void> {
  await browser.waitUntil(async () => (await pathText(side)).includes(part), {
    timeout: 15000,
    timeoutMsg: `${side} path never showed "${part}"`,
  });
}

async function rowMenu(side: Side, name: string, option: string): Promise<void> {
  await entry(side, name).moveTo();
  await paneClick(side, `entry-menu-${name}`);
  await clickId(option);
}

async function mkdir(side: Side, name: string): Promise<void> {
  await paneClick(side, 'pane-mkdir');
  await typeInto('name-input', name);
  await clickId('dialog-save');
  await waitGone('name-input');
  await waitEntry(side, name);
}

async function rename(side: Side, from: string, to: string): Promise<void> {
  await rowMenu(side, from, 'entry-rename');
  await typeInto('name-input', to);
  await clickId('dialog-save');
  await waitGone('name-input');
  await waitEntry(side, to);
  await waitEntry(side, from, false);
}

async function remove(side: Side, name: string): Promise<void> {
  await rowMenu(side, name, 'entry-delete');
  await confirmDelete();
  await waitEntry(side, name, false);
}

async function setHidden(side: Side, on: boolean): Promise<void> {
  const toggle = inPane(side, 'pane-hidden');
  await toggle.waitForClickable({ timeout: 10000 });
  if (((await toggle.getAttribute('aria-pressed')) === 'true') !== on) await toggle.click();
  await browser.waitUntil(
    async () => ((await toggle.getAttribute('aria-pressed')) === 'true') === on,
    { timeout: 5000 },
  );
}

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

const pageScrolls = () =>
  browser.execute(
    () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
  );

describe('file explorer', () => {
  before(async () => {
    mkdirSync(dirPath);
    writeFileSync(join(dirPath, 'visible.txt'), 'carapace e2e\n');
    writeFileSync(join(dirPath, '.dot'), 'hidden\n');
    await waitForApp();
  });

  after(() => {
    rmSync(dirPath, { recursive: true, force: true });
  });

  it('opens the Files view and connects the remote pane', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT);
    await clickId(`open-host-${HOST.name}`);
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await clickId('host-open-files');
    await byId('files-panel').waitForDisplayed({ timeout: 10000 });
    await waitActiveTab(`tab-${HOST.name}-files`);
    await inPane('remote', 'pane-connect').waitForDisplayed({ timeout: 10000 });
    await pane('local').waitForDisplayed({ timeout: 10000 });
    await shot('files-01-disconnected');
    await paneClick('remote', 'pane-connect');
    await acceptHostKeyIfAsked();
    await waitStatus(HOST.name, 'Connected');
    await inPane('remote', 'pane-path').waitForDisplayed({ timeout: 20000 });
    await browser.pause(500);
    await shot('files-02-connected');
    expect(await pageScrolls()).toBe(false);
  });

  it('browses the local pane and toggles hidden files', async () => {
    const home = basename(homedir());
    await waitPath('local', home);
    await openEntry('local', dirName);
    await waitPath('local', dirName);
    await waitEntry('local', 'visible.txt');
    await expect(entry('local', '.dot')).not.toExist();
    await shot('files-03-local-dir');
    await setHidden('local', true);
    await waitEntry('local', '.dot');
    await shot('files-04-local-hidden');
    await setHidden('local', false);
    await waitEntry('local', '.dot', false);
    const crumb = inPane('local', 'pane-path').$(`button=${home}`);
    await crumb.waitForClickable({ timeout: 10000 });
    await crumb.click();
    await waitEntry('local', dirName);
    await expect(entry('local', 'visible.txt')).not.toExist();
  });

  it('creates, renames, opens and deletes a remote folder', async () => {
    await mkdir('remote', 'e2e-dir');
    await shot('files-05-remote-mkdir');
    await rename('remote', 'e2e-dir', 'e2e-renamed');
    await openEntry('remote', 'e2e-renamed');
    await waitPath('remote', 'e2e-renamed');
    await shot('files-06-remote-inside');
    await paneClick('remote', 'pane-up');
    await waitEntry('remote', 'e2e-renamed');
    await remove('remote', 'e2e-renamed');
    await shot('files-07-remote-deleted');
    await expect(entry('remote', '.ssh')).not.toExist();
    await setHidden('remote', true);
    await waitEntry('remote', '.ssh');
    await shot('files-08-remote-hidden');
    await setHidden('remote', false);
  });

  it('creates, renames and deletes inside the local temp dir', async () => {
    await openEntry('local', dirName);
    await waitPath('local', dirName);
    await mkdir('local', 'local-dir');
    await rename('local', 'local-dir', 'local-renamed');
    await shot('files-09-local-renamed');
    await remove('local', 'local-renamed');
    await waitEntry('local', 'visible.txt');
    await shot('files-10-local-deleted');
  });

  describe('context menus', () => {
    const ctxDir = `${dirName}-ctx`;
    const scroll = (side: Side) => $(`${tid(`pane-${side}`)} .scroll`);
    const pointer = async (el: ChainablePromiseElement, dx = 0) => {
      const { x } = await el.getLocation();
      const { width } = await el.getSize();
      return x + width / 2 + dx;
    };
    const rightClick = async (side: Side, name: string, dx = 0) => {
      const el = entry(side, name);
      await el.scrollIntoView({ block: 'center' });
      await el.click({ button: 'right', x: dx });
    };
    const ctrlClick = async (side: Side, name: string) => {
      const el = entry(side, name);
      await browser.actions([
        browser.action('key').down('').pause(0).pause(0).pause(0).up(''),
        browser
          .action('pointer')
          .move({ origin: await el })
          .down()
          .up(),
      ]);
    };
    const below = async (side: Side) => {
      const { height } = await scroll(side).getSize();
      await scroll(side).click({ button: 'right', y: Math.round(height / 2) - 12 });
    };

    // Mocha runs this block after the parent's own tests, the last of which disconnects.
    before(async () => {
      if (
        !(await byId('files-panel')
          .isDisplayed()
          .catch(() => false))
      ) {
        await clickId(`tab-${HOST.name}-files`);
        await byId('files-panel').waitForDisplayed({ timeout: 10000 });
      }
      if (await inPane('remote', 'pane-connect').isExisting()) {
        await paneClick('remote', 'pane-connect');
        await acceptHostKeyIfAsked();
        await waitStatus(HOST.name, 'Connected');
      }
      await inPane('remote', 'pane-path').waitForDisplayed({ timeout: 20000 });
      if (!(await pathText('local')).includes(dirName)) {
        await openEntry('local', dirName);
        await waitPath('local', dirName);
      }
    });

    // Each test starts from a.txt, b.txt and c.txt listed in the remote folder, no menu open.
    beforeEach(async () => {
      if (await contextMenu('file-row').isExisting()) await browser.keys('Escape');
      remoteSh(
        `rm -rf ~/${ctxDir} && mkdir -p ~/${ctxDir} && for f in a.txt b.txt c.txt; do echo "$f" > ~/${ctxDir}/$f; done`,
      );
      for (const name of ['b.txt', 'c.txt']) rmSync(join(dirPath, name), { force: true });
      if (!(await pathText('remote')).includes(ctxDir)) {
        const home = inPane('remote', 'pane-path').$('button=carapace');
        if (await home.isExisting()) await home.click();
        await waitEntry('remote', ctxDir);
        await openEntry('remote', ctxDir);
        await waitPath('remote', ctxDir);
      }
      await paneClick('remote', 'pane-refresh');
      await waitEntry('remote', 'a.txt');
      await waitEntry('remote', 'b.txt');
      await waitEntry('remote', 'c.txt');
      await paneClick('local', 'pane-refresh');
      await waitEntry('local', 'b.txt', false);
    });

    after(() => {
      try {
        remoteSh(`rm -rf ~/${ctxDir}`);
      } catch {
        // the container may be gone
      }
    });

    it('opens the row menu at the pointer and renames from it', async () => {
      // The left part of the row is far enough from the window's right edge to open rightwards.
      const { width } = await entry('remote', 'a.txt').getSize();
      const left = 48 - Math.round(width / 2);
      await rightClick('remote', 'a.txt', left);
      await contextMenu('file-row').waitForDisplayed({ timeout: 5000 });
      expect(await openDropdowns()).toBe(1);
      expect(await inPane('remote', 'entry-a.txt').getAttribute('aria-selected')).toBe('true');
      const start = await menuEdges('file-row');
      expect(Math.abs(start.left - (await pointer(entry('remote', 'a.txt'), left)))).toBeLessThan(
        8,
      );
      await expect(byId('entry-edit')).toExist();
      await expect(byId('entry-copy-path')).toExist();
      await closeContextMenu('file-row');
      await shotContextMenu('ctx-01-file-row', 'file-row', () =>
        rightClick('remote', 'a.txt', left),
      );

      // Near the right edge the menu grows leftwards instead of being squeezed.
      const dx = Math.round(width / 2) - 24;
      await rightClick('remote', 'a.txt', dx);
      await contextMenu('file-row').waitForDisplayed({ timeout: 5000 });
      const end = await menuEdges('file-row');
      expect(Math.abs(end.right - (await pointer(entry('remote', 'a.txt'), dx)))).toBeLessThan(8);
      await closeContextMenu('file-row');
      await shotContextMenu('ctx-04-remote-right-edge', 'file-row', () =>
        rightClick('remote', 'a.txt', dx),
      );

      await rightClick('remote', 'a.txt');
      await clickId('entry-rename');
      await typeInto('name-input', 'renamed.txt');
      await clickId('dialog-save');
      await waitGone('name-input');
      await waitEntry('remote', 'renamed.txt');
    });

    it('acts on a Ctrl+click selection: "2 selected", Download to local', async () => {
      await entry('remote', 'b.txt').click();
      await ctrlClick('remote', 'c.txt');
      await rightClick('remote', 'c.txt');
      await contextMenu('file-row').waitForDisplayed({ timeout: 5000 });
      expect(await byId('entry-menu-count').getAttribute('data-label')).toBe('2 selected');
      expect(await inPane('remote', 'entry-b.txt').getAttribute('aria-selected')).toBe('true');
      await closeContextMenu('file-row');
      await shotContextMenu('ctx-02-file-multi', 'file-row', () => rightClick('remote', 'c.txt'));
      await rightClick('remote', 'c.txt');
      await clickId('entry-transfer');
      await waitEntry('local', 'b.txt');
      await waitEntry('local', 'c.txt');
    });

    it('opens the folder menu on the empty area and toggles hidden files', async () => {
      await below('remote');
      await contextMenu('file-pane').waitForDisplayed({ timeout: 5000 });
      expect(await byId('pane-menu-hidden').getAttribute('aria-checked')).toBe('false');
      await closeContextMenu('file-pane');
      await shotContextMenu('ctx-03-pane-empty', 'file-pane', () => below('remote'));
      await below('remote');
      await clickId('pane-menu-hidden');
      await browser.waitUntil(
        async () => (await inPane('remote', 'pane-hidden').getAttribute('aria-pressed')) === 'true',
        { timeout: 5000, timeoutMsg: 'the folder menu did not show hidden files' },
      );
      await setHidden('remote', false);
    });

    it('keeps one menu open: the "…" closes on a right click, breadcrumbs open nothing', async () => {
      await entry('remote', 'a.txt').moveTo();
      await paneClick('remote', 'entry-menu-a.txt');
      await byId('entry-rename').waitForDisplayed({ timeout: 5000 });
      await rightClick('remote', 'a.txt');
      await contextMenu('file-row').waitForDisplayed({ timeout: 5000 });
      expect(await openDropdowns()).toBe(1);

      await inPane('remote', 'pane-path').click({ button: 'right' });
      await contextMenu('file-row').waitForExist({ timeout: 5000, reverse: true });
      expect(await openDropdowns()).toBe(0);
    });

    it('opens the row "…" with Shift+F10', async () => {
      await entry('remote', 'a.txt').click();
      await browser.keys(['Shift', 'F10']);
      await browser.waitUntil(
        async () =>
          (await inPane('remote', 'entry-menu-a.txt').getAttribute('aria-expanded')) === 'true',
        { timeout: 5000, timeoutMsg: 'Shift+F10 did not open the row menu' },
      );
      await browser.keys('Escape');
      await byId('entry-rename').waitForExist({ timeout: 5000, reverse: true });
    });

    it('deletes a selection after one confirm', async () => {
      await entry('remote', 'b.txt').click();
      await ctrlClick('remote', 'a.txt');
      await browser.keys('Delete');
      await dialogButton('Delete').waitForClickable({ timeout: 10000 });
      await shot('ctx-12-multi-delete-confirm');
      await confirmDelete();
      await waitEntry('remote', 'b.txt', false);
      await waitEntry('remote', 'a.txt', false);
      await waitEntry('remote', 'c.txt');
    });
  });

  it('keeps pane paths across navigation and resets the remote pane on disconnect', async () => {
    const local = await pathText('local');
    await clickId('crumb-host');
    await byId('files-panel').waitForExist({ timeout: 10000, reverse: true });
    await byId(`host-tab-${HOST.name}-files`).waitForDisplayed({ timeout: 10000 });
    await clickId(`tab-${HOST.name}-files`);
    await byId('files-panel').waitForDisplayed({ timeout: 10000 });
    await inPane('local', 'pane-path').waitForDisplayed({ timeout: 10000 });
    await inPane('remote', 'pane-path').waitForDisplayed({ timeout: 10000 });
    expect(await pathText('local')).toBe(local);
    await waitEntry('local', 'visible.txt');
    await shot('files-11-back-from-terminal');
    await tabMenu(`tab-${HOST.name}-files`, 'tab-menu-disconnect');
    await inPane('remote', 'pane-connect').waitForDisplayed({ timeout: 10000 });
    await shot('files-12-disconnected-again');
  });
});
