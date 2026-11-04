import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  createHost,
  createProject,
  enterProject,
  fillHostFields,
  type HostInput,
  newFromAside,
  openMenu,
  testHost,
  testResult,
  tid,
  typeInto,
  waitCredentialPrompt,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const work = resolve(__dirname, '..', '..', '.work');
const secret = (file: string) => readFileSync(resolve(work, file), 'utf8').trim();
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const probe = (overrides: Partial<HostInput> = {}): HostInput => ({
  name: 'probe',
  hostname: HOST.hostname,
  port: HOST.port,
  username: HOST.username,
  keyPath: HOST.keyPath,
  ...overrides,
});

async function openNewHost(): Promise<void> {
  await enterProject(PROJECT);
  await newFromAside('new-host');
  await byId('host-name').waitForDisplayed({ timeout: 10000 });
}

async function closeDialog(): Promise<void> {
  await clickId('dialog-cancel');
  await waitGone('host-name');
}

async function submitTestCredential(value: string): Promise<void> {
  await waitCredentialPrompt();
  await expect(byId('credential-remember')).not.toExist();
  await typeInto('credential-secret', value);
  await clickId('credential-submit');
}

const terminalText = (n: number) =>
  $(`${tid(`terminal-view-${n}`)} .xterm-rows`)
    .getText()
    .catch(() => '') as Promise<string>;

async function runInTerminal(n: number, command: string, expected: string): Promise<void> {
  // Until the tab opens, the focus is still on New terminal: typed spaces and Enter would click it.
  await byId(`terminal-view-${n}`).waitForDisplayed({ timeout: 20000 });
  await browser.execute(
    (sel: string) => document.querySelector<HTMLTextAreaElement>(`${sel} textarea`)?.focus(),
    tid(`terminal-view-${n}`),
  );
  await browser.keys(command.split(''));
  await browser.keys('Enter');
  await browser.waitUntil(async () => (await terminalText(n)).includes(expected), {
    timeout: 20000,
    timeoutMsg: `terminal ${n} never showed "${expected}"`,
  });
}

