import { TranslocoService } from '@jsverse/transloco';
import { Component, input, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ClipboardText } from '../../../core/clipboard/clipboard-text';
import { type ConnectionTarget, connectionTarget } from '../../../core/ipc/connection';
import { AppSettings } from '../../../core/ipc/app-settings';
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

@Component({
  imports: [TerminalPanel, TuiRoot],
  template: `<tui-root><app-terminal-panel [tab]="tab()" [target]="target" /></tui-root>`,
})
class MenuHost {
  readonly tab = input.required<TerminalTab>();
  readonly target = WEB;
}

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
  const clipboard = {
    read: vi.fn(() => Promise.resolve('echo hi\n')),
    write: vi.fn(() => Promise.resolve()),
  };
  const notifications = { open: vi.fn(() => of(undefined)) };
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
        { provide: AppSettings, useValue: { update: (patch: object) => Promise.resolve(patch) } },
        { provide: XtermFactory, useValue: factory },
        { provide: TuiNotificationService, useValue: notifications },
        { provide: ClipboardText, useValue: clipboard },
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

  it('shows the ended banner in French', async () => {
    const tab = await opened();
    await setup(tab);
    emits[0]({ kind: 'closed', reason: 'exited' });
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await settle();
    expect(byId('terminal-ended')?.textContent).toContain(
      'Session terminée. Le shell s’est arrêté.',
    );
    expect(byId('terminal-reopen')?.textContent).toContain('Rouvrir');
    TestBed.inject(TranslocoService).setActiveLang('en');
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

  describe('menu', () => {
    let host: ComponentFixture<MenuHost> | null = null;
    const inBody = (id: string): HTMLElement | null =>
      document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const menu = () => document.body.querySelector('[data-testid="context-menu"]');
    const settleHost = async (): Promise<void> => {
      await host!.whenStable();
      await new Promise((r) => setTimeout(r));
      await host!.whenStable();
    };
    const rightClick = async (init: MouseEventInit = {}): Promise<MouseEvent> => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 40,
        ...init,
      });
      factory.created[0].parent!.dispatchEvent(event);
      await settleHost();
      return event;
    };
    const press = async (init: KeyboardEventInit): Promise<KeyboardEvent> => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      factory.created[0].parent!.dispatchEvent(event);
      await settleHost();
      return event;
    };

    async function render(): Promise<TerminalTab> {
      const tab = await opened();
      host = TestBed.createComponent(MenuHost);
      host.componentRef.setInput('tab', tab);
      await settleHost();
      return tab;
    }

    afterEach(() => {
      host?.destroy();
      host = null;
    });

    it('opens at a right click with the four entries and cancels the page menu', async () => {
      await render();
      const event = await rightClick();
      expect(event.defaultPrevented).toBe(true);
      expect(menu()?.getAttribute('data-surface')).toBe('terminal');
      expect(menu()?.getAttribute('aria-label')).toBe('Terminal actions');
      const ids = [...menu()!.querySelectorAll('[tuiOption]')].map((o) =>
        o.getAttribute('data-testid'),
      );
      expect(ids).toEqual([
        'terminal-menu-copy',
        'terminal-menu-paste',
        'terminal-menu-select-all',
        'terminal-menu-clear',
      ]);
      expect(inBody('terminal-menu-copy')?.getAttribute('aria-keyshortcuts')).toBe(
        'Control+Shift+C',
      );
      expect(inBody('terminal-menu-paste')?.textContent).toContain('Ctrl+Shift+V');
    });

    it('disables Copy without a selection and copies the selection with one', async () => {
      await render();
      await rightClick();
      const copy = inBody('terminal-menu-copy')!;
      expect(copy.getAttribute('aria-disabled')).toBe('true');
      expect(copy.textContent).toContain('No text selected');
      copy.click();
      expect(clipboard.write).not.toHaveBeenCalled();

      factory.created[0].selection = 'nginx: ok';
      await rightClick();
      expect(inBody('terminal-menu-copy')?.hasAttribute('aria-disabled')).toBe(false);
      const focused = factory.created[0].focused;
      inBody('terminal-menu-copy')!.click();
      await settleHost();
      expect(clipboard.write).toHaveBeenCalledWith('nginx: ok');
      expect(menu()).toBeNull();
      expect(factory.created[0].focused).toBeGreaterThan(focused);
    });

    it('pastes the clipboard through xterm, selects all and clears the scrollback', async () => {
      await render();
      await rightClick();
      inBody('terminal-menu-paste')!.click();
      await settleHost();
      expect(factory.created[0].pasted).toEqual(['echo hi\n']);
      await rightClick();
      inBody('terminal-menu-select-all')!.click();
      expect(factory.created[0].selection).toBe('whole buffer');
      await rightClick();
      inBody('terminal-menu-clear')!.click();
      expect(factory.created[0].cleared).toBe(1);
      expect(ipc.write).not.toHaveBeenCalled();
    });

    it('disables Paste once the session ended, Copy still works', async () => {
      await render();
      emits[0]({ kind: 'closed', reason: 'exited' });
      factory.created[0].selection = 'last output';
      await settleHost();
      await rightClick();
      const paste = inBody('terminal-menu-paste')!;
      expect(paste.getAttribute('aria-disabled')).toBe('true');
      expect(paste.textContent).toContain('Session ended');
      paste.click();
      expect(clipboard.read).not.toHaveBeenCalled();
      expect(inBody('terminal-menu-copy')?.hasAttribute('aria-disabled')).toBe(false);
    });

    it('leaves a plain right click to a program reading the mouse, Shift opens the menu', async () => {
      await render();
      factory.created[0].mouseTracking = true;
      const plain = await rightClick();
      expect(plain.defaultPrevented).toBe(true);
      expect(menu()).toBeNull();
      await rightClick({ shiftKey: true });
      expect(menu()).not.toBeNull();
    });

    it('opens on the ContextMenu key at the cursor, even with mouse reporting on', async () => {
      await render();
      factory.created[0].mouseTracking = true;
      factory.created[0].cursor = { x: 30, y: 60 };
      const event = await press({ key: 'ContextMenu' });
      expect(event.defaultPrevented).toBe(true);
      expect(menu()).not.toBeNull();
      const reserved = factory.created[0].reserved!;
      expect(reserved(new KeyboardEvent('keydown', { key: 'ContextMenu' }))).toBe(true);
      const shiftF10 = await press({ key: 'F10', shiftKey: true });
      expect(shiftF10.defaultPrevented).toBe(false);
      expect(reserved(shiftF10)).toBe(false);
    });

    it('handles Ctrl+Shift+C / V / A itself and keeps Ctrl+C for the shell', async () => {
      await render();
      const view = factory.created[0];
      view.selection = 'uptime';
      const reserved = view.reserved!;
      const copy = await press({ key: 'C', ctrlKey: true, shiftKey: true });
      expect(copy.defaultPrevented).toBe(true);
      expect(reserved(copy)).toBe(true);
      expect(clipboard.write).toHaveBeenCalledWith('uptime');
      const paste = await press({ key: 'V', ctrlKey: true, shiftKey: true });
      expect(paste.defaultPrevented).toBe(true);
      expect(view.pasted).toEqual(['echo hi\n']);
      view.selection = '';
      await press({ key: 'A', ctrlKey: true, shiftKey: true });
      expect(view.selection).toBe('whole buffer');
      const interrupt = await press({ key: 'c', ctrlKey: true });
      expect(interrupt.defaultPrevented).toBe(false);
      expect(reserved(interrupt)).toBe(false);
      expect(ipc.write).not.toHaveBeenCalled();
    });

    it('takes the keyboard into the menu; Escape closes it before xterm and refocuses', async () => {
      await render();
      await rightClick();
      expect(document.activeElement).toBe(inBody('terminal-menu-copy'));
      const focused = factory.created[0].focused;
      const shell = vi.fn((event: Event) => event.stopPropagation());
      const textarea = document.createElement('textarea');
      factory.created[0].parent!.append(textarea);
      textarea.addEventListener('keydown', shell);
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(escape);
      await settleHost();
      expect(menu()).toBeNull();
      expect(shell).not.toHaveBeenCalled();
      expect(escape.defaultPrevented).toBe(true);
      expect(factory.created[0].focused).toBeGreaterThan(focused);
    });

    it('closes on Escape from the focused entry and gives the keyboard back', async () => {
      await render();
      await rightClick();
      const focused = factory.created[0].focused;
      const option = inBody('terminal-menu-paste')!;
      option.focus();
      option.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await settleHost();
      expect(menu()).toBeNull();
      expect(factory.created[0].focused).toBeGreaterThan(focused);
    });

    it('tells when the clipboard cannot be read', async () => {
      await render();
      clipboard.read.mockRejectedValueOnce(new Error('denied'));
      await press({ key: 'V', ctrlKey: true, shiftKey: true });
      expect(notifications.open).toHaveBeenCalledWith(
        'The clipboard could not be read. Try Shift+Insert.',
        expect.objectContaining({ label: 'Paste failed', appearance: 'negative' }),
      );
      expect(factory.created[0].pasted).toEqual([]);
    });
  });
});
