import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { host } from '../../core/ipc/config.fixture';
import type { ConnectionState, EndReason } from '../../core/ipc/ssh.models';
import { SshService } from '../../core/ipc/ssh';
import type { TerminalTab, TerminalTabState } from '../terminal/terminal-sessions';
import { TerminalSessions } from '../terminal/terminal-sessions';
import { Workspace } from '../workspace/workspace';
import { HostConnector } from './host-connector';
import { HostLauncher } from './host-launcher';

@Component({ template: '' })
class Blank {}

function fakeTab(n: number, connectionId = 'h1'): TerminalTab {
  return {
    key: n,
    n,
    connectionId,
    state: signal<TerminalTabState>('open'),
    reason: signal(null),
  };
}

describe('HostLauncher', () => {
  let launcher: HostLauncher;
  let workspace: Workspace;
  let router: Router;
  const states = signal<Record<string, ConnectionState>>({});
  const endReasons = signal<Record<string, EndReason>>({});
  const ssh = { states, endReasons, stateOf: (id: string) => states()[id] ?? 'idle' };
  const connector = {
    connect: vi.fn((target: { connectionId: string }) => {
      states.update((s) => ({ ...s, [target.connectionId]: 'connected' }));
      return Promise.resolve();
    }),
  };
  let numbers: number;
  const opened: TerminalTab[] = [];
  const sessions = {
    open: vi.fn((connectionId: string) => {
      const tab = fakeTab(++numbers, connectionId);
      opened.push(tab);
      return Promise.resolve(tab);
    }),
    reopen: vi.fn((tab: TerminalTab) => {
      (tab.state as ReturnType<typeof signal<TerminalTabState>>).set('open');
      return Promise.resolve();
    }),
    close: vi.fn(() => Promise.resolve()),
  };
  const api = host('h1', 'api');
  const db = host('h2', 'db');

  beforeEach(async () => {
    vi.clearAllMocks();
    states.set({});
    endReasons.set({});
    numbers = 0;
    opened.length = 0;
    await import('../terminal/terminal-sessions');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: SshService, useValue: ssh },
        { provide: HostConnector, useValue: connector },
        { provide: TerminalSessions, useValue: sessions },
      ],
    });
    launcher = TestBed.inject(HostLauncher);
    workspace = TestBed.inject(Workspace);
    router = TestBed.inject(Router);
  });

  it('opens the host page', async () => {
    expect(await launcher.open(api)).toBe(true);
    expect(router.url).toBe('/hosts/h1');
    expect(await launcher.open(api)).toBe(true);
  });

  it('openTerminal connects and opens a new terminal tab when the host has none', async () => {
    await launcher.openTerminal(api);
    expect(connector.connect).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'h1' }));
    expect(sessions.open).toHaveBeenCalledWith('h1');
    const [tab] = workspace.tabs();
    expect(tab).toMatchObject({ kind: 'terminal', key: 'terminal:h1:1', label: 'Terminal 1' });
    expect(router.url).toBe(`/tabs/${tab.id}`);
    expect(tab.status()).toEqual({ kind: 'connected', word: 'Connected' });
  });

  it('openTerminal focuses the most recently used running terminal without connecting', async () => {
    states.set({ h1: 'connected' });
    await launcher.newTerminal(api);
    await launcher.newTerminal(api);
    const [first] = workspace.tabs();
    await workspace.activate(first);
    await router.navigate(['/']);
    vi.clearAllMocks();
    await launcher.openTerminal(api);
    expect(sessions.open).not.toHaveBeenCalled();
    expect(connector.connect).not.toHaveBeenCalled();
    expect(router.url).toBe(`/tabs/${first.id}`);
  });

  it('openTerminal reopens the most recent ended terminal before opening a new one', async () => {
    states.set({ h1: 'connected' });
    await launcher.newTerminal(api);
    const [tab] = workspace.tabs();
    (opened[0].state as ReturnType<typeof signal<TerminalTabState>>).set('ended');
    states.set({});
    await launcher.openTerminal(api);
    expect(connector.connect).toHaveBeenCalled();
    expect(sessions.reopen).toHaveBeenCalledWith(opened[0]);
    expect(sessions.open).toHaveBeenCalledTimes(1);
    expect(workspace.tabs()).toHaveLength(1);
    expect(router.url).toBe(`/tabs/${tab.id}`);
  });

  it('stays on the host page when the connection does not succeed', async () => {
    connector.connect.mockImplementationOnce(() => Promise.resolve());
    await launcher.openTerminal(api);
    expect(sessions.open).not.toHaveBeenCalled();
    expect(workspace.tabs()).toEqual([]);
    expect(router.url).toBe('/hosts/h1');
  });

  it('newTerminal always opens one and inserts it after the tabs of the same host', async () => {
    states.set({ h1: 'connected', h2: 'connected' });
    await launcher.newTerminal(api);
    await launcher.newTerminal(db);
    await launcher.newTerminal(api);
    expect(workspace.tabs().map((t) => t.key)).toEqual([
      'terminal:h1:1',
      'terminal:h1:3',
      'terminal:h2:2',
    ]);
  });

  it('newTerminal goes through the host page unless a tab of the host is active', async () => {
    states.set({ h1: 'connected' });
    const navigate = vi.spyOn(router, 'navigate');
    await launcher.newTerminal(api);
    expect(navigate).toHaveBeenCalledWith(['/hosts', 'h1']);
    navigate.mockClear();
    await launcher.newTerminal(api);
    expect(navigate).not.toHaveBeenCalledWith(['/hosts', 'h1']);
  });

  it('openFiles focuses or opens the one Files tab without connecting', async () => {
    await launcher.openFiles(api);
    await launcher.openFiles(api);
    expect(connector.connect).not.toHaveBeenCalled();
    const tabs = workspace.tabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'files', key: 'files:h1', label: 'Files' });
    expect(tabs[0].status().word).toBe('Disconnected');
    endReasons.set({ h1: 'lost' });
    expect(tabs[0].status().kind).toBe('lost');
    expect(router.url).toBe(`/tabs/${tabs[0].id}`);
  });

  it('closing a terminal tab closes its shell but not the connection', async () => {
    states.set({ h1: 'connected' });
    await launcher.newTerminal(api);
    await workspace.remove(workspace.tabs()[0]);
    expect(sessions.close).toHaveBeenCalledWith(opened[0]);
    expect(states()['h1']).toBe('connected');
    expect(router.url).toBe('/hosts/h1');
    expect(workspace.headingFocus()).toBe(true);
  });
});
