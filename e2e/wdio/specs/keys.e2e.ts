import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshot, screenshotThemes, setThemeMode } from '../helpers/screenshot';
import {
  byId,
  clickId,
  connect,
  createHost,
  createProject,
  disconnect,
  hostStatus,
  openMenu,
  typeInto,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const work = resolve(__dirname, '..', '..', '.work');
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const GEN = 'e2e-gen';
const IMPORTED = 'id_ed25519_enc';
const importedPath = resolve(work, IMPORTED);
const passphrase = randomBytes(12).toString('hex');
const keysDir = () => join(process.env['E2E_CARAPACE_HOME'] ?? '', 'keys');
const privatePath = () => join(keysDir(), GEN);

let blob = '';

const toast = (text: string) => $(`//*[contains(text(), "${text}")]`);

async function openKeyMenu(name: string, option: string): Promise<void> {
  await clickId(`key-menu-${name}`);
  await clickId(option);
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

async function openHostKeyPath(): Promise<void> {
  await openMenu('host', HOST.name, 'menu-edit');
  await byId('host-key-path').waitForDisplayed({ timeout: 10000 });
}

describe('keys', () => {
  before(waitForApp);

  after(() => {
    if (!blob) return;
    // Remove the line holding the generated key from the container's authorized_keys.
    const script =
      'f=/home/carapace/.ssh/authorized_keys; grep -vF "$1" "$f" > "$f.tmp"; cat "$f.tmp" > "$f"; rm -f "$f.tmp"';
    try {
      execFileSync('docker', ['exec', 'carapace-e2e-sshd', 'sh', '-c', script, 'sh', blob], {
        stdio: 'inherit',
      });
    } catch (err) {
      console.log('authorized_keys cleanup failed; run "node e2e/sshd/setup.mjs up"', err);
    }
  });

  it('shows the empty keys page', async () => {
    await clickId('ssh-keys');
    await byId('keys-title').waitForDisplayed({ timeout: 10000 });
    await byId('keys-empty').waitForDisplayed({ timeout: 10000 });
    await shot('keys-01-empty');
  });

  it('generates an encrypted Ed25519 key', async () => {
    await clickId('keys-generate');
    await byId('keygen-name').waitForDisplayed({ timeout: 10000 });
    await $('[data-testid="keygen-type-ed25519"] input').waitForExist();
    await typeInto('keygen-name', GEN);
    await typeInto('keygen-passphrase', passphrase);
    await typeInto('keygen-confirm', passphrase);
    await expect(byId('keygen-remember')).not.toBeChecked();
    await shot('keys-02-generate-dialog');
    await clickId('keygen-submit');
    await waitGone('keygen-name');

    await byId(`key-row-${GEN}`).waitForDisplayed({ timeout: 20000 });
    await byId(`key-badge-encrypted-${GEN}`).waitForDisplayed();
    await expect(byId(`key-badge-saved-${GEN}`)).not.toExist();
    await expect(byId(`key-badge-external-${GEN}`)).not.toExist();
    await expect(byId(`key-fingerprint-${GEN}`)).toHaveText(expect.stringContaining('SHA256:'));
    await shot('keys-03-generated');

    const files = readdirSync(keysDir());
    expect(files).toContain(GEN);
    expect(files).toContain(`${GEN}.pub`);
    expect(files.filter((f) => f.endsWith('.carapace-part'))).toEqual([]);
    blob = readFileSync(`${privatePath()}.pub`, 'utf8').trim().split(/\s+/)[1];
  });

  it('copies the public key', async () => {
    await openKeyMenu(GEN, 'key-copy');
    await toast('Public key copied').waitForDisplayed({ timeout: 10000 });
    await shot('keys-04-copied');
  });

  it('creates the fixture host and shows the key picker', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT, HOST);
    await waitStatus(HOST.name, 'Not connected');
    await openHostKeyPath();
    await clickId('host-key-pick');
    await byId(`host-key-option-${GEN}`).waitForDisplayed({ timeout: 10000 });
    // The theme switch closes the dropdown, so reopen it for each theme.
    for (const mode of ['light', 'dark'] as const) {
      await setThemeMode(mode);
      await browser.pause(400);
      if (!(await byId(`host-key-option-${GEN}`).isExisting())) await clickId('host-key-pick');
      await byId(`host-key-option-${GEN}`).waitForDisplayed({ timeout: 10000 });
      console.log('screenshot', await screenshot(`keys-05-host-key-picker-${mode}`));
    }
    await clickId('dialog-cancel');
    await waitGone('host-key-path');
  });

  it('connects and deploys the key with "Use this key"', async () => {
    await connect(HOST.name);
    await acceptHostKeyIfAsked(async () => (await hostStatus(HOST.name)) === 'Connected');
    await waitStatus(HOST.name, 'Connected');

    await clickId('ssh-keys');
    await openKeyMenu(GEN, 'key-deploy');
    await clickId('deploy-host');
    await clickId(`deploy-host-option-${HOST.name}`);
    await clickId('deploy-use');
    await expect(byId('deploy-use')).toBeChecked();
    await shot('keys-06-deploy-dialog');
    await clickId('deploy-submit');
    await toast('Key added to authorized_keys').waitForDisplayed({ timeout: 20000 });
    await shot('keys-07-deployed');

    await openHostKeyPath();
    await expect(byId('host-key-path')).toHaveValue(expect.stringContaining(GEN));
    await clickId('dialog-cancel');
    await waitGone('host-key-path');
  });

  it('reconnects with the new key after asking for its passphrase', async () => {
    await disconnect(HOST.name);
    await waitStatus(HOST.name, 'Not connected');
    await connect(HOST.name);
    await byId('credential-secret').waitForDisplayed({ timeout: 20000 });
    await expect(byId('credential-remember')).not.toBeChecked();
    await shot('keys-08-passphrase-prompt');
    await typeInto('credential-secret', passphrase);
    await clickId('credential-submit');
    await acceptHostKeyIfAsked(async () => !(await byId('credential-secret').isExisting()));
    await waitStatus(HOST.name, 'Connected');
  });

  it('reports the key as already present on a second deploy', async () => {
    await clickId('ssh-keys');
    await openKeyMenu(GEN, 'key-deploy');
    await clickId('deploy-host');
    await clickId(`deploy-host-option-${HOST.name}`);
    await clickId('deploy-submit');
    await toast('Key already present').waitForDisplayed({ timeout: 20000 });
    await shot('keys-09-already-present');
  });

  it('imports an external encrypted key', async () => {
    await clickId('keys-import');
    await byId('keyimport-path').waitForDisplayed({ timeout: 10000 });
    await typeInto('keyimport-path', importedPath);
    await expect(byId('keyimport-remember')).not.toBeChecked();
    await shot('keys-10-import-dialog');
    await clickId('keyimport-submit');
    await waitGone('keyimport-path');
    await byId(`key-row-${IMPORTED}`).waitForDisplayed({ timeout: 20000 });
    await byId(`key-badge-encrypted-${IMPORTED}`).waitForDisplayed();
    await byId(`key-badge-external-${IMPORTED}`).waitForDisplayed();
    await shot('keys-11-imported');
  });

  it('deletes the imported key and keeps its file', async () => {
    await openKeyMenu(IMPORTED, 'key-delete');
    await expect(byId('key-delete-files')).not.toExist();
    await shot('keys-12-delete-external');
    await confirmDeleteDialog();
    await waitGone(`key-row-${IMPORTED}`);
    expect(existsSync(importedPath)).toBe(true);
  });

  it('deletes the generated key with its files', async () => {
    await openKeyMenu(GEN, 'key-delete');
    await expect(byId('key-delete-files')).toBeChecked();
    await shot('keys-13-delete-managed');
    await confirmDeleteDialog();
    await waitGone(`key-row-${GEN}`);
    await byId('keys-empty').waitForDisplayed({ timeout: 10000 });
    expect(existsSync(privatePath())).toBe(false);
    expect(existsSync(`${privatePath()}.pub`)).toBe(false);
    await shot('keys-14-empty-again');
  });

  describe('key folder and key files', () => {
    // OS pickers cannot be driven by WebDriver: Browse buttons are only checked, folders are typed.
    const CUSTOM = 'e2e-custom';
    const customDir = () => join(process.env['E2E_CARAPACE_HOME'] ?? '', 'custom-keys');
    const customKey = () => join(customDir(), CUSTOM);
    const text = (fragment: string) => $(`//*[contains(text(), "${fragment}")]`);

    async function openGenerate(): Promise<void> {
      await clickId('keys-generate');
      await byId('keygen-folder').waitForDisplayed({ timeout: 10000 });
    }

    async function cancelDialog(): Promise<void> {
      const button = $('//tui-dialog//button[normalize-space()="Cancel"]');
      await button.click();
      await button.waitForExist({ timeout: 10000, reverse: true });
    }

    before(() => mkdirSync(customDir(), { recursive: true }));

    after(async () => {
      rmSync(customDir(), { recursive: true, force: true });
      await browser.execute(() => localStorage.removeItem('carapace.keyFolder'));
    });

    it('generates into a typed custom folder', async () => {
      await clickId('ssh-keys');
      await openGenerate();
      await expect(byId('keygen-folder-browse')).toBeEnabled();
      await expect(byId('keygen-folder-reset')).not.toExist();
      await typeInto('keygen-name', CUSTOM);
      await typeInto('keygen-folder', customDir());
      await byId('keygen-folder-reset').waitForDisplayed({ timeout: 10000 });
      await expect(byId('keygen-path')).toHaveText(expect.stringContaining(customKey()));
      await shot('keys-15-generate-custom-folder');
      await clickId('keygen-submit');
      await waitGone('keygen-folder');

      await byId(`key-badge-folder-${CUSTOM}`).waitForDisplayed({ timeout: 20000 });
      await expect(byId(`key-badge-external-${CUSTOM}`)).not.toExist();
      expect(existsSync(customKey())).toBe(true);
      expect(existsSync(`${customKey()}.pub`)).toBe(true);
      expect(readdirSync(customDir()).filter((f) => f.endsWith('.carapace-part'))).toEqual([]);
      if (process.platform !== 'win32') {
        expect(statSync(customKey()).mode & 0o077).toBe(0);
      }
    });

    it('remembers the folder and reports folder problems before Generate', async () => {
      await openGenerate();
      await expect(byId('keygen-folder')).toHaveValue(customDir());
      await typeInto('keygen-passphrase', passphrase);
      await typeInto('keygen-confirm', passphrase);
      await typeInto('keygen-folder', join(customDir(), 'missing'));
      await text('This folder does not exist').waitForDisplayed({ timeout: 10000 });
      await clickId('keygen-submit');
      await expect(byId('keygen-folder')).toExist();
      expect(((await byId('keygen-passphrase').getValue()) ?? '').length).toBe(passphrase.length);
      await shot('keys-16-folder-error');

      await typeInto('keygen-folder', customDir());
      await typeInto('keygen-name', CUSTOM);
      await text(`${CUSTOM} or ${CUSTOM}.pub already exists in this folder.`).waitForDisplayed({
        timeout: 10000,
      });

      await clickId('keygen-folder-reset');
      await waitGone('keygen-folder-reset');
      await expect(byId('keygen-folder')).not.toHaveValue(customDir());
      await cancelDialog();
      await openGenerate();
      await expect(byId('keygen-folder-reset')).not.toExist();
      await cancelDialog();
    });

    it('registers a key, checks the host key path and confirms a template replace', async () => {
      await clickId('keys-import');
      await byId('keyimport-path').waitForDisplayed({ timeout: 10000 });
      await expect(byId('keyimport-browse')).toBeEnabled();
      await typeInto('keyimport-path', importedPath);
      await clickId('keyimport-submit');
      await waitGone('keyimport-path');
      await byId(`key-row-${IMPORTED}`).waitForDisplayed({ timeout: 20000 });

      await openHostKeyPath();
      await expect(byId('host-key-browse')).toBeEnabled();
      await typeInto('host-key-path', '~/.ssh/id_e2e.pub');
      // Field errors show once the control is touched, that is after a blur.
      await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
      await text('This is a public key').waitForDisplayed({ timeout: 10000 });

      await typeInto('host-key-path', '${key_path}');
      for (const answer of ['Keep template', 'Replace']) {
        await clickId('host-key-pick');
        await clickId(`host-key-option-${IMPORTED}`);
        const button = $(`//tui-dialog//button[normalize-space()="${answer}"]`);
        await button.waitForClickable({ timeout: 10000 });
        if (answer === 'Keep template') await shot('keys-18-host-template-confirm');
        await button.click();
        await button.waitForExist({ timeout: 10000, reverse: true });
      }
      await expect(byId('host-key-path')).toHaveValue(expect.stringContaining(IMPORTED));
      await clickId('dialog-cancel');
      await waitGone('host-key-path');
    });

    it('deletes a custom-folder key only when its files are ticked', async () => {
      await clickId('ssh-keys');
      await openKeyMenu(IMPORTED, 'key-delete');
      await confirmDeleteDialog();
      await waitGone(`key-row-${IMPORTED}`);

      await openKeyMenu(CUSTOM, 'key-delete');
      await expect(byId('key-delete-files')).not.toBeChecked();
      await shot('keys-17-delete-custom-folder');
      await clickId('key-delete-files');
      await expect(byId('key-delete-files')).toBeChecked();
      await confirmDeleteDialog();
      await waitGone(`key-row-${CUSTOM}`);
      expect(existsSync(customKey())).toBe(false);
      expect(existsSync(`${customKey()}.pub`)).toBe(false);
    });
  });
});

async function confirmDeleteDialog(): Promise<void> {
  const button = $('//tui-dialog//button[normalize-space()="Delete"]');
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await button.waitForExist({ timeout: 10000, reverse: true });
}
