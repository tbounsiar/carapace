import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  confirmDelete,
  createHost,
  createProject,
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
