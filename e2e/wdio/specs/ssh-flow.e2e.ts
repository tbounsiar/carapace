import { HOST, PROJECT, rotateHostKey } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  connect,
  createHost,
  createProject,
  deleteNode,
  disconnect,
  hostStatus,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

describe('ssh flow', () => {
  before(waitForApp);

  it('creates a project and a host', async () => {
    await createProject(PROJECT);
    await shot('flow-01-tree');
    await createHost(PROJECT);
    await waitStatus(HOST.name, 'Not connected');
    await shot('flow-02-host-created');
  });

  it('asks to verify an unknown host key, then connects', async () => {
    await connect(HOST.name);
    await browser.waitUntil(
      async () =>
        (await byId('host-key-accept').isExisting()) ||
        (await byId('host-key-replace').isExisting()),
      { timeout: 20000, timeoutMsg: 'no host key dialog' },
    );
    if (await byId('host-key-replace').isExisting())
      throw new Error(
        `A stale entry for [${HOST.hostname}]:${HOST.port} exists in ~/.ssh/known_hosts; run: ssh-keygen -R "[${HOST.hostname}]:${HOST.port}"`,
      );
    await expect(byId('fingerprint')).toHaveText(expect.stringContaining('SHA256:'));
    await expect(byId('host-key-host')).toHaveText(`${HOST.hostname}:${HOST.port}`);
    await shot('flow-03-unknown-host-key');
    await clickId('host-key-accept');
    await waitGone('host-key-accept');
    await waitStatus(HOST.name, 'Connected');
    await shot('flow-04-connected');
  });

  it('reconnects without a host key prompt', async () => {
    await disconnect(HOST.name);
    await waitStatus(HOST.name, 'Not connected');
    await connect(HOST.name);
    await waitStatus(HOST.name, 'Connected');
    await expect(byId('host-key-accept')).not.toExist();
  });

  it('flags a changed host key and replaces it', async () => {
    await disconnect(HOST.name);
    await waitStatus(HOST.name, 'Not connected');
    rotateHostKey();
    await connect(HOST.name);
    await byId('host-key-replace').waitForClickable({ timeout: 30000 });
    const known = await byId('known').getText();
    const presented = await byId('presented').getText();
    expect(presented).toContain('SHA256:');
    expect(known).toContain('SHA256:');
    expect(known).not.toContain(presented);
    await shot('flow-05-changed-host-key');
    await clickId('host-key-replace');
    await waitGone('host-key-replace');
    expect(await hostStatus(HOST.name)).not.toBe('Connected');
    await shot('flow-06-key-replaced');
    await connect(HOST.name);
    await waitStatus(HOST.name, 'Connected');
    await expect(byId('host-key-accept')).not.toExist();
    await expect(byId('host-key-replace')).not.toExist();
  });

  it('keeps the data after an app restart', async () => {
    await browser.reloadSession();
    await waitForApp();
    await byId(`tree-project-${PROJECT}`).waitForExist({ timeout: 10000 });
    await byId(`tree-host-${HOST.name}`).waitForExist({ timeout: 10000 });
    await shot('flow-07-restarted');
  });

  it('deletes the host and the project', async () => {
    await deleteNode('host', HOST.name);
    await deleteNode('project', PROJECT);
    await byId('new-project').waitForExist({ timeout: 10000 });
    await expect($('app-project-tree')).toHaveText(expect.stringContaining('No projects yet'));
    await shot('flow-08-empty');
  });
});
