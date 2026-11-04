import { randomBytes } from 'node:crypto';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes, shotWithMenu } from '../helpers/screenshot';
import {
  byId,
  clickId,
  createHost,
  createProject,
  remoteSh,
  tabMenu,
  tid,
  waitActiveTab,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const dir = `carapace-e2e-edit-${randomBytes(4).toString('hex')}`;
const remoteDir = `/home/carapace/${dir}`;
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));
const editTab = (name: string) => `tab-${HOST.name}-edit-${name}`;
const remote = (id: string) => $(`${tid('pane-remote')} ${tid(id)}`);

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

async function openRemote(name: string): Promise<void> {
  const row = remote(`entry-${name}`);
  await row.waitForExist({ timeout: 15000 });
  await row.scrollIntoView({ block: 'center' });
  await row.doubleClick();
}

async function language(): Promise<string | null> {
  return byId('editor-content').getAttribute('data-language');
}

async function typeInEditor(text: string): Promise<void> {
  await $(`${tid('editor-content')} .cm-content`).click();
  await browser.keys(['Control', 'End']);
  await browser.keys(text.split(''));
}

describe('remote file editor', () => {
  before(async () => {
    remoteSh(
      [
        `mkdir -p ${remoteDir}`,
        `printf 'user www-data;\\nworker_processes auto;\\n' > ${remoteDir}/nginx.conf`,
        `printf 'services:\\n  web:\\n    image: nginx\\n' > ${remoteDir}/docker-compose.yml`,
        `printf 'echo run\\n' > ${remoteDir}/run`,
        `printf 'locked\\n' > ${remoteDir}/readonly.conf`,
        `chmod 444 ${remoteDir}/readonly.conf`,
      ].join(' && '),
    );
    await waitForApp();
  });

  after(() => {
    remoteSh(`rm -rf ${remoteDir}`);
  });

  it('opens a remote file from the files tab with nginx highlighting', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT);
    await clickId('host-open-files');
    await remote('pane-connect').click();
    await acceptHostKeyIfAsked();
    await waitStatus(HOST.name, 'Connected');
    await openRemote(dir);
    await openRemote('nginx.conf');
    await waitActiveTab(editTab('nginx.conf'));
    await byId('editor-content').waitForDisplayed({ timeout: 20000 });
    expect(await language()).toBe('nginx');
    await expect(byId('editor-path')).toHaveText(`${HOST.name}:${remoteDir}/nginx.conf`);
    await shot('edit-01-nginx');
  });

  it('edits and saves with Ctrl+S', async () => {
    await typeInEditor('# saved by e2e\n');
    await byId(editTab('nginx.conf')).$(tid('tab-modified')).waitForExist({ timeout: 5000 });
    await shot('edit-02-modified');
    await browser.keys(['Control', 's']);
    await browser.waitUntil(async () => (await byId('editor-saved').getText()).includes('Saved'), {
      timeout: 15000,
    });
    await expect(byId(editTab('nginx.conf')).$(tid('tab-modified'))).not.toExist();
    expect(remoteSh(`cat ${remoteDir}/nginx.conf`)).toContain('# saved by e2e');
  });

  it('asks on a conflict and overwrites', async () => {
    remoteSh(`echo 'changed elsewhere' >> ${remoteDir}/nginx.conf`);
    await typeInEditor('# mine\n');
    await browser.keys(['Control', 's']);
    await byId('conflict-edit-overwrite').waitForDisplayed({ timeout: 15000 });
    await shot('edit-03-conflict');
    await clickId('conflict-edit-overwrite');
    await browser.waitUntil(
      async () => !(await byId(editTab('nginx.conf')).$(tid('tab-modified')).isExisting()),
      { timeout: 15000 },
    );
    const text = remoteSh(`cat ${remoteDir}/nginx.conf`);
    expect(text).toContain('# mine');
    expect(text).not.toContain('changed elsewhere');
  });

  it('detects YAML and plain text and switches the language from the status line', async () => {
    await clickId(`tab-${HOST.name}-files`);
    await openRemote('docker-compose.yml');
    await waitActiveTab(editTab('docker-compose.yml'));
    await byId('editor-content').waitForDisplayed({ timeout: 20000 });
    expect(await language()).toBe('yaml');
    await clickId(`tab-${HOST.name}-files`);
    await openRemote('run');
    await waitActiveTab(editTab('run'));
    await byId('editor-content').waitForDisplayed({ timeout: 20000 });
    expect(await language()).toBe('plain');
    await shotWithMenu('edit-04-language-menu', 'editor-language', 'editor-language-shell');
    await clickId('editor-language');
    await byId('editor-language-shell').waitForDisplayed({ timeout: 5000 });
    // screenshotThemes closes open dropdowns (a JS click outside), so the shot comes after the pick.
    await clickId('editor-language-shell');
    await browser.waitUntil(async () => (await language()) === 'shell', { timeout: 5000 });
    await expect(byId('editor-language')).toHaveText('Shell');
    await shot('edit-04-language-shell');
  });

  it('opens a file without write permission read-only', async () => {
    await clickId(`tab-${HOST.name}-files`);
    await openRemote('readonly.conf');
    await waitActiveTab(editTab('readonly.conf'));
    await byId('editor-readonly').waitForDisplayed({ timeout: 20000 });
    await expect(byId('editor-save')).not.toExist();
    await expect(byId(editTab('readonly.conf')).$(tid('tab-readonly'))).toExist();
    await shot('edit-05-readonly');
  });

  it('keeps the buffer while disconnected and saves after reconnecting', async () => {
    await clickId(editTab('nginx.conf'));
    await byId('editor-content').waitForDisplayed({ timeout: 10000 });
    await typeInEditor('# offline\n');
    await tabMenu(editTab('nginx.conf'), 'tab-menu-disconnect');
    await byId('editor-banner').waitForDisplayed({ timeout: 15000 });
    await expect(byId('editor-banner')).toHaveText(expect.stringContaining('Disconnected.'));
    await shot('edit-06-disconnected');
    await clickId('editor-reconnect');
    await waitStatus(HOST.name, 'Connected');
    await waitGone('editor-banner');
    await clickId('editor-save');
    await browser.waitUntil(
      async () => remoteSh(`cat ${remoteDir}/nginx.conf`).includes('# offline'),
      {
        timeout: 15000,
      },
    );
  });

  it('asks before closing a modified editor', async () => {
    await typeInEditor('# unsaved\n');
    await browser.keys(['Control', 'Shift', 'w']);
    await byId('unsaved-save').waitForDisplayed({ timeout: 10000 });
    await shot('edit-07-unsaved');
    await clickId('unsaved-cancel');
    await waitGone('unsaved-save');
    await expect(byId(editTab('nginx.conf'))).toExist();
    await browser.keys(['Control', 'Shift', 'w']);
    await clickId('unsaved-discard');
    await waitGone(editTab('nginx.conf'));
    expect(remoteSh(`cat ${remoteDir}/nginx.conf`)).not.toContain('# unsaved');
  });
});
