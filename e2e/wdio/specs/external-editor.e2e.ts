import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appPids, waitAppExited } from '../helpers/app-process';
import { HOST, NOOP_EDITOR, PROJECT } from '../helpers/fixture';
import { screenshot, screenshotThemes, setThemeMode, shotWithMenu } from '../helpers/screenshot';
import {
  byId,
  clickId,
  confirmDialog,
  createHost,
  createProject,
  dialogButton,
  disconnect,
  enterProject,
  openMenu,
  remoteSh,
  tid,
  waitActiveTab,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

// The external app is the no-op program seeded by `beforeSession` (Custom app): a save in the
// editor is simulated by writing the local copy under $CARAPACE_HOME/edit/ directly.
const LAB = { ...HOST, name: 'lab' };
/** A program the backend refuses as an editor (`app_not_editor`). */
const POWERSHELL = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const dir = `carapace-e2e-ext-${randomBytes(4).toString('hex')}`;
const remoteDir = `/home/carapace/${dir}`;
const LONG_DIR = 'a-very-long-directory-name-for-the-narrow-window-check/and-another-long-segment';
const LONG_NAME = 'a-rather-long-configuration-file-name-that-ellipsizes.conf';
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));
const remote = (id: string) => $(`${tid('pane-remote')} ${tid(id)}`);
const row = (host: string, name: string) => byId(`edited-row-${host}-${name}`);

function editRoot(): string {
  return join(process.env['E2E_CARAPACE_HOME'] ?? '', 'edit');
}

/** The local copy of an edited file: `$CARAPACE_HOME/edit/<id>/<name>`. */
function localCopy(name: string): string {
  for (const slot of readdirSync(editRoot())) {
    const file = join(editRoot(), slot, name);
    if (existsSync(file)) return file;
  }
  throw new Error(`no local copy of ${name}`);
}

function hasLocalCopy(name: string): boolean {
  return (
    existsSync(editRoot()) &&
    readdirSync(editRoot()).some((slot) => existsSync(join(editRoot(), slot, name)))
  );
}

/** A save in the external editor. */
function saveInEditor(name: string, text: string): void {
  appendFileSync(localCopy(name), text);
}

async function waitState(host: string, name: string, state: string, timeout = 20000) {
  await browser.waitUntil(
    async () =>
      (await row(host, name)
        .getAttribute('data-state')
        .catch(() => null)) === state,
    { timeout, timeoutMsg: `${name} never reached ${state}` },
  );
}

async function waitRemote(path: string, check: (text: string) => boolean): Promise<void> {
  await browser.waitUntil(async () => check(remoteSh(`cat ${path} 2>/dev/null || true`)), {
    timeout: 20000,
    timeoutMsg: `${path} never matched`,
  });
}

/** Waits until no alert on screen contains `text`. */
async function waitToastGone(text: string, timeout = 15000): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (t: string) =>
          ![...document.querySelectorAll('tui-notification-alert')].some((a) =>
            a.textContent?.includes(t),
          ),
        text,
      ) as Promise<boolean>,
    { timeout, timeoutMsg: `the alert "${text}" stayed` },
  );
}

async function waitToast(text: string, timeout = 15000): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((t: string) => document.body.innerText.includes(t), text) as Promise<boolean>,
    { timeout, timeoutMsg: `no toast "${text}"` },
  );
}

/** Alerts that wait for the user (`autoClose: 0`) cover the right end of the file panes. */
async function closeToasts(): Promise<void> {
  await browser.execute(() =>
    document
      .querySelectorAll<HTMLButtonElement>('tui-notification-alert button[tuiIconButton]')
      .forEach((b) => b.click()),
  );
  await browser.waitUntil(async () => !(await $('tui-notification-alert').isExisting()), {
    timeout: 10000,
  });
}

