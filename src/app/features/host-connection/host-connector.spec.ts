import { TestBed } from '@angular/core/testing';
import { TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { IpcError } from '../../core/ipc/ipc-error';
import { type ConnectHandlers, SshService } from '../../core/ipc/ssh';
import type { HostKeyChanged } from '../../core/ipc/ssh.models';
import { HostKeyPrompter } from '../host-key-dialog/host-key-prompter';
import { HostConnector } from './host-connector';

describe('HostConnector', () => {
  const ssh = {
    connect: vi.fn<(id: string, handlers: ConnectHandlers) => Promise<unknown>>(),
    disconnect: vi.fn(() => Promise.resolve()),
    replaceHostKey: vi.fn(() => Promise.resolve()),
  };
  const prompter = { ask: vi.fn(), confirmReplace: vi.fn() };
  const alerts = { open: vi.fn(() => of(undefined)) };
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
    ssh.connect.mockResolvedValue({ hostId: 'h1', state: 'connected' });
    TestBed.configureTestingModule({
      providers: [
        { provide: SshService, useValue: ssh },
        { provide: HostKeyPrompter, useValue: prompter },
        { provide: TuiNotificationService, useValue: alerts },
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
});
