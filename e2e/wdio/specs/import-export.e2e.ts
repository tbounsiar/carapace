import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { EMPTY_DATA, readData, writeData } from '../helpers/app-files';
import { restartApp } from '../helpers/app-process';
import { HOST } from '../helpers/fixture';
import { screenshotThemes, shotWithMenu } from '../helpers/screenshot';
import {
  byId,
  clickId,
  confirmDialog,
  connect,
  enterProject,
  hostStatus,
  openGlobalVariables,
  saveVariables,
  textOf,
  tid,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

/**
 * Runs on its own tauri-driver (see `wdio.conf.ts`): both data pickers of this `e2e-pickers`
 * build return `E2E_PICKED_FILE`, which the steps rewrite or read.
 */
const PICKED = process.env['E2E_PICKED_FILE'] ?? '';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const PROJECT_ID = '6f1c0d2e-4b3a-4c5d-8e9f-0a1b2c3d4e5f';
const COLLECTION_ID = 'a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d';
const API_ID = 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e';
const VPS_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';

/** Global `user` (plain) and `db_pw` (secret, no keychain value), Payments > Backend > api-1, Home vps. */
const SEED = {
  version: 3,
  variables: [
    { name: 'user', kind: 'plain', value: 'deploy' },
    { name: 'db_pw', kind: 'secret' },
  ],
  projects: [
    {
      id: PROJECT_ID,
      name: 'Payments',
      variables: [{ name: 'db_host', kind: 'plain', value: '10.0.1.9' }],
    },
  ],
  nodes: [
    {
      kind: 'collection',
      id: COLLECTION_ID,
      name: 'Backend',
      projectId: PROJECT_ID,
      parentId: null,
    },
    {
      kind: 'host',
      id: API_ID,
      name: 'api-1',
      projectId: PROJECT_ID,
      parentId: COLLECTION_ID,
      hostname: '${db_host}',
      port: '22',
      username: '${user}',
      auth: { kind: 'password', password: '${db_pw}' },
    },
    {
      kind: 'host',
      id: VPS_ID,
      name: 'vps',
      projectId: null,
      parentId: null,
      hostname: 'vps.example.com',
      port: '22',
      username: '${user}',
      auth: { kind: 'agent' },
    },
  ],
  keys: [],
};

type FileNode = {
  kind: string;
  id: string;
  name: string;
  hostname?: string;
  projectId?: string | null;
};
type DataFile = {
  format: string;
  version: number;
  scope: { kind: string; projectId?: string; includeShared?: boolean };
  variables: { name: string; kind: string; value?: string }[];
  projects: { name: string }[];
  nodes: FileNode[];
  keys: unknown[];
};

const readPicked = (): DataFile => JSON.parse(readFileSync(PICKED, 'utf8'));
const writePicked = (content: object | string) =>
  writeFileSync(PICKED, typeof content === 'string' ? content : JSON.stringify(content, null, 2));

const hostNames = () =>
  (readData().nodes as FileNode[])
    .filter((n) => n.kind === 'host')
    .map((n) => n.name)
    .sort();
const projectNames = () => (readData().projects as { name: string }[]).map((p) => p.name).sort();

async function waitToast(text: string): Promise<void> {
  await $(`(//tui-root//*[contains(normalize-space(), "${text}")])[last()]`).waitForExist({
    timeout: 10000,
    timeoutMsg: `no toast "${text}"`,
  });
}

async function openSettings(): Promise<void> {
  await clickId('settings');
  await byId('settings-title').waitForDisplayed({ timeout: 10000 });
}

async function showHome(): Promise<void> {
  await clickId('home-link');
  await byId('home-menu').waitForClickable({ timeout: 10000 });
}

/** Starts an import from the Home "…" menu (Home must hold something). */
async function importFromHomeMenu(): Promise<void> {
  await showHome();
  await clickId('home-menu');
  await clickId('home-import');
  await byId('import-dialog').waitForDisplayed({ timeout: 15000 });
}

async function chooseStrategy(strategy: 'merge' | 'replace' | 'duplicate'): Promise<void> {
  await clickId(`import-strategy-${strategy}`);
  await browser.waitUntil(
    () =>
      browser.execute(
        (sel: string) => document.querySelector<HTMLInputElement>(`${sel} input`)?.checked ?? false,
        tid(`import-strategy-${strategy}`),
      ),
    { timeout: 5000, timeoutMsg: `${strategy} not selected` },
  );
}

/** Opens the Details accordion of the preview if it starts closed, and scrolls it into view. */
async function showDetails(): Promise<void> {
  await byId('import-details').waitForExist({ timeout: 10000 });
  const firstItem = async () =>
    (await $$(`${tid('import-details')} [data-testid^="import-item-"]`))[0];
  if (!(await (await firstItem()).isDisplayed())) {
    await $(`${tid('import-details')} button`).click();
    await browser.waitUntil(async () => (await firstItem()).isDisplayed(), {
      timeout: 5000,
      timeoutMsg: 'Details did not open',
    });
  }
  await byId('import-details').scrollIntoView({ block: 'start' });
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

async function submitImport(): Promise<void> {
  await clickId('import-submit');
}

async function waitSummary(): Promise<void> {
  await byId('import-summary').waitForDisplayed({ timeout: 15000 });
}

async function done(): Promise<void> {
  await clickId('import-done');
  await waitGone('import-dialog');
}

const THROWAWAY = 'e2e-throwaway-value';
let secretStored = false;

/** The secrets warning needs a keychain value: one throwaway value, deleted with its variable. */
async function forgetThrowawaySecret(): Promise<void> {
  if (!secretStored) return;
  await openGlobalVariables();
  await clickId('var-remove-1');
  await saveVariables();
  secretStored = false;
}

describe('Import and export of data', () => {
  let everything: DataFile;

  before(async () => {
    await waitForApp();
    await restartApp(() => writeData(SEED));
    await waitForApp();
  });

  after(async () => {
    rmSync(PICKED, { force: true });
    await forgetThrowawaySecret();
  });

  it('shows the Data section of Settings', async () => {
    await openSettings();
    await byId('settings-data').scrollIntoView();
    await expect(byId('settings-export')).toBeEnabled();
    await expect(byId('settings-import')).toBeEnabled();
    await shot('io-01-settings-data');
  });

  it('exports everything without secret values', async () => {
    rmSync(PICKED, { force: true });
    await clickId('settings-export');
    await byId('export-dialog').waitForDisplayed({ timeout: 10000 });
    const all = await textOf('export-scope-all');
    expect(all).toContain('1 project');
    expect(all).toContain('2 hosts');
    await expect(byId('export-secrets-note')).toBeDisplayed();
    await shot('io-02-export-dialog');
    await clickId('export-scope-project');
    await byId('export-project-select').waitForDisplayed({ timeout: 5000 });
    await shot('io-03-export-project');
    await clickId('export-scope-all');
    await clickId('export-submit');
    await waitGone('export-dialog');
    await waitToast('Exported to picked.json');

    everything = readPicked();
    expect(everything.format).toBe('carapace-data');
    expect(everything.version).toBe(1);
    expect(everything.scope.kind).toBe('all');
    expect(everything.projects.map((p) => p.name)).toEqual(['Payments']);
    const secret = everything.variables.find((v) => v.name === 'db_pw');
    expect(secret).toEqual({ name: 'db_pw', kind: 'secret' });
    const api = everything.nodes.find((n) => n.name === 'api-1') as unknown as {
      auth: { password: string | null };
    };
    expect(api.auth.password).toBe('${db_pw}');
  });

  it('exports a project with the globals its hosts use', async () => {
    rmSync(PICKED, { force: true });
    await enterProject('Payments');
    await byId('project-home').waitForDisplayed({ timeout: 15000 });
    await clickId('project-menu');
    await clickId('project-export');
    await byId('export-dialog').waitForDisplayed({ timeout: 10000 });
    await browser.waitUntil(
      () =>
        browser.execute(
          (sel: string) =>
            document.querySelector<HTMLInputElement>(`${sel} input`)?.checked ?? false,
          tid('export-scope-project'),
        ),
      { timeout: 5000, timeoutMsg: 'project scope not preselected' },
    );
    await clickId('export-submit');
    await waitGone('export-dialog');
    const file = readPicked();
    expect(file.scope).toEqual({ kind: 'project', projectId: PROJECT_ID, includeShared: true });
    expect(file.nodes.map((n) => n.name).sort()).toEqual(['Backend', 'api-1']);
    expect(file.variables.map((v) => v.name).sort()).toEqual(['db_pw', 'user']);
    expect(file.variables.find((v) => v.name === 'db_pw')).not.toHaveProperty('value');
  });

  it('imports into an empty Home with Merge and lists the secrets to set', async () => {
    await restartApp(() => writeData(EMPTY_DATA));
    await waitForApp();
    writePicked(everything);
    await byId('welcome-import').waitForClickable({ timeout: 15000 });
    await shot('io-13-welcome-import');
    await clickId('welcome-import');
    await byId('import-dialog').waitForDisplayed({ timeout: 15000 });
    expect(await textOf('import-file')).toBe('picked.json');
    expect(await textOf('import-file-meta')).toContain('Everything');
    expect(await textOf('import-row-host')).toContain('2');
    await shot('io-04-preview-merge');
    await chooseStrategy('replace');
    await shot('io-05-preview-replace');
    await chooseStrategy('duplicate');
    await shot('io-06-preview-duplicate');
    await chooseStrategy('merge');
    await expect(byId('import-needs-secret')).toBeDisplayed();
    await submitImport();
    await waitSummary();
    expect(await textOf('import-needs-secret')).toContain('db_pw');
    expect(await textOf('import-backup-name')).toMatch(/^data-\d{8}-\d{6}.*-before-import\.json$/);
    await shot('io-07-summary');
    await done();
    expect(projectNames()).toEqual(['Payments']);
    expect(hostNames()).toEqual(['api-1', 'vps']);
    await byId('project-card-Payments').waitForDisplayed({ timeout: 10000 });
  });

  it('merges a file that changes a host and adds one', async () => {
    const changed = structuredClone(everything);
    changed.nodes = changed.nodes.map((n) =>
      n.name === 'vps' ? { ...n, hostname: 'vps2.example.com' } : n,
    );
    changed.nodes.push({
      kind: 'host',
      id: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a',
      name: 'web-2',
      projectId: null,
      parentId: null,
      hostname: HOST.hostname,
      port: HOST.port,
      username: HOST.username,
      auth: { kind: 'key', keyPath: HOST.keyPath, passphrase: null },
    } as FileNode);
    writePicked(changed);
    await showHome();
    await shotWithMenu('io-12-home-menu', 'home-menu', 'home-import');
    await importFromHomeMenu();
    const vps = await textOf('import-item-host-vps');
    expect(vps).toContain('vps.example.com');
    expect(vps).toContain('vps2.example.com');
    expect(vps).toContain('Updated');
    await showDetails();
    await shot('io-04b-preview-merge-details');
    await submitImport();
    await waitSummary();
    await done();
    const node = (readData().nodes as FileNode[]).find((n) => n.name === 'vps');
    expect(node?.hostname).toBe('vps2.example.com');
    expect(hostNames()).toEqual(['api-1', 'vps', 'web-2']);
  });

  it('asks before a Replace that deletes a connected host', async () => {
    await showHome();
    await connect('web-2');
    await acceptHostKeyIfAsked(async () => (await hostStatus('web-2')) === 'Connected');
    await waitStatus('web-2', 'Connected');
    writePicked(everything);
    await importFromHomeMenu();
    await chooseStrategy('replace');
    expect(await textOf('import-row-host')).toContain('1');
    await expect(byId('import-item-host-web-2')).toExist();
    expect(await textOf('import-warning-connections')).toContain('web-2');
    expect(await textOf('import-submit')).toBe('Replace…');
    await byId('import-table').scrollIntoView({ block: 'start' });
    await shot('io-05b-preview-replace');
    await byId('import-warning-connections').scrollIntoView({ block: 'center' });
    await shot('io-05c-preview-replace-warnings');
    await submitImport();
    const replace = $('//tui-dialog//button[normalize-space()="Replace"]');
    await replace.waitForClickable({ timeout: 10000 });
    const confirmText = 'with its saved passwords. 1 open connection is closed.';
    await $(
      `//tui-dialog//*[contains(normalize-space(), "${confirmText}")][not(*[contains(normalize-space(), "${confirmText}")])]`,
    ).waitForExist({ timeout: 5000 });
    await shot('io-08-replace-confirm');
    const cancel = $('//tui-dialog//button[normalize-space()="Cancel"][not(@data-testid)]');
    await cancel.click();
    await replace.waitForExist({ timeout: 10000, reverse: true });
    expect(hostNames()).toEqual(['api-1', 'vps', 'web-2']);
    await submitImport();
    await confirmDialog('Replace');
    await waitSummary();
    await done();
    expect(hostNames()).toEqual(['api-1', 'vps']);
    expect((readData().nodes as FileNode[]).find((n) => n.name === 'vps')?.hostname).toBe(
      'vps.example.com',
    );
  });

  it('keeps both as copies, then undoes the import', async () => {
    writePicked(everything);
    await importFromHomeMenu();
    await chooseStrategy('duplicate');
    await showDetails();
    expect(await textOf('import-details')).toContain('Payments (imported)');
    await shot('io-06b-preview-duplicate');
    await submitImport();
    await waitSummary();
    expect(projectNames()).toEqual(['Payments', 'Payments (imported)']);
    await clickId('import-undo');
    await byId('import-undone').waitForDisplayed({ timeout: 15000 });
    await shot('io-09-undone');
    expect(projectNames()).toEqual(['Payments']);
    expect(hostNames()).toEqual(['api-1', 'vps']);
    await done();
  });

  it('asks to trust the servers a saved secret would go to', async () => {
    await openGlobalVariables();
    expect(await byId('var-name-1').getValue()).toBe('db_pw');
    await byId('var-value-1').setValue(THROWAWAY);
    await saveVariables();
    secretStored = true;
    const redirected = structuredClone(everything) as DataFile & {
      projects: { name: string; variables: { name: string; value: string }[] }[];
    };
    redirected.projects[0].variables = [
      { name: 'db_host', kind: 'plain', value: '10.9.9.9' } as never,
    ];
    writePicked(redirected);
    await importFromHomeMenu();
    const warning = await textOf('import-secrets-warning');
    expect(warning).toContain('Saved secrets will go to new servers');
    expect(warning).toContain('api-1 will send db_pw to deploy@10.9.9.9:22');
    await expect(byId('import-submit')).toBeDisabled();
    await shot('io-11-secrets-warning');
    await byId('import-submit').scrollIntoView({ block: 'end' });
    await expect(byId('import-secrets-ack')).toBeDisplayed();
    await shot('io-11b-secrets-ack-unchecked');
    await clickId('import-secrets-ack');
    await expect(byId('import-submit')).toBeEnabled();
    await byId('import-submit').scrollIntoView({ block: 'end' });
    await shot('io-11b-secrets-ack-checked');
    await chooseStrategy('duplicate');
    await chooseStrategy('merge');
    await expect(byId('import-submit')).toBeDisabled();
    await clickId('dialog-cancel');
    await waitGone('import-dialog');
    await forgetThrowawaySecret();
    expect(JSON.stringify(readData())).not.toContain(THROWAWAY);
  });

  it('explains files it cannot import', async () => {
    writePicked({ format: 'carapace-data', version: 99 });
    await importFromHomeMenu();
    expect(await textOf('import-file')).toBe('picked.json');
    expect(await textOf('import-error')).toContain('This file needs a newer Carapace');
    expect(await textOf('import-error')).toContain('data format 99');
    await shot('io-10-error-version');

    writePicked('{ "format": "carapace-data",\n  "version": ');
    await clickId('import-choose-another');
    await browser.waitUntil(
      async () => (await textOf('import-error')).includes('This file is damaged'),
      { timeout: 10000, timeoutMsg: 'no malformed error' },
    );
    expect(await textOf('import-error')).toMatch(/line \d+, column \d+/);

    writePicked({
      format: 'carapace-data',
      version: 1,
      scope: { kind: 'home' },
      variables: [{ name: 'db_pw', kind: 'secret', value: 'e2e-not-a-secret' }],
      projects: [],
      nodes: [],
      keys: [],
    });
    await clickId('import-choose-another');
    await browser.waitUntil(
      async () => (await textOf('import-error')).includes('This file contains a secret value'),
      { timeout: 10000, timeoutMsg: 'no secret value error' },
    );
    expect(await textOf('import-error')).not.toContain('e2e-not-a-secret');
    await clickId('dialog-cancel');
    await waitGone('import-dialog');
    expect(hostNames()).toEqual(['api-1', 'vps']);
  });
});