async function acceptHostKeyIfAsked(): Promise<void> {
  const accept = byId('host-key-accept');
  if (
    await accept.waitForExist({ timeout: 8000 }).then(
      () => true,
      () => false,
    )
  ) {
    await clickId('host-key-accept');
    await waitGone('host-key-accept');
  }
}

async function openFilesOf(host: string): Promise<void> {
  await closeToasts();
  // After a restart the sidebar may show Home: the host rows live in the project.
  await enterProject(PROJECT);
  await clickId(`open-host-${host}`);
  await clickId('host-open-files');
  await waitActiveTab(`tab-${host}-files`);
  if (await remote('pane-connect').isExisting()) {
    await remote('pane-connect').click();
    await acceptHostKeyIfAsked();
  }
  await waitStatus(host, 'Connected');
}

async function enterRemote(name: string): Promise<void> {
  await closeToasts();
  const entry = remote(`entry-${name}`);
  await entry.waitForExist({ timeout: 15000 });
  await entry.scrollIntoView({ block: 'center' });
  await entry.doubleClick();
}

/** Remote pane row menu > Open in external editor. */
async function openExternal(name: string): Promise<void> {
  await closeToasts();
  const entry = remote(`entry-${name}`);
  await entry.waitForExist({ timeout: 15000 });
  await entry.scrollIntoView({ block: 'center' });
  await entry.moveTo();
  await browser.waitUntil(async () => (await $$(tid('entry-external')).length) === 0, {
    timeout: 10000,
  });
  await remote(`entry-menu-${name}`).click();
  await clickId('entry-external');
}

async function openEditedPage(): Promise<void> {
  await clickId('aside-edited-files');
  await byId('edited-title').waitForDisplayed({ timeout: 10000 });
}

async function rowButton(host: string, name: string, id: string): Promise<void> {
  const button = row(host, name).$(tid(id));
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
}

/** A row "…" menu shot in both themes; the menu is opened in each theme (it keeps its own). */
async function shotRowMenu(name: string, host: string, file: string, option: string) {
  const files: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    await setThemeMode(mode);
    await rowButton(host, file, 'edited-row-menu');
    await byId(option).waitForDisplayed({ timeout: 10000 });
    await browser.pause(400);
    files.push(await screenshot(`${name}-${mode}`));
    await rowButton(host, file, 'edited-row-menu');
    await byId(option).waitForExist({ timeout: 10000, reverse: true });
  }
  await setThemeMode('system');
  console.log('screenshots', files);
}

async function rowMenu(host: string, name: string, option: string): Promise<void> {
  // A closed menu stays in the DOM during its leave animation.
  await browser.waitUntil(async () => (await $$(tid(option)).length) === 0, { timeout: 10000 });
  await rowButton(host, name, 'edited-row-menu');
  await clickId(option);
}

/**
 * A crash: the e2e app instance is terminated, so nothing is cleaned up on the way out (a normal
 * close would also be held by the quit guard while a file is not uploaded).
 */
async function killAndRestart(whileStopped?: () => void): Promise<void> {
  const pids = appPids();
  for (const pid of pids) process.kill(pid);
  await browser.deleteSession().catch(() => undefined);
  await waitAppExited(pids);
  whileStopped?.();
  await browser.reloadSession();
}