describe('test connection', () => {
  before(waitForApp);

  it('is not testable while a variable is missing', async () => {
    await createProject(PROJECT);
    await openNewHost();
    await fillHostFields(probe({ hostname: '${host}' }));
    await expect(byId('host-test')).toHaveAttribute('aria-disabled', 'true');
    await byId('host-test').moveTo();
    const hint = $('tui-hint');
    await hint.waitForDisplayed({ timeout: 10000 });
    await expect(hint).toHaveText(expect.stringContaining('Define the missing variables'));
    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-testid="host-test"]')?.focus(),
    );
    console.log('screenshots', await screenshotThemes('test-01-disabled', { keepFocus: true }));
    await clickId('host-test');
    await expect(byId('host-test-result')).not.toHaveAttribute('data-result');
    await closeDialog();
  });

  it('fails when the unknown host key is rejected', async () => {
    await openNewHost();
    await fillHostFields(probe());
    await testHost();
    await clickId('host-key-reject');
    await waitGone('host-key-reject');
    const result = await testResult();
    expect(result).toMatchObject({ result: 'failure', code: 'host_key_rejected' });
    expect(result.title).toBe('Host key not accepted');
    await closeDialog();
  });

  it('accepts an unknown key, connects, and creates nothing', async () => {
    await openNewHost();
    await fillHostFields(probe());
    await testHost();
    await byId('host-key-accept').waitForClickable({ timeout: 20000 });
    await expect(byId('host-key-accept')).toHaveText('Accept and test');
    await shot('test-02-host-key');
    await clickId('host-key-accept');
    await waitGone('host-key-accept');
    const result = await testResult();
    expect(result.result).toBe('success');
    expect(result.title).toBe(`Connected as ${HOST.username}@${HOST.hostname}:${HOST.port}`);
    expect(result.detail).toContain('Private key file');
    await shot('test-03-success');
    await closeDialog();
    await expect(byId('tree-host-probe')).not.toExist();
  });

  it('wrote known_hosts: the saved host connects without a prompt', async () => {
    await createHost(PROJECT);
    await waitStatus(HOST.name, 'Not connected');
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await clickId('host-new-terminal');
    await waitStatus(HOST.name, 'Connected');
    await expect(byId('host-key-accept')).not.toExist();
    await runInTerminal(1, 'echo before-test', 'before-test');
  });

  it('asks a password for the test only, again after a wrong one', async () => {
    await openNewHost();
    await fillHostFields(probe({ name: 'pw', auth: 'password' }));
    await testHost();
    await byId('credential-test-note').waitForDisplayed({ timeout: 20000 });
    await expect(byId('credential-test-note')).toHaveText(
      'Used for this test only. It is not saved.',
    );
    await expect(byId('credential-submit')).toHaveText('Test');
    await shot('test-04-prompt');
    await submitTestCredential('definitely-wrong');
    await byId('credential-error').waitForDisplayed({ timeout: 20000 });
    await submitTestCredential(secret('password'));
    await waitGone('credential-secret');
    const result = await testResult();
    expect(result.result).toBe('success');
    expect(result.detail).toContain('Password (typed for this test)');

    await clickId('dialog-save');
    await waitGone('host-name');
    await byId('tree-host-pw').waitForExist({ timeout: 10000 });
    await clickId('host-connect');
    await byId('credential-secret').waitForDisplayed({ timeout: 20000 });
    await expect(byId('credential-remember')).toExist();
    await clickId('credential-cancel');
    await waitGone('credential-secret');
  });

  it('asks the passphrase of an encrypted key, again after a wrong one', async () => {
    await openNewHost();
    await fillHostFields(probe({ name: 'enc', keyPath: resolve(work, 'id_ed25519_enc') }));
    await testHost();
    await submitTestCredential('definitely-wrong');
    await byId('credential-error').waitForDisplayed({ timeout: 20000 });
    await submitTestCredential(secret('passphrase'));
    await waitGone('credential-secret');
    const result = await testResult();
    expect(result.result).toBe('success');
    expect(result.detail).toContain('passphrase typed for this test');
    await closeDialog();
  });

  it('reports a key the server refuses', async () => {
    await openNewHost();
    await fillHostFields(probe({ name: 'wrong', keyPath: resolve(work, 'id_wrong') }));
    await testHost();
    const result = await testResult();
    expect(result).toMatchObject({ result: 'failure', code: 'auth_failed' });
    expect(result.title).toBe('The server refused the key');
    await shot('test-05-failure');
  });

  it('reports an unreachable port, and clears the result on an edit', async () => {
    await typeInto('host-port', '1');
    await testHost();
    const result = await testResult();
    expect(result).toMatchObject({ result: 'failure', code: 'network' });
    expect(result.title).toBe(`Could not reach ${HOST.hostname}:1`);
    await typeInto('host-port', HOST.port);
    await expect(byId('host-test-result')).not.toHaveAttribute('data-result');
    await closeDialog();
  });

  it('says the test was cancelled when the prompt is cancelled', async () => {
    await openNewHost();
    await fillHostFields(probe({ name: 'pw2', auth: 'password' }));
    await testHost();
    await byId('credential-secret').waitForDisplayed({ timeout: 20000 });
    await clickId('credential-cancel');
    await waitGone('credential-secret');
    const result = await testResult();
    expect(result.result).toBe('cancelled');
    expect(result.title).toBe('Test cancelled.');
    await closeDialog();
  });

  it('tests a connected host from its edit dialog without touching its session', async () => {
    await openMenu('host', HOST.name, 'menu-edit');
    await byId('host-name').waitForDisplayed({ timeout: 10000 });
    await testHost();
    const result = await testResult();
    expect(result.result).toBe('success');
    await closeDialog();
    await waitStatus(HOST.name, 'Connected');
    // A sidebar click opens the host page; the terminal lives in its workspace tab.
    await clickId(`tab-${HOST.name}-terminal-1`);
    await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
    await runInTerminal(1, 'echo after-test', 'after-test');
  });
});
