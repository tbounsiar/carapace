import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import type { AuthMethod, Project } from '../../core/ipc/config.models';
import { IpcError } from '../../core/ipc/ipc-error';
import { type ConnectHandlers, SshService } from '../../core/ipc/ssh';
import type { Credential, HostKeyChanged } from '../../core/ipc/ssh.models';
import { CredentialPrompter } from '../credential-dialog/credential-prompter';
import { HostKeyPrompter } from '../host-key-dialog/host-key-prompter';
import { HostConnector } from './host-connector';

describe('HostConnector', () => {
  const ssh = {
    connect:
      vi.fn<(id: string, handlers: ConnectHandlers, credential?: Credential) => Promise<unknown>>(),
    disconnect: vi.fn(() => Promise.resolve()),
    replaceHostKey: vi.fn(() => Promise.resolve()),
  };
  const prompter = { ask: vi.fn(), confirmReplace: vi.fn() };
  const alerts = { open: vi.fn(() => of(undefined)) };
  const credentials = { ask: vi.fn<CredentialPrompter['ask']>() };
  const projects = signal<Project[]>([]);
  const withHost = (auth: AuthMethod): void =>
    projects.set([
      {
        id: 'p1',
        name: 'P',
        environments: [
          {
            id: 'e1',
            name: 'dev',
            hosts: [
              {
                id: 'h1',
                name: 'web',
                hostname: 'web.example',
                port: 22,
                username: 'deploy',
                auth,
              },
            ],
          },
        ],
      },
    ]);
  const fail = (code: 'secret_required' | 'invalid_passphrase' | 'auth_failed'): IpcError =>
    new IpcError(code, 'safe message');
  let connector: HostConnector;

  const changed: HostKeyChanged = {
    kind: 'hostKeyChanged',
    hostname: 'h',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:new',
    knownFingerprints: ['SHA256:old'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    withHost({ kind: 'password' });
    ssh.connect.mockResolvedValue({ hostId: 'h1', state: 'connected' });
    TestBed.configureTestingModule({
      providers: [
        { provide: SshService, useValue: ssh },
        { provide: HostKeyPrompter, useValue: prompter },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: CredentialPrompter, useValue: credentials },
        { provide: ConfigService, useValue: { projects } },
      ],
    });
    connector = TestBed.inject(HostConnector);
  });

  it('connects with the host key prompter as decider', async () => {
    prompter.ask.mockResolvedValue(true);
    await connector.connect('h1');
    const handlers = ssh.connect.mock.calls[0][1];
    expect(ssh.connect.mock.calls[0][0]).toBe('h1');
    await expect(handlers.decide({} as never)).resolves.toBe(true);
    expect(prompter.ask).toHaveBeenCalledOnce();
  });

  it('notifies the safe message when connecting fails', async () => {
    withHost({ kind: 'agent' });
    ssh.connect.mockRejectedValue(new IpcError('auth_failed', 'Authentication failed'));
    await connector.connect('h1');
    expect(alerts.open).toHaveBeenCalledWith('Authentication failed', expect.anything());
  });

  it('does not notify host_key_changed, the dialog covers it', async () => {
    ssh.connect.mockRejectedValue(new IpcError('host_key_changed', 'changed'));
    await connector.connect('h1');
    expect(alerts.open).not.toHaveBeenCalled();
  });

  it('replaces the stored key only when confirmed, and never reconnects', async () => {
    prompter.confirmReplace.mockResolvedValue(true);
    await connector.connect('h1');
    ssh.connect.mock.calls[0][1].changed(changed);
    await vi.waitFor(() => expect(ssh.replaceHostKey).toHaveBeenCalledWith('h1', 'SHA256:new'));
    expect(ssh.connect).toHaveBeenCalledOnce();
  });

  it('keeps the stored key when the replacement is declined', async () => {
    prompter.confirmReplace.mockResolvedValue(false);
    await connector.connect('h1');
    ssh.connect.mock.calls[0][1].changed(changed);
    await vi.waitFor(() => expect(prompter.confirmReplace).toHaveBeenCalled());
    expect(ssh.replaceHostKey).not.toHaveBeenCalled();
  });

  it('disconnects', async () => {
    await connector.disconnect('h1');
    expect(ssh.disconnect).toHaveBeenCalledWith('h1');
  });

  describe('credential prompt', () => {
    it('prompts on secret_required and retries with the credential', async () => {
      ssh.connect.mockRejectedValueOnce(fail('secret_required'));
      credentials.ask.mockResolvedValueOnce({ secret: 'pw', remember: false });
      await connector.connect('h1');
      expect(credentials.ask).toHaveBeenCalledWith('Password', {
        kind: 'password',
        subject: expect.stringMatching(/^deploy@web\.example:\d+$/),
        error: null,
      });
      expect(ssh.connect).toHaveBeenCalledTimes(2);
      expect(ssh.connect.mock.calls[0][2]).toBeUndefined();
      expect(ssh.connect.mock.calls[1][2]).toEqual({ secret: 'pw', remember: false });
      expect(alerts.open).not.toHaveBeenCalled();
    });

    it('stops when the prompt is cancelled', async () => {
      ssh.connect.mockRejectedValue(fail('secret_required'));
      credentials.ask.mockResolvedValue(null);
      await connector.connect('h1');
      expect(ssh.connect).toHaveBeenCalledOnce();
      expect(alerts.open).not.toHaveBeenCalled();
    });

    it('re-prompts with an error line on auth_failed for a password host', async () => {
      ssh.connect.mockRejectedValueOnce(fail('auth_failed'));
      ssh.connect.mockRejectedValueOnce(fail('auth_failed'));
      credentials.ask.mockResolvedValueOnce({ secret: 'bad', remember: true });
      credentials.ask.mockResolvedValueOnce(null);
      await connector.connect('h1');
      expect(credentials.ask).toHaveBeenCalledTimes(2);
      expect(credentials.ask.mock.calls[0][1].error).toBeTruthy();
      expect(ssh.connect).toHaveBeenCalledTimes(2);
    });

    it('asks for the passphrase of a key host, with an error line when it was wrong', async () => {
      withHost({ kind: 'key', keyPath: '~/.ssh/id_enc' });
      ssh.connect.mockRejectedValueOnce(fail('secret_required'));
      ssh.connect.mockRejectedValueOnce(fail('invalid_passphrase'));
      credentials.ask.mockResolvedValueOnce({ secret: 'wrong', remember: false });
      credentials.ask.mockResolvedValueOnce({ secret: 'right', remember: true });
      await connector.connect('h1');
      expect(credentials.ask.mock.calls[0]).toEqual([
        'Key passphrase',
        { kind: 'passphrase', subject: '~/.ssh/id_enc', error: null },
      ]);
      expect(credentials.ask.mock.calls[1][1]).toMatchObject({ kind: 'passphrase' });
      expect(credentials.ask.mock.calls[1][1].error).toBeTruthy();
      expect(ssh.connect.mock.calls[2][2]).toEqual({ secret: 'right', remember: true });
    });

    it('notifies auth_failed on a key host without prompting', async () => {
      withHost({ kind: 'key', keyPath: '~/.ssh/id' });
      ssh.connect.mockRejectedValue(fail('auth_failed'));
      await connector.connect('h1');
      expect(credentials.ask).not.toHaveBeenCalled();
      expect(alerts.open).toHaveBeenCalledWith('safe message', expect.anything());
    });

    it('notifies instead of prompting for an agent host or an unknown host', async () => {
      withHost({ kind: 'agent' });
      ssh.connect.mockRejectedValue(fail('secret_required'));
      await connector.connect('h1');
      await connector.connect('missing');
      expect(credentials.ask).not.toHaveBeenCalled();
      expect(alerts.open).toHaveBeenCalledTimes(2);
    });
  });
});
