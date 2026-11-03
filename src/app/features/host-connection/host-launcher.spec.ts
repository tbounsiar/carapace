import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { host } from '../../core/ipc/config.fixture';
import type { ConnectionState } from '../../core/ipc/ssh.models';
import { SshService } from '../../core/ipc/ssh';
import { HostViews } from '../host-detail/host-view';
import { TerminalSessions } from '../terminal/terminal-sessions';
import { HostConnector } from './host-connector';
import { HostLauncher } from './host-launcher';

describe('HostLauncher', () => {
  let launcher: HostLauncher;
  let state: ConnectionState;
  let navigated: boolean;
  const router = { navigate: vi.fn(() => Promise.resolve(navigated)) };
  const connector = {
    connect: vi.fn(() => {
      state = 'connected';
      return Promise.resolve();
    }),
  };
  const sessions = { tabs: vi.fn(() => [] as unknown[]), open: vi.fn(() => Promise.resolve(null)) };
  const api = host('h1', 'api');

  beforeEach(async () => {
    vi.clearAllMocks();
    state = 'idle';
    navigated = true;
    await import('../terminal/terminal-sessions');
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: router },
        { provide: SshService, useValue: { stateOf: () => state } },
        { provide: HostConnector, useValue: connector },
        { provide: TerminalSessions, useValue: sessions },
      ],
    });
    launcher = TestBed.inject(HostLauncher);
  });

  it('opens a host on the asked view', async () => {
    await launcher.open(api, 'files');
    expect(TestBed.inject(HostViews).of('h1')).toBe('files');
    expect(router.navigate).toHaveBeenCalledWith(['/hosts', 'h1']);
  });

  it('connects and opens a terminal when the host has none', async () => {
    await launcher.openTerminal(api);
    expect(TestBed.inject(HostViews).of('h1')).toBe('terminal');
    expect(connector.connect).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'h1' }));
    expect(sessions.open).toHaveBeenCalledWith('h1');
  });

  it('keeps the existing terminal of a connected host', async () => {
    state = 'connected';
    sessions.tabs.mockReturnValueOnce([{}]);
    await launcher.openTerminal(api);
    expect(connector.connect).not.toHaveBeenCalled();
    expect(sessions.open).not.toHaveBeenCalled();
  });

  it('stops when the connection fails or the navigation is refused', async () => {
    connector.connect.mockImplementationOnce(() => Promise.resolve());
    await launcher.openTerminal(api);
    expect(sessions.open).not.toHaveBeenCalled();

    navigated = false;
    await launcher.openTerminal(api);
    expect(connector.connect).toHaveBeenCalledTimes(1);
  });
});
