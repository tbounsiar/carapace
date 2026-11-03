import { resolve } from 'node:path';
import { PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  addPlainVariables,
  byId,
  clickId,
  connect,
  createHost,
  createProject,
  enterProject,
  openGlobalVariables,
  openProjectVariables,
  saveVariables,
  textOf,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const keyPath = resolve(__dirname, '..', '..', '.work', 'id_ed25519');
const TEMPLATED = { hostname: '${host}', port: '${port}', username: '${user}', keyPath };

const pageText = () => browser.execute(() => document.body.innerText);

async function waitPageText(text: string): Promise<void> {
  await browser.waitUntil(async () => (await pageText()).includes(text), {
    timeout: 20000,
    timeoutMsg: `page never showed "${text}"`,
  });
}

const names = () =>
  browser.execute(() =>
    [...document.querySelectorAll<HTMLInputElement>('[data-testid^="var-name-"]')].map(
      (i) => i.value,
    ),
  );

async function expectPreview(text: string): Promise<void> {
  await browser.waitUntil(async () => (await textOf('host-preview')).includes(text), {
    timeout: 5000,
    timeoutMsg: `the host preview never showed "${text}"`,
  });
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

describe('variables', () => {
  before(waitForApp);

  it('defines global variables', async () => {
    await openGlobalVariables();
    await expect(byId('vars-title')).toHaveText('Global variables');
    // The global port is wrong on purpose: only the project override reaches the sshd.
    await addPlainVariables([
      { name: 'user', value: 'carapace' },
      { name: 'port', value: '1' },
    ]);
    await shot('vars-01-global');
    await saveVariables();
    expect(await names()).toEqual(['user', 'port']);
  });

  it('defines project variables, one overriding a global one', async () => {
    await createProject(PROJECT);
    await openProjectVariables(PROJECT);
    await expect(byId('vars-title')).not.toExist();
    await expect(byId('project-home-title')).toHaveText(PROJECT);
    await expect(byId('project-tab-variables')).toHaveElementClass('_active');
    await expect(byId('vars-empty')).toExist();
    await addPlainVariables([
      { name: 'host', value: '127.0.0.1' },
      { name: 'port', value: '2223' },
    ]);
    await shot('vars-02-project');
    await saveVariables();
    expect(await names()).toEqual(['host', 'port']);
  });

  it('previews a templated project host with the project value', async () => {
    await createHost(PROJECT, { name: 'ui', ...TEMPLATED }, async () => {
      await expectPreview('Resolves to carapace@127.0.0.1:2223');
      await shot('vars-03-host-dialog');
    });
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await expect(byId('host-detail-title')).toHaveText('ui');
    await browser.waitUntil(
      async () => (await textOf('host-detail-address')) === 'carapace@127.0.0.1:2223',
      { timeout: 10000, timeoutMsg: 'the host page did not resolve the address' },
    );
    await waitStatus('ui', 'Not connected');
  });

  it('connects the templated host', async () => {
    await connect('ui');
    await acceptHostKeyIfAsked();
    await waitStatus('ui', 'Connected');
    await clickId('terminal-new');
    await byId('terminal-tab-1').waitForDisplayed({ timeout: 20000 });
    expect(await textOf('terminal-tab-1')).toBe('Terminal 1');
    await browser.pause(1000);
    await shot('vars-04-connected');
  });

  it('resolves a Home host with the global variables only', async () => {
    await createHost(null, { name: 'home', ...TEMPLATED, hostname: '127.0.0.1' }, async () => {
      await expectPreview('Resolves to carapace@127.0.0.1:1');
    });
    await browser.waitUntil(
      async () => (await textOf('host-detail-address')) === 'carapace@127.0.0.1:1',
      { timeout: 10000, timeoutMsg: 'the Home host did not resolve with the global port' },
    );
    await connect('home');
    await waitStatus('home', 'Connection failed');
    await enterProject(PROJECT);
    await waitStatus('ui', 'Connected');
  });

  it('reports the variables a Home host is missing', async () => {
    await createHost(null, { name: 'bad', ...TEMPLATED, username: '${login}' }, async () => {
      await expectPreview('Missing: host, login');
      await shot('vars-05-missing-preview');
    });
    await browser.waitUntil(
      async () => (await textOf('host-detail-address')) === 'Missing variables: host, login',
      { timeout: 10000, timeoutMsg: 'the host page did not list the missing variables' },
    );
    await connect('bad');
    await waitStatus('bad', 'Connection failed');
    await waitPageText('login');
    expect((await pageText()).toLowerCase()).toContain('missing variables');
  });

  it('shows an unset secret and asks before discarding changes', async () => {
    // Secret values are never typed here: saving one writes to the OS keychain of the machine.
    await openProjectVariables(PROJECT);
    await clickId('vars-add');
    await byId('var-name-2').waitForDisplayed({ timeout: 10000 });
    await clickId('var-kind-2');
    await clickId('var-kind-option-secret');
    await expect(byId('var-status-2')).toHaveAttribute('aria-label', 'Not set');
    await shot('vars-06-secret-row');
    await clickId('home-link');
    const keep = $('//tui-dialog//button[contains(normalize-space(),"Keep editing")]');
    await keep.waitForClickable({ timeout: 10000 });
    await keep.click();
    await expect(byId('vars-add')).toExist();
    await expect(byId('project-tab-variables')).toHaveElementClass('_active');
    await clickId('home-link');
    const discard = $('//tui-dialog//button[normalize-space()="Discard"]');
    await discard.waitForClickable({ timeout: 10000 });
    await discard.click();
    await byId('welcome').waitForDisplayed({ timeout: 10000 });
  });
});
