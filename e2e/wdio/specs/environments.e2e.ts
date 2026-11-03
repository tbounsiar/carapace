import { resolve } from 'node:path';
import { PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  addEnvironment,
  addPlainVariables,
  byId,
  clickId,
  connect,
  createHost,
  createProject,
  openGlobalVariables,
  openProjectVariables,
  saveVariables,
  selectEnvironment,
  selectScope,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const keyPath = resolve(__dirname, '..', '..', '.work', 'id_ed25519');
const HOST_NAME = 'ui';

const pageText = () => browser.execute(() => document.body.innerText);

async function waitPageText(text: string): Promise<void> {
  await browser.waitUntil(async () => (await pageText()).includes(text), {
    timeout: 20000,
    timeoutMsg: `page never showed "${text}"`,
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

describe('environments and variables', () => {
  before(waitForApp);

  it('defines a global variable', async () => {
    await createProject(PROJECT);
    await openGlobalVariables();
    await addPlainVariables([{ name: 'user', value: 'carapace' }]);
    await shot('env-01-global-variables');
    await saveVariables();
  });

  it('defines the Dev and Broken environments', async () => {
    await openProjectVariables(PROJECT);
    await addEnvironment('Dev');
    await addEnvironment('Broken');
    await selectScope('vars-scope-env-Dev');
    await addPlainVariables([
      { name: 'host', value: '127.0.0.1' },
      { name: 'port', value: '2223' },
    ]);
    await shot('env-02-variables-dev');
    await saveVariables();
    await selectScope('vars-scope-env-Broken');
    await addPlainVariables([
      { name: 'host', value: '127.0.0.1' },
      { name: 'port', value: '1' },
    ]);
    await saveVariables();
  });

  it('creates a host made of templates', async () => {
    await selectEnvironment('Dev');
    await createHost(
      PROJECT,
      { name: HOST_NAME, hostname: '${host}', port: '${port}', username: '${user}', keyPath },
      async () => {
        await shot('env-03-host-dialog');
      },
    );
    await waitStatus(HOST_NAME, 'Not connected');
  });

  it('connects in the Dev environment', async () => {
    await clickId('env-select');
    await byId('env-option-Broken').waitForDisplayed({ timeout: 10000 });
    await shot('env-04-selector');
    await clickId('env-option-Dev');
    await connect(HOST_NAME);
    await acceptHostKeyIfAsked();
    await waitStatus(HOST_NAME, 'Connected');
    await clickId(`open-host-${HOST_NAME}`);
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await expect(byId('host-detail-title')).toHaveText(expect.stringContaining('Dev'));
    await clickId('terminal-new');
    await byId('terminal-tab-1').waitForDisplayed({ timeout: 20000 });
    await expect(byId('terminal-tab-1')).toHaveText(expect.stringContaining('Dev'));
    await browser.pause(1000);
    await shot('env-05-dev-connected');
  });

  it('fails clearly in Broken while Dev stays connected', async () => {
    await selectEnvironment('Broken');
    await waitStatus(HOST_NAME, 'Not connected');
    await connect(HOST_NAME);
    await waitStatus(HOST_NAME, 'Connection failed');
    await browser.pause(500);
    await shot('env-06-broken-error');
    await selectEnvironment('Dev');
    await waitStatus(HOST_NAME, 'Connected');
    await byId('terminal-tab-1').waitForDisplayed({ timeout: 10000 });
    await byId('terminal-view-1').waitForDisplayed({ timeout: 10000 });
  });

  it('reports missing variables', async () => {
    await createHost(PROJECT, {
      name: 'bad',
      hostname: '${missing_var}',
      port: '22',
      username: 'carapace',
      keyPath,
    });
    await connect('bad');
    await waitPageText('missing_var');
    expect((await pageText()).toLowerCase()).toContain('missing variables');
    await waitStatus('bad', 'Connection failed');
  });

  it('shows an unset secret and asks before discarding changes', async () => {
    await openProjectVariables(PROJECT);
    await clickId('vars-add');
    await byId('var-name-0').waitForDisplayed({ timeout: 10000 });
    await clickId('var-kind-0');
    await clickId('var-kind-option-secret');
    await expect(byId('var-status-0')).toHaveAttribute('aria-label', 'Not set');
    await shot('env-07-secret-row');
    await clickId('home-link');
    const keep = $('//tui-dialog//button[contains(normalize-space(),"Keep editing")]');
    await keep.waitForClickable({ timeout: 10000 });
    await keep.click();
    await expect(byId('vars-title')).toExist();
    await clickId('home-link');
    const discard = $('//tui-dialog//button[normalize-space()="Discard"]');
    await discard.waitForClickable({ timeout: 10000 });
    await discard.click();
    await byId('welcome').waitForDisplayed({ timeout: 10000 });
  });
});
