import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { type ConnectionTarget, connectionTarget } from '../../../core/ipc/connection';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { Settings } from '../../../core/settings/settings';
import { TerminalIpc, type TerminalEvent } from '../../../core/ipc/terminal';
import { HostConnector } from '../../host-connection/host-connector';
import { FakeXtermFactory } from '../fake-xterm';
import { XtermFactory } from '../xterm-factory';
import { TerminalPanel } from './terminal-panel';

const WEB = connectionTarget('p1', 'h1');
const DB = connectionTarget('p1', 'h2');

describe('TerminalPanel', () => {
  const states = signal<Record<string, ConnectionState>>({});
  const ssh = { states, stateOf: (id: string) => states()[id] ?? 'idle' };
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
  let fixture: ComponentFixture<TerminalPanel>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => el().querySelector(`[data-testid="${id}"]`);
  const click = async (id: string): Promise<void> => {
    byId(id)!.click();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };

  async function setup(target = WEB): Promise<void> {
    fixture = TestBed.createComponent(TerminalPanel);
    fixture.componentRef.setInput('target', target);
    await fixture.whenStable();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    states.set({});
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
  });

  it('applies the font size from the settings live and refits', async () => {
    localStorage.clear();
    states.set({ h1: 'connected' });
    await setup();
    await click('terminal-new');
    const view = factory.created[0];
    expect(view.fontSize).toBe(13);
    const fits = view.fits;
    TestBed.inject(Settings).setTerminalFontSize(20);
    await fixture.whenStable();
    expect(view.fontSize).toBe(20);
    expect(view.fits).toBeGreaterThan(fits);
    localStorage.clear();
  });

  it('shows the empty state with a New terminal button', async () => {
    await setup();
    expect(byId('terminal-empty')).toBeTruthy();
    expect(byId('terminal-new')).toBeTruthy();
    expect(el().getAttribute('data-testid')).toBe('terminal-panel');
  });

  it('connects first when the host is disconnected, then opens', async () => {
    await setup();
    await click('terminal-new');
    expect(connector.connect).toHaveBeenCalledWith(WEB);
    expect(ipc.open).toHaveBeenCalledTimes(1);
    expect(ipc.open.mock.calls[0][0]).toBe('h1');
    expect(byId('terminal-tab-1')?.textContent).toContain('Terminal 1');
    expect(byId('terminal-view-1')).toBeTruthy();
  });

  it('does not open when the connection does not succeed', async () => {
    connector.connect.mockImplementationOnce(() => Promise.resolve());
    await setup();
    await click('terminal-new');
    expect(ipc.open).not.toHaveBeenCalled();
    expect(byId('terminal-empty')).toBeTruthy();
  });

  it('opens directly on a connected host and renders one tab per terminal', async () => {
    states.set({ h1: 'connected' });
    await setup();
    await click('terminal-new');
    await click('terminal-new');
    expect(connector.connect).not.toHaveBeenCalled();
    expect(byId('terminal-tab-1')).toBeTruthy();
    expect(byId('terminal-tab-2')).toBeTruthy();
    expect(byId('terminal-view-2')).toBeTruthy();
    expect(factory.created[1].parent?.isConnected).toBe(true);
  });

  it('exposes the tabs as a tablist with the view as the panel of the active tab', async () => {
    states.set({ h1: 'connected' });
    await setup();
    await click('terminal-new');
    await click('terminal-new');
    expect(el().querySelector('tui-tabs')?.getAttribute('role')).toBe('tablist');
    const first = byId('terminal-tab-1')!;
    const second = byId('terminal-tab-2')!;
    expect(first.getAttribute('role')).toBe('tab');
    expect(first.getAttribute('aria-selected')).toBe('false');
    expect(second.getAttribute('aria-selected')).toBe('true');
    const panel = byId('terminal-view-2')!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(second.id);
    expect(second.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('closes a tab with its close icon', async () => {
    states.set({ h1: 'connected' });
    await setup();
    await click('terminal-new');
    await click('terminal-new');
    await click('terminal-close-2');
    expect(ipc.close).toHaveBeenCalledWith('t2');
    expect(byId('terminal-tab-2')).toBeNull();
    expect(byId('terminal-view-1')).toBeTruthy();
    await click('terminal-close-1');
    expect(byId('terminal-empty')).toBeTruthy();
  });

  it('shows the ended banner and reopens', async () => {
    states.set({ h1: 'connected' });
    await setup();
    await click('terminal-new');
    emits[0]({ kind: 'closed', reason: 'closed' });
    await fixture.whenStable();
    expect(byId('terminal-ended')?.textContent).toContain('Session ended');
    states.set({});
    await click('terminal-reopen');
    expect(connector.connect).toHaveBeenCalledWith(WEB);
    expect(ipc.open).toHaveBeenCalledTimes(2);
    expect(byId('terminal-ended')).toBeNull();
    expect(byId('terminal-tab-1')).toBeTruthy();
  });

  it('keeps tabs and the xterm element across component destroy', async () => {
    states.set({ h1: 'connected' });
    await setup();
    await click('terminal-new');
    const element = byId('terminal-view-1')!.firstElementChild;
    fixture.destroy();
    expect(element?.isConnected).toBe(false);
    await setup();
    expect(byId('terminal-view-1')?.firstElementChild).toBe(element);
    expect(factory.created).toHaveLength(1);
  });

  it('keeps separate tabs per host', async () => {
    states.set({ h1: 'connected', h2: 'connected' });
    await setup();
    await click('terminal-new');
    fixture.componentRef.setInput('target', DB);
    await fixture.whenStable();
    expect(byId('terminal-empty')).toBeTruthy();
    await click('terminal-new');
    expect(ipc.open.mock.calls[1][0]).toBe('h2');
    expect(byId('terminal-tab-1')?.textContent?.trim()).toMatch(/^Terminal 1$/);
    fixture.componentRef.setInput('target', WEB);
    await fixture.whenStable();
    expect(byId('terminal-tab-1')?.textContent?.trim()).toMatch(/^Terminal 1$/);
    expect(byId('terminal-tab-2')).toBeNull();
  });
});
