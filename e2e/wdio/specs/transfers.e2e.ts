import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  createHost,
  createProject,
  tid,
  typeInto,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

type Side = 'local' | 'remote';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const suffix = randomBytes(4).toString('hex');
const srcName = `carapace-e2e-tx-${suffix}`;
const dstName = `carapace-e2e-tx-${suffix}-dl`;
const remoteName = `carapace-e2e-tx-${suffix}`;
const srcDir = join(homedir(), srcName);
const dstDir = join(homedir(), dstName);
const CTRL = '';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const inPane = (side: Side, id: string) => $(`${tid(`pane-${side}`)} ${tid(id)}`);
const entry = (side: Side, name: string) => inPane(side, `entry-${name}`);

async function paneClick(side: Side, id: string): Promise<void> {
  const el = inPane(side, id);
  await el.waitForClickable({ timeout: 10000 });
  await el.click();
}

async function waitEntry(side: Side, name: string, present = true): Promise<void> {
  await entry(side, name).waitForExist({
    timeout: 20000,
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

async function waitPath(side: Side, part: string): Promise<void> {
  await browser.waitUntil(
    async () => (await inPane(side, 'pane-path').getText()).replace(/\s+/g, ' ').includes(part),
    { timeout: 15000, timeoutMsg: `${side} path never showed "${part}"` },
  );
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

async function homeCrumb(): Promise<void> {
  const home = homedir().split(/[\\/]/).pop() as string;
  const crumb = inPane('local', 'pane-path').$(`button=${home}`);
  await crumb.waitForClickable({ timeout: 10000 });
  await crumb.click();
}

async function selectEntries(side: Side, names: string[], ctrl = false): Promise<void> {
  for (const [i, name] of names.entries()) {
    const el = entry(side, name);
    await el.waitForExist({ timeout: 15000 });
    await el.scrollIntoView({ block: 'center' });
    if (i === 0 && !ctrl) {
      await el.click();
      continue;
    }
    await browser.actions([
      browser.action('key').down(CTRL).pause(0).pause(0).pause(0).up(CTRL),
      browser
        .action('pointer')
        .move({ origin: await el })
        .down()
        .up(),
    ]);
  }
}

async function expandPanel(): Promise<void> {
  const toggle = byId('transfer-toggle');
  await toggle.waitForClickable({ timeout: 10000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

// The same name can have several rows (upload then download); `count` waits for that many.
async function waitState(name: string, text: string, count = 1): Promise<void> {
  await browser.waitUntil(
    async () => {
      const states = await $$(tid(`transfer-state-${name}`)).map((e) => e.getText());
      return states.filter((s) => s.trim().startsWith(text)).length >= count;
    },
    { timeout: 60000, timeoutMsg: `transfer ${name} never reached "${text}"` },
  );
}

async function dragAndDrop(fromSide: Side, name: string, toSide: Side): Promise<void> {
  await browser.execute(
    (from: string, file: string, to: string) => {
      const row = document.querySelector(`[data-testid="${from}"] [data-testid="entry-${file}"]`);
      const target = document.querySelector(`[data-testid="${to}"] .scroll`);
      if (!row || !target) throw new Error('drag source or target missing');
      const dt = new DataTransfer();
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer: dt,
          }),
        );
      fire(row, 'dragstart');
      fire(target, 'dragenter');
      fire(target, 'dragover');
      fire(target, 'drop');
      fire(row, 'dragend');
    },
    `pane-${fromSide}`,
    name,
    `pane-${toSide}`,
  );
}

describe('file transfers', () => {
  before(async () => {
    mkdirSync(srcDir);
    mkdirSync(dstDir);
    writeFileSync(join(srcDir, 'a.txt'), 'carapace transfer\n');
    writeFileSync(join(srcDir, 'b.bin'), randomBytes(1024 * 1024));
    writeFileSync(join(srcDir, 'big.bin'), randomBytes(50 * 1024 * 1024));
    await waitForApp();
  });

  after(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(dstDir, { recursive: true, force: true });
    try {
      execFileSync('docker', [
        'exec',
        'carapace-e2e-sshd',
        'rm',
        '-rf',
        `/home/carapace/${remoteName}`,
      ]);
    } catch {
      // the container may be gone
    }
  });

  it('uploads two selected files', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT);
    await clickId(`open-host-${HOST.name}`);
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await clickId('host-view-files');
    await byId('files-panel').waitForDisplayed({ timeout: 10000 });
    await paneClick('remote', 'pane-connect');
    await acceptHostKeyIfAsked();
    await waitStatus(HOST.name, 'Connected');
    await inPane('remote', 'pane-path').waitForDisplayed({ timeout: 20000 });

    await paneClick('remote', 'pane-mkdir');
    await typeInto('name-input', remoteName);
    await clickId('dialog-save');
    await waitGone('name-input');
    await openEntry('remote', remoteName);
    await waitPath('remote', remoteName);

    await openEntry('local', srcName);
    await waitPath('local', srcName);
    await waitEntry('local', 'big.bin');
    await shot('tx-01-ready');

    await selectEntries('local', ['a.txt', 'b.bin'], false);
    await browser.waitUntil(
      async () => (await inPane('local', 'pane-selection-count').getText()).includes('2'),
      { timeout: 5000, timeoutMsg: 'selection count never reached 2' },
    );
    await shot('tx-02-selected');
    await paneClick('local', 'pane-upload');
    await expandPanel();
    await waitState('a.txt', 'Done');
    await waitState('b.bin', 'Done');
    await waitEntry('remote', 'a.txt');
    await waitEntry('remote', 'b.bin');
    await shot('tx-03-uploaded');
  });

  it('downloads a file and keeps its content', async () => {
    await homeCrumb();
    await openEntry('local', dstName);
    await waitPath('local', dstName);
    await selectEntries('remote', ['b.bin']);
    await paneClick('remote', 'pane-download');
    await waitState('b.bin', 'Done', 2);
    await waitEntry('local', 'b.bin');
    await shot('tx-04-downloaded');
    expect(sha(join(dstDir, 'b.bin'))).toBe(sha(join(srcDir, 'b.bin')));
  });

  it('asks about a conflict and keeps both files', async () => {
    await homeCrumb();
    await openEntry('local', srcName);
    await waitPath('local', srcName);
    await selectEntries('local', ['a.txt']);
    await paneClick('local', 'pane-upload');
    await byId('conflict-rename').waitForDisplayed({ timeout: 15000 });
    await shot('tx-05-conflict');
    await clickId('conflict-rename');
    await waitGone('conflict-rename');
    await waitEntry('remote', 'a (1).txt');
    await waitState('a.txt', 'Done', 2);
    await shot('tx-06-kept-both');
  });

  it('drags a remote file onto the local pane', async () => {
    await homeCrumb();
    await openEntry('local', dstName);
    await waitPath('local', dstName);
    await expect(entry('local', 'a.txt')).not.toExist();
    await selectEntries('remote', ['a.txt']);
    await dragAndDrop('remote', 'a.txt', 'local');
    await waitEntry('local', 'a.txt');
    expect(readFileSync(join(dstDir, 'a.txt'), 'utf8')).toBe('carapace transfer\n');
    await shot('tx-07-dragged');
  });

  it('cancels a running upload and leaves no partial file', async () => {
    await homeCrumb();
    await openEntry('local', srcName);
    await waitPath('local', srcName);
    await selectEntries('local', ['big.bin']);
    await paneClick('local', 'pane-upload');
    // The upload can finish within a second: click the moment the button exists, no screenshot first.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const button = document.querySelector<HTMLElement>(
            '[data-testid="transfer-cancel-big.bin"]',
          );
          button?.click();
          return !!button;
        }),
      { timeout: 15000, interval: 20, timeoutMsg: 'big.bin was never cancellable' },
    );
    await waitState('big.bin', 'Cancelled');
    await shot('tx-09-cancelled');
    await setHidden('remote', true);
    await paneClick('remote', 'pane-refresh');
    await waitEntry('remote', 'b.bin');
    await expect(entry('remote', 'big.bin')).not.toExist();
    await expect(entry('remote', '.big.bin.carapace-part')).not.toExist();
    await shot('tx-10-no-leftover');
    await setHidden('remote', false);
  });

  it('clears finished transfers', async () => {
    await clickId('transfer-clear');
    await browser.waitUntil(
      async () => (await $$('[data-testid^="transfer-state-"]').length) === 0,
      { timeout: 10000, timeoutMsg: 'finished rows were not cleared' },
    );
    await shot('tx-11-cleared');
    expect(existsSync(join(dstDir, 'b.bin'))).toBe(true);
  });
});
