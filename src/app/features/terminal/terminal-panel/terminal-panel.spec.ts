import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { type ConnectionTarget, connectionTarget } from '../../../core/ipc/connection';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState, EndReason } from '../../../core/ipc/ssh.models';
import { Settings } from '../../../core/settings/settings';
import { TerminalIpc, type TerminalEvent } from '../../../core/ipc/terminal';
import { HostConnector } from '../../host-connection/host-connector';
import { FakeXtermFactory } from '../fake-xterm';
import { type TerminalTab, TerminalSessions } from '../terminal-sessions';
import { XtermFactory } from '../xterm-factory';
import { TerminalPanel } from './terminal-panel';

const WEB = connectionTarget('p1', 'h1');

describe('TerminalPanel', () => {
  const states = signal<Record<string, ConnectionState>>({});
  const endReasons = signal<Record<string, EndReason>>({});
  const ssh = { states, endReasons, stateOf: (id: string) => states()[id] ?? 'idle' };
  const connector = {
    connect: vi.fn((target: ConnectionTarget) => {
      states.update((s) => ({ ...s, [target.connectionId]: 'connected' }));
      return Promise.resolve();
    }),
  };
  let emits: ((event: TerminalEvent) => void)[];
  let ids: number;
  const ipc = {
    open: vi.fn((_h: string, _c: number, _r: number, emit: (event: TerminalEvent) => void) => {
      emits.push(emit);
      return Promise.resolve(`t${ids++}`);
    }),
    write: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  let factory: FakeXtermFactory;
  let sessions: TerminalSessions;
  let fixture: ComponentFixture<TerminalPanel>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => el().querySelector(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };

  async function setup(tab: TerminalTab): Promise<void> {
    fixture = TestBed.createComponent(TerminalPanel);
    fixture.componentRef.setInput('tab', tab);
    fixture.componentRef.setInput('target', WEB);
    await settle();
  }

  async function opened(): Promise<TerminalTab> {
    const tab = await sessions.open('h1');
    return tab!;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    states.set({ h1: 'connected' });
    endReasons.set({});
    emits = [];
    ids = 1;
    factory = new FakeXtermFactory();
    await TestBed.configureTestingModule({
      imports: [TerminalPanel],
      providers: [
        provideTaiga(),
        { provide: SshService, useValue: ssh },
        { provide: HostConnector, useValue: connector },
        { provide: TerminalIpc, useValue: ipc },
        { provide: XtermFactory, useValue: factory },
        { provide: TuiNotificationService, useValue: { open: vi.fn(() => of(undefined)) } },
      ],
    }).compileComponents();
    sessions = TestBed.inject(TerminalSessions);
  });

  it('attaches the terminal to its view and reserves the workspace keys', async () => {
    const tab = await opened();
    await setup(tab);
    expect(byId('terminal-view-1')?.firstElementChild).toBe(factory.created[0].parent);
    const reserved = factory.created[0].reserved!;
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(reserved(key({ key: 'Tab', ctrlKey: true }))).toBe(true);
    expect(reserved(key({ key: '1', code: 'Digit1', ctrlKey: true }))).toBe(true);
    expect(reserved(key({ key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(reserved(key({ key: 'w', code: 'KeyW', ctrlKey: true }))).toBe(false);
    expect(reserved(key({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBe(false);
    expect(reserved(key({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(false);
  });

  it('applies the font size from the settings live and refits', async () => {
    localStorage.clear();
    const tab = await opened();
    await setup(tab);
    const view = factory.created[0];
    expect(view.fontSize).toBe(13);
    const fits = view.fits;
    TestBed.inject(Settings).setTerminalFontSize(20);
    await fixture.whenStable();
    expect(view.fontSize).toBe(20);
    expect(view.fits).toBeGreaterThan(fits);
    localStorage.clear();
  });

  it('shows the ended banner and reopens after connecting', async () => {
    const tab = await opened();
    await setup(tab);
    emits[0]({ kind: 'closed', reason: 'exited' });
    await settle();
    expect(byId('terminal-ended')?.textContent).toContain('Session ended. The shell exited.');
    expect(byId('terminal-ended')?.getAttribute('data-appearance')).toBe('neutral');
    states.set({});
    byId('terminal-reopen')!.click();
    await settle();
    expect(connector.connect).toHaveBeenCalledWith(WEB);
    expect(ipc.open).toHaveBeenCalledTimes(2);
    expect(byId('terminal-ended')).toBeNull();
  });

  it('shows a lost connection as a warning', async () => {
    const tab = await opened();
    await setup(tab);
    emits[0]({ kind: 'closed', reason: 'connectionLost' });
    await settle();
    expect(byId('terminal-ended')?.textContent).toContain('Connection lost.');
    expect(byId('terminal-ended')?.getAttribute('data-appearance')).toBe('warning');
  });

  it('does not reopen when the connection does not succeed', async () => {
    const tab = await opened();
    await setup(tab);
    emits[0]({ kind: 'closed', reason: 'closed' });
    states.set({});
    connector.connect.mockImplementationOnce(() => Promise.resolve());
    await settle();
    byId('terminal-reopen')!.click();
    await settle();
    expect(ipc.open).toHaveBeenCalledTimes(1);
  });

  it('keeps the xterm element across destroy and re-attaches it', async () => {
    const tab = await opened();
    await setup(tab);
    const element = byId('terminal-view-1')!.firstElementChild;
    fixture.destroy();
    expect(element?.isConnected).toBe(false);
    await setup(tab);
    expect(byId('terminal-view-1')?.firstElementChild).toBe(element);
    expect(factory.created).toHaveLength(1);
  });
});
