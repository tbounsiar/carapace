import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOST, PROJECT } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import {
  byId,
  clickId,
  connect,
  createHost,
  createProject,
  disconnect,
  typeInto,
  waitForApp,
  waitGone,
  waitStatus,
} from '../helpers/ui';

const work = resolve(__dirname, '..', '..', '.work');
const secret = (file: string) => readFileSync(resolve(work, file), 'utf8').trim();
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const PW_HOST = 'pw';
const ENC_HOST = 'enc';

async function submitCredential(value: string): Promise<void> {
  await byId('credential-secret').waitForDisplayed({ timeout: 20000 });
  await expect(byId('credential-remember')).not.toBeChecked();
  await typeInto('credential-secret', value);
  await clickId('credential-submit');
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

const errorShown = () => byId('credential-error').isDisplayed();
const gone = async () => !(await byId('credential-secret').isExisting());

describe('credentials', () => {
  before(waitForApp);

  it('creates a password host without storing a secret', async () => {
    await createProject(PROJECT);
    await createHost(PROJECT, {
      name: PW_HOST,
      hostname: HOST.hostname,
      port: HOST.port,
      username: HOST.username,
      auth: 'password',
    });
    await waitStatus(PW_HOST, 'Not connected');
  });

  it('prompts for the password, rejects a wrong one, then connects', async () => {
    await connect(PW_HOST);
    await byId('credential-secret').waitForDisplayed({ timeout: 20000 });
    await expect(byId('credential-error')).not.toExist();
    await shot('cred-01-password-prompt');

    await submitCredential('definitely-wrong');
    await acceptHostKeyIfAsked(errorShown);
    await shot('cred-02-password-error');

    await submitCredential(secret('password'));
    await acceptHostKeyIfAsked(gone);
    await waitStatus(PW_HOST, 'Connected');
  });

  it('prompts for the passphrase of an encrypted key', async () => {
    await createHost(PROJECT, {
      name: ENC_HOST,
      hostname: HOST.hostname,
      port: HOST.port,
      username: HOST.username,
      keyPath: resolve(work, 'id_ed25519_enc'),
    });
    await waitStatus(ENC_HOST, 'Not connected');
    await connect(ENC_HOST);
    await byId('credential-secret').waitForDisplayed({ timeout: 20000 });
    await expect(byId('credential-error')).not.toExist();
    await shot('cred-03-passphrase-prompt');

    await submitCredential('definitely-wrong');
    await acceptHostKeyIfAsked(errorShown);
    await shot('cred-04-passphrase-error');

    await submitCredential(secret('passphrase'));
    await waitGone('credential-secret');
    await waitStatus(ENC_HOST, 'Connected');
  });

  it('stays disconnected when the prompt is cancelled', async () => {
    await disconnect(ENC_HOST);
    await waitStatus(ENC_HOST, 'Not connected');
    await connect(ENC_HOST);
    await byId('credential-secret').waitForDisplayed({ timeout: 20000 });
    await clickId('credential-cancel');
    await waitGone('credential-secret');
    await browser.pause(1500);
    await expect(byId('credential-secret')).not.toExist();
    await expect(byId('host-key-accept')).not.toExist();
    await expect(byId(`status-host-${ENC_HOST}`)).not.toHaveAttribute('aria-label', 'Connected');
    await shot('cred-05-cancelled');
  });
});
