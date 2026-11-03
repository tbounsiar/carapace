import { TestBed } from '@angular/core/testing';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { EMPTY, of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import type { Host, Project } from '../../core/ipc/config.models';
import { IpcError } from '../../core/ipc/ipc-error';
import { KeyStore } from '../../core/ipc/key-store';
import { key, KEY } from '../../core/ipc/keys.fixture';
import { SshService } from '../../core/ipc/ssh';
import { HostConnector } from '../host-connection/host-connector';
import type { NameDialogData } from '../project-tree/name-dialog/name-dialog';
import { KeyActions } from './key-actions';
import type { KeyDeployDialogData } from './key-deploy-dialog/key-deploy-dialog';

const HOST: Host = {
  id: 'h1',
  name: 'UI',
  hostname: '${host}',
  port: '22',
  username: 'deploy',
  auth: { kind: 'password', password: null },
};
const PROJECT: Project = {
  id: 'p1',
  name: 'Shop',
  variables: [],
  environments: [{ id: 'e1', name: 'Dev', variables: [] }],
  hosts: [HOST],
  activeEnvironmentId: 'e1',
};

describe('KeyActions', () => {
  const store = {
    keys: () => [KEY],
    rename: vi.fn(),
    delete: vi.fn(() => Promise.resolve()),
    forgetPassphrase: vi.fn(() => Promise.resolve()),
    deploy: vi.fn(() => Promise.resolve({ added: true, restricted: false })),
  };
  const config = {
    findHost: vi.fn((id: string) => (id === 'h1' ? { project: PROJECT, host: HOST } : null)),
    updateHost: vi.fn(() => Promise.resolve(HOST)),
  };
  let state = 'idle';
  const ssh = { stateOf: vi.fn(() => state) };
  const connector = { connect: vi.fn(() => Promise.resolve()) };
  const dialogs = { open: vi.fn((): unknown => EMPTY) };
  const alerts = { open: vi.fn(() => of(undefined)) };
  let actions: KeyActions;

  beforeEach(() => {
    vi.clearAllMocks();
    state = 'idle';
    TestBed.configureTestingModule({
      providers: [
        { provide: KeyStore, useValue: store },
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: ssh },
        { provide: HostConnector, useValue: connector },
        { provide: TuiDialogService, useValue: dialogs },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    });
    actions = TestBed.inject(KeyActions);
  });

  const lastToast = (): unknown[] => alerts.open.mock.calls.at(-1) as unknown[];

  it('connects first, deploys to the active environment and reports the result', async () => {
    connector.connect.mockImplementationOnce(() => {
      state = 'connected';
      return Promise.resolve();
    });
    expect(await actions.deployTo(KEY, 'h1', false)).toBe(true);
    expect(connector.connect).toHaveBeenCalledWith({
      projectId: 'p1',
      hostId: 'h1',
      environmentId: 'e1',
      connectionId: 'h1@e1',
    });
    expect(store.deploy).toHaveBeenCalledWith('h1@e1', 'k1');
    expect(lastToast()[0]).toBe('Key added to authorized_keys on UI · Dev');
    expect(config.updateHost).not.toHaveBeenCalled();
  });

  it('warns when the key is only present with options and does not switch the host', async () => {
    state = 'connected';
    store.deploy.mockResolvedValueOnce({ added: false, restricted: true });
    expect(await actions.deployTo(KEY, 'h1', true)).toBe(true);
    expect(lastToast()[0]).toContain('Key present with restrictions (options) on UI · Dev');
    expect(config.updateHost).not.toHaveBeenCalled();
  });

  it('reuses a live connection and reports a key already present', async () => {
    state = 'connected';
    store.deploy.mockResolvedValueOnce({ added: false, restricted: false });
    expect(await actions.deployTo(KEY, 'h1', false)).toBe(true);
    expect(connector.connect).not.toHaveBeenCalled();
    expect(lastToast()[0]).toBe('Key already present on UI · Dev');
  });

  it('stops when the connection is not established', async () => {
    expect(await actions.deployTo(KEY, 'h1', false)).toBe(false);
    expect(store.deploy).not.toHaveBeenCalled();
  });

  it('notifies a deploy failure', async () => {
    state = 'connected';
    store.deploy.mockRejectedValueOnce(new IpcError('invalid_input', 'authorized_keys is a link'));
    expect(await actions.deployTo(KEY, 'h1', true)).toBe(false);
    expect(lastToast()).toEqual([
      expect.stringContaining('Authorized_keys is a link. '),
      expect.objectContaining({ label: 'Deploy failed', appearance: 'negative' }),
    ]);
    expect(config.updateHost).not.toHaveBeenCalled();
  });

  it('switches the host to the key when asked', async () => {
    state = 'connected';
    await actions.deployTo(KEY, 'h1', true);
    expect(config.updateHost).toHaveBeenCalledWith('p1', 'h1', {
      name: 'UI',
      hostname: '${host}',
      port: '22',
      username: 'deploy',
      auth: { kind: 'key', keyPath: KEY.path, passphrase: null },
    });
  });

  it('refuses an unknown host', async () => {
    expect(await actions.deployTo(KEY, 'gone', false)).toBe(false);
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('opens the deploy dialog wired to deployTo', async () => {
    state = 'connected';
    actions.deploy(KEY);
    const options = (dialogs.open.mock.calls[0] as unknown[])[1] as { data: KeyDeployDialogData };
    expect(await options.data.deploy('h1', false)).toBe(true);
    expect(store.deploy).toHaveBeenCalled();
  });

  it('copies the public key', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await actions.copyPublicKey(KEY);
    expect(writeText).toHaveBeenCalledWith(KEY.publicKey);
    expect(lastToast()[1]).toEqual(expect.objectContaining({ label: 'Public key copied' }));

    writeText.mockRejectedValueOnce(new Error('denied'));
    await actions.copyPublicKey(KEY);
    expect(lastToast()[1]).toEqual(expect.objectContaining({ label: 'Copy failed' }));
  });

  it('forgets a passphrase', async () => {
    await actions.forgetPassphrase(KEY);
    expect(store.forgetPassphrase).toHaveBeenCalledWith('k1');
    expect(lastToast()[1]).toEqual(expect.objectContaining({ label: 'Passphrase forgotten' }));
  });

  it('deletes after confirmation, files only for managed keys', async () => {
    dialogs.open.mockReturnValueOnce(of({ deleteFiles: true }));
    expect(await actions.remove(KEY)).toBe(true);
    expect(store.delete).toHaveBeenCalledWith('k1', true);

    dialogs.open.mockReturnValueOnce(of({ deleteFiles: true }));
    await actions.remove(key({ id: 'k2', managed: false }));
    expect(store.delete).toHaveBeenLastCalledWith('k2', false);
  });

  it('does nothing when the delete is cancelled', async () => {
    expect(await actions.remove(KEY)).toBe(false);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('renames through the name dialog with key rules', async () => {
    actions.rename(KEY);
    const options = (dialogs.open.mock.calls[0] as unknown[])[1] as { data: NameDialogData };
    expect(options.data.initial).toBe(KEY.name);
    expect(options.data.conflictCode).toBe('already_exists');
    await options.data.save('main');
    expect(store.rename).toHaveBeenCalledWith('k1', 'main');
  });
});