/** Rewrites the manifest next to an edited file's local copy (the app must be stopped). */
function editManifest(name: string, change: Record<string, string>): void {
  const file = join(localCopy(name), '..', '.carapace-edit.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...manifest, ...change }));
}

/** Rewrites the app config (the app must be stopped). */
function editConfig(change: (config: Record<string, unknown>) => void): void {
  const file = join(process.env['E2E_CARAPACE_HOME'] ?? '', 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(config);
  writeFileSync(file, JSON.stringify(config, null, 2));
}

describe('external editor', () => {
  before(async () => {
    remoteSh(
      [
        `mkdir -p ${remoteDir}/ro ${remoteDir}/${LONG_DIR}`,
        `printf 'user www-data;\\n' > ${remoteDir}/nginx.conf`,
        `printf 'lab\\n' > ${remoteDir}/lab.conf`,
        `printf 'readme\\n' > ${remoteDir}/readme.txt`,
        `printf 'notes\\n' > ${remoteDir}/ro/notes.txt`,
        `printf 'TOKEN=dummy\\n' > ${remoteDir}/id_deploy`,
        `printf 'echo hi\\r\\n' > ${remoteDir}/deploy.bat`,
        `printf 'long\\n' > ${remoteDir}/${LONG_DIR}/${LONG_NAME}`,
        `head -c 26214400 /dev/zero > ${remoteDir}/big.bin`,
      ].join(' && '),
    );
    await waitForApp();
  });

  after(() => {
    remoteSh(`chmod -R u+w ${remoteDir} 2>/dev/null; rm -rf ${remoteDir}`);
  });

  it('offers Open in external editor in the remote row menu', async () => {
    expect(NOOP_EDITOR).toMatch(/whoami\.exe$/i);
    await createProject(PROJECT);
    await createHost(PROJECT);
    await createHost(PROJECT, LAB);
    await openFilesOf(HOST.name);
    await enterRemote(dir);
    await remote('entry-nginx.conf').waitForExist({ timeout: 15000 });
    await remote('entry-nginx.conf').moveTo();
    await shotWithMenu('ext-01-row-menu', 'entry-menu-nginx.conf', 'entry-external');
    await expect(byId('aside-edited-files')).not.toExist();
  });

  it('shows the notice once, then opens the file and marks it', async () => {
    await openExternal('nginx.conf');
    await byId('ext-notice-continue').waitForDisplayed({ timeout: 10000 });
    await shot('ext-02-first-notice');
    await clickId('ext-notice-dont-show');
    await clickId('ext-notice-continue');
    await waitGone('ext-notice-continue');
    await remote('entry-external-marker-nginx.conf').waitForExist({ timeout: 20000 });
    expect(hasLocalCopy('nginx.conf')).toBe(true);
    await expect(byId('aside-edited-count')).toHaveText('1');
    // Focus stays on the Files tab: nothing navigates.
    await waitActiveTab(`tab-${HOST.name}-files`);
  });

  it('uploads each save and shows the time on the Edited files page', async () => {
    saveInEditor('nginx.conf', '# saved in the editor\n');
    await waitRemote(`${remoteDir}/nginx.conf`, (t) => t.includes('# saved in the editor'));
    await openEditedPage();
    await waitState(HOST.name, 'nginx.conf', 'synced');
    await browser.waitUntil(
      async () =>
        (await row(HOST.name, 'nginx.conf').$(tid('edited-state')).getText()).includes('Uploaded'),
      { timeout: 10000 },
    );
    await expect(byId('edited-note')).toBeDisplayed();
    await shot('ext-04-edited-synced');
  });

  it('holds a save when the server changed, and resolves with each choice', async () => {
    remoteSh(`echo 'server edit 1' >> ${remoteDir}/nginx.conf`);
    saveInEditor('nginx.conf', '# local 1\n');
    await waitState(HOST.name, 'nginx.conf', 'conflict');
    await byId('aside-edited-attention').waitForExist({ timeout: 10000 });
    await waitToast('nginx.conf changed on sshd');
    await shot('ext-06-conflict-alert');
    expect(remoteSh(`cat ${remoteDir}/nginx.conf`)).not.toContain('# local 1');
    // Later saves stay held.
    saveInEditor('nginx.conf', '# local 2\n');
    await browser.pause(1500);
    expect(remoteSh(`cat ${remoteDir}/nginx.conf`)).not.toContain('# local 2');

    await rowButton(HOST.name, 'nginx.conf', 'edited-action');
    await byId('conflict-ext-keep').waitForDisplayed({ timeout: 10000 });
    await shot('ext-07-conflict-dialog');
    await clickId('conflict-ext-keep');
    await waitGone('conflict-ext-keep');
    await waitState(HOST.name, 'nginx.conf', 'conflict');

    await rowButton(HOST.name, 'nginx.conf', 'edited-action');
    await clickId('conflict-ext-overwrite');
    await waitState(HOST.name, 'nginx.conf', 'synced');
    await waitToastGone('nginx.conf changed on sshd');
    await shot('ext-22-alert-closed');
    const overwritten = remoteSh(`cat ${remoteDir}/nginx.conf`);
    expect(overwritten).toContain('# local 2');
    expect(overwritten).not.toContain('server edit 1');

    remoteSh(`echo 'server edit 2' >> ${remoteDir}/nginx.conf`);
    saveInEditor('nginx.conf', '# local 3\n');
    await waitState(HOST.name, 'nginx.conf', 'conflict');
    await rowButton(HOST.name, 'nginx.conf', 'edited-action');
    await clickId('conflict-ext-server');
    await waitState(HOST.name, 'nginx.conf', 'synced');
    const local = readFileSync(localCopy('nginx.conf'), 'utf8');
    expect(local).toContain('server edit 2');
    expect(local).not.toContain('# local 3');
  });

  it('uploads anyway when the server file was deleted', async () => {
    remoteSh(`rm ${remoteDir}/nginx.conf`);
    saveInEditor('nginx.conf', '# after delete\n');
    await waitState(HOST.name, 'nginx.conf', 'conflict');
    await rowButton(HOST.name, 'nginx.conf', 'edited-action');
    await byId('conflict-ext-upload-anyway').waitForDisplayed({ timeout: 10000 });
    await shot('ext-26-deleted-conflict');
    await clickId('conflict-ext-upload-anyway');
    await waitState(HOST.name, 'nginx.conf', 'synced');
    expect(remoteSh(`cat ${remoteDir}/nginx.conf`)).toContain('# after delete');
  });

  it('opens with Shift+Enter, refused while the built-in tab of the file is modified', async () => {
    await clickId(`tab-${HOST.name}-files`);
    await remote('entry-lab.conf').waitForExist({ timeout: 15000 });
    await enterRemote('nginx.conf');
    await waitActiveTab(`tab-${HOST.name}-edit-nginx.conf`);
    await byId('editor-content').waitForDisplayed({ timeout: 20000 });
    await $(`${tid('editor-content')} .cm-content`).click();
    await browser.keys(['Control', 'End']);
    await browser.keys('# dirty'.split(''));
    await clickId(`tab-${HOST.name}-files`);
    await remote('entry-nginx.conf').click();
    await browser.keys(['Shift', 'Enter']);
    await waitToast('Save or close nginx.conf in Carapace first.');
    await remote('entry-ro').doubleClick();
    await remote('entry-notes.txt').waitForExist({ timeout: 15000 });
    await remote('entry-notes.txt').click();
    await browser.keys(['Shift', 'Enter']);
    await remote('entry-external-marker-notes.txt').waitForExist({ timeout: 20000 });
    await remote('entry-notes.txt').click();
    await browser.keys('Backspace');
    await remote('entry-big.bin').waitForExist({ timeout: 15000 });
  });

  it('shows failed, waiting and changed rows, attention first', async () => {
    remoteSh(`echo 'server edit 3' >> ${remoteDir}/nginx.conf`);
    saveInEditor('nginx.conf', '# held\n');
    remoteSh(`chmod 444 ${remoteDir}/ro/notes.txt && chmod 555 ${remoteDir}/ro`);
    saveInEditor('notes.txt', 'mine\n');
    await openEditedPage();
    await waitState(HOST.name, 'nginx.conf', 'conflict');
    await waitState(HOST.name, 'notes.txt', 'failed');
    await expect(row(HOST.name, 'notes.txt').$(tid('edited-reason'))).toHaveText(
      'Permission denied on sshd.',
    );
    // A synced file next to one that needs attention, in the same pane.
    await openFilesOf(HOST.name);
    await openExternal('readme.txt');
    await remote('entry-external-marker-readme.txt').waitForExist({ timeout: 20000 });
    await browser.waitUntil(
      async () =>
        (await remote('entry-external-marker-nginx.conf').getAttribute('data-state')) ===
        'conflict',
      { timeout: 10000 },
    );
    await remote('entry-readme.txt').moveTo();
    await shot('ext-03-remote-marker');
    await openFilesOf(LAB.name);
    await enterRemote(dir);
    await openExternal('lab.conf');
    await remote('entry-external-marker-lab.conf').waitForExist({ timeout: 20000 });
    await disconnect(LAB.name);
    saveInEditor('lab.conf', 'offline\n');
    await openEditedPage();
    await waitState(LAB.name, 'lab.conf', 'waiting');
    const order = await $$('tbody tr[data-testid^="edited-row-"]').map((r) =>
      r.getAttribute('data-testid'),
    );
    expect(order).toEqual([
      'edited-row-sshd-nginx.conf',
      'edited-row-sshd-notes.txt',
      'edited-row-lab-lab.conf',
      'edited-row-sshd-readme.txt',
    ]);
    await shot('ext-08-mixed-states');
    await shotRowMenu('ext-09-row-menu', HOST.name, 'nginx.conf', 'edited-builtin');
  });

  it('lists the edited files in the host delete confirm', async () => {
    await openMenu('host', LAB.name, 'menu-delete');
    const text = await $('tui-dialog').getText();
    expect(text).toContain('1 file open in an external editor will stop syncing.');
    expect(text).toContain('Changes not uploaded in lab.conf will be lost.');
    await shot('ext-25-delete-host-confirm');
    await confirmDialog('Cancel');
  });

  it('uploads the waiting changes on reconnect', async () => {
    await rowButton(LAB.name, 'lab.conf', 'edited-action');
    await waitStatus(LAB.name, 'Connected');
    await waitState(LAB.name, 'lab.conf', 'synced');
    expect(remoteSh(`cat ${remoteDir}/lab.conf`)).toContain('offline');
  });

  it('stops a synced file at once and asks for one not uploaded', async () => {
    await rowMenu(LAB.name, 'lab.conf', 'edited-stop');
    await row(LAB.name, 'lab.conf').waitForExist({ timeout: 10000, reverse: true });
    expect(hasLocalCopy('lab.conf')).toBe(false);
    await rowMenu(HOST.name, 'notes.txt', 'edited-stop');
    await dialogButton('Stop and delete changes').waitForDisplayed({ timeout: 10000 });
    await shot('ext-10-stop-confirm');
    await confirmDialog('Stop and delete changes');
    await row(HOST.name, 'notes.txt').waitForExist({ timeout: 10000, reverse: true });
    remoteSh(`chmod 755 ${remoteDir}/ro`);
  });

  it('shows the quit dialog with the unsaved tab and the file not uploaded', async () => {
    await openEditedPage();
    await waitState(HOST.name, 'nginx.conf', 'conflict');
    // A native close (WM_CLOSE to the e2e app window): WebDriver's closeWindow drops the session.
    // The backend holds it while a file is not uploaded and asks the page.
    for (const pid of appPids()) {
      execFileSync('pwsh', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`,
      ]);
    }
    await dialogButton('Quit without saving').waitForDisplayed({ timeout: 15000 });
    const text = await $('tui-dialog').getText();
    expect(text).toContain('Unsaved in Carapace: nginx.conf (sshd)');
    expect(text).toContain('Not uploaded from your editor: nginx.conf (sshd)');
    await shot('ext-12-quit-dialog');
    await confirmDialog('Cancel');
  });

  it('keeps a copy not uploaded across a restart as Recovered, then uploads it', async () => {
    // Cancel went to the modified editor tab.
    await openEditedPage();
    await waitState(HOST.name, 'nginx.conf', 'conflict');
    await killAndRestart();
    await waitForApp();
    await waitToast('1 edited file was not uploaded', 20000);
    await openEditedPage();
    await waitState(HOST.name, 'nginx.conf', 'recovered');
    await shot('ext-13-recovered');
    await rowButton(HOST.name, 'nginx.conf', 'edited-action');
    await acceptHostKeyIfAsked();
    await byId('conflict-ext-overwrite').waitForDisplayed({ timeout: 20000 });
    await clickId('conflict-ext-overwrite');
    await waitState(HOST.name, 'nginx.conf', 'synced');
    await waitToastGone('1 edited file was not uploaded');
    expect(remoteSh(`cat ${remoteDir}/nginx.conf`)).toContain('# held');
  });

  it('shows the External editor settings with the custom app', async () => {
    await clickId('settings');
    await byId('settings-ext-path').waitForExist({ timeout: 10000 });
    await browser.waitUntil(
      async () => (await byId('settings-ext-path').getValue()) === NOOP_EDITOR,
      { timeout: 10000 },
    );
    await expect(byId('settings-ext-notice')).not.toBeSelected();
    await expect(byId('settings-ext-browse')).toBeEnabled();
    await byId('settings-ext-notice').scrollIntoView({ block: 'center' });
    await shot('ext-14-settings');
  });

  it('asks before a download over 20 MiB and before copying a sensitive file', async () => {
    await openFilesOf(HOST.name);
    // A fresh app starts the remote pane in the home directory.
    if (!(await remote('entry-big.bin').isExisting())) await enterRemote(dir);
    await remote('entry-big.bin').waitForExist({ timeout: 15000 });
    await openExternal('big.bin');
    await byId('ext-large-download').waitForDisplayed({ timeout: 15000 });
    await shot('ext-15-large-confirm');
    await clickId('ext-large-download');
    await remote('entry-external-marker-big.bin').waitForExist({ timeout: 30000 });
    await openExternal('id_deploy');
    await byId('ext-sensitive-confirm').waitForDisplayed({ timeout: 15000 });
    await shot('ext-18-sensitive');
    await clickId('ext-sensitive-confirm');
    await remote('entry-external-marker-id_deploy').waitForExist({ timeout: 20000 });
  });

  it('refuses a type the system would run, with System default', async () => {
    await clickId('settings');
    await byId('settings-ext-system').waitForExist({ timeout: 10000 });
    await byId('settings-ext-system').click();
    await byId('settings-ext-path').waitForExist({ timeout: 10000, reverse: true });
    await clickId(`tab-${HOST.name}-files`);
    await openExternal('deploy.bat');
    await waitToast('deploy.bat would be run, not opened, by your system.');
    await shot('ext-16-blocked-type');
    expect(hasLocalCopy('deploy.bat')).toBe(false);
    await clickId('settings');
    await byId('settings-ext-custom').click();
    await browser.waitUntil(
      async () =>
        (await byId('settings-ext-path')
          .getValue()
          .catch(() => '')) === NOOP_EDITOR,
      { timeout: 10000 },
    );
  });

  it('fits long paths at 800 px', async () => {
    await clickId(`tab-${HOST.name}-files`);
    for (const segment of LONG_DIR.split('/')) await enterRemote(segment);
    await openExternal(LONG_NAME);
    await remote(`entry-external-marker-${LONG_NAME}`).waitForExist({ timeout: 20000 });
    // A Waiting row checks the Reconnect button width at 800 px.
    await disconnect(HOST.name);
    saveInEditor(LONG_NAME, 'offline\n');
    await openEditedPage();
    await waitState(HOST.name, LONG_NAME, 'waiting');
    const size = await browser.getWindowSize();
    try {
      await browser.setWindowSize(800, size.height);
      await browser.pause(500);
      const scrolls = await browser.execute(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(scrolls).toBe(false);
      await shot('ext-17-800px');
    } finally {
      await browser.setWindowSize(size.width, size.height);
    }
  });

  it('locks files whose host now reaches another server or no longer exists', async () => {
    saveInEditor('id_deploy', 'offline\n');
    await waitState(HOST.name, 'id_deploy', 'waiting');
    // Seeded while the app is stopped, without touching the shared sshd: id_deploy remembers
    // another host key, the long file a host id the config does not have, and the custom app
    // becomes a program the backend refuses as an editor.
    await killAndRestart(() => {
      editManifest('id_deploy', { hostKey: `SHA256:${'A'.repeat(43)}` });
      editManifest(LONG_NAME, { hostId: '00000000-0000-4000-8000-000000000000' });
      editConfig((config) => {
        config['externalEditor'] = { mode: 'custom', appPath: POWERSHELL, noticeSeen: true };
      });
    });
    await waitForApp();
    await waitToast('2 edited files were not uploaded', 20000);
    await closeToasts();
    await openEditedPage();
    await waitState('deleted', LONG_NAME, 'recovered');
    await expect(row('deleted', LONG_NAME).$(tid('edited-reason'))).toHaveText(
      'The host no longer exists',
    );
    await expect(row('deleted', LONG_NAME).$(tid('edited-action'))).not.toExist();
    await shot('ext-20-host-gone');

    await rowButton(HOST.name, 'id_deploy', 'edited-action');
    await acceptHostKeyIfAsked();
    await waitState(HOST.name, 'id_deploy', 'failed');
    await expect(row(HOST.name, 'id_deploy').$(tid('edited-reason'))).toHaveText(
      'sshd now points to another server. Nothing was sent. Copy your changes out with Show in folder, then stop editing.',
    );
    await expect(row(HOST.name, 'id_deploy').$(tid('edited-action'))).not.toExist();
    await closeToasts();
    await shotRowMenu('ext-19-locked', HOST.name, 'id_deploy', 'edited-upload');
    await rowButton(HOST.name, 'id_deploy', 'edited-row-menu');
    await expect(byId('edited-upload')).toHaveAttribute('aria-disabled', 'true');
    await rowButton(HOST.name, 'id_deploy', 'edited-row-menu');
    await byId('edited-upload').waitForExist({ timeout: 10000, reverse: true });
  });

  it('shows a program that is not an editor as a field error in Settings', async () => {
    await clickId('settings');
    await byId('settings-ext-notice').waitForExist({ timeout: 10000 });
    await browser.waitUntil(
      async () => (await byId('settings-ext-path').getValue()) === POWERSHELL,
      { timeout: 10000 },
    );
    // Any save sends the stored app again, which the backend refuses.
    await byId('settings-ext-notice').click();
    await byId('settings-ext-error').waitForDisplayed({ timeout: 10000 });
    await expect(byId('settings-ext-error')).toHaveText(
      "This program runs scripts or commands; it is not an editor. Pick your editor's program file.",
    );
    await expect(byId('settings-ext-path')).toHaveAttribute('aria-invalid', 'true');
    await byId('settings-ext-notice').scrollIntoView({ block: 'center' });
    await shot('ext-21-settings-error');
  });

  it('stops all and shows the empty page, the aside item gone', async () => {
    await openEditedPage();
    await shotWithMenu('ext-23-stop-all-menu', 'edited-menu', 'edited-stop-all');
    await clickId('edited-menu');
    await clickId('edited-stop-all');
    await dialogButton('Stop all').waitForDisplayed({ timeout: 10000 });
    await shot('ext-24-stop-all-confirm');
    await confirmDialog('Stop all');
    await byId('edited-empty').waitForDisplayed({ timeout: 15000 });
    await waitGone('aside-edited-files');
    await shot('ext-11-empty');
    expect(hasLocalCopy('nginx.conf')).toBe(false);
  });
});
