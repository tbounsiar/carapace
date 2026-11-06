import { Component, signal, type WritableSignal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host } from '../../../core/ipc/config.fixture';
import { HostLauncher } from '../../host-connection/host-launcher';
import type { TabStatus } from '../tab-status';
import { type TabSpec, Workspace, type WorkspaceTab } from '../workspace';
import { WorkspaceActions } from '../workspace-actions';
import { TabStrip } from './tab-strip';
import { TranslocoService } from '@jsverse/transloco';
import { trackLanguage } from '../../../shared/ui-text';

@Component({ template: '' })
class Blank {}

@Component({
  imports: [TabStrip, TuiRoot],
  template: '<tui-root><app-tab-strip /></tui-root>',
})
class Host {}

describe('TabStrip', () => {
  let fixture: ComponentFixture<Host>;
  let workspace: Workspace;
  let router: Router;
  const launcher = { newTerminal: vi.fn(), openFiles: vi.fn(), open: vi.fn() };
  const close = vi.fn((tab: WorkspaceTab) => workspace.remove(tab).then(() => true));
  const menu = vi.fn(() => [
    { id: 'tab-menu-close', label: 'Close', icon: '@tui.x', run: vi.fn() },
  ]);

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 20));
    await fixture.whenStable();
  };
  const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  function add(
    hostId: string,
    kind: TabSpec['kind'],
    label: string,
    status: TabStatus = { kind: 'connected', word: 'Connected' },
    modified: WritableSignal<boolean> = signal(false),
  ): WorkspaceTab {
    return workspace.add({
      key: `${kind}:${hostId}:${label}`,
      kind,
      hostId,
      label,
      path: kind === 'edit' ? `/etc/${label}` : null,
      status: signal(status),
      modified,
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const config = fakeConfig();
    config.nodes.set([host('h1', 'vps'), host('h2', 'db')]);
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
        { provide: HostLauncher, useValue: launcher },
        { provide: WorkspaceActions, useValue: { close, menu } },
      ],
    });
    workspace = TestBed.inject(Workspace);
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  afterEach(() => fixture.destroy());

  it('renders nothing without tabs', () => {
    expect(byId('workspace-tabs')).toBeNull();
  });

  it('renders each tab with its title, status and a single tab stop without an active tab', async () => {
    add('h1', 'terminal', 'Terminal 1');
    add('h1', 'files', 'Files', { kind: 'lost', word: 'Connection lost' });
    add('h2', 'edit', 'nginx.conf', { kind: 'connecting', word: 'Loading…' }, signal(true));
    await settle();
    const strip = byId('workspace-tabs')!;
    expect(strip.getAttribute('role')).toBe('tablist');
    expect(strip.getAttribute('aria-label')).toBe('Open tabs');
    const term = byId('tab-vps-terminal-1')!;
    expect(term.getAttribute('role')).toBe('tab');
    expect(term.getAttribute('aria-selected')).toBe('false');
    expect(term.textContent).toContain('vps');
    expect(term.textContent).toContain('Terminal 1');
    expect(term.querySelector('[data-testid="tab-status"]')?.getAttribute('data-state')).toBe(
      'connected',
    );
    expect(
      byId('tab-vps-files')!
        .querySelector('[data-testid="tab-status"]')
        ?.getAttribute('data-state'),
    ).toBe('lost');
    const edit = byId('tab-db-edit-nginx.conf')!;
    expect(edit.querySelector('[data-testid="tab-modified"]')).toBeTruthy();
    expect(edit.getAttribute('aria-label')).toContain(', modified');
    expect(edit.getAttribute('aria-label')).toContain('db:/etc/nginx.conf');
    const stops = [...el().querySelectorAll<HTMLElement>('tui-tabs [tuiTab]')].filter(
      (t) => t.tabIndex === 0,
    );
    expect(stops).toEqual([term]);
    expect(byId('tabs-new')?.hasAttribute('disabled')).toBe(true);
  });

  it('marks the routed tab active and routes on click', async () => {
    const a = add('h1', 'terminal', 'Terminal 1');
    const b = add('h1', 'files', 'Files');
    await workspace.activate(a);
    await settle();
    const first = byId('tab-vps-terminal-1')!;
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(first.getAttribute('aria-controls')).toBe('workspace-tab-panel');
    expect(first.classList).toContain('_active');
    byId('tab-vps-files')!.click();
    await settle();
    expect(router.url).toBe(`/tabs/${b.id}`);
    await router.navigate(['/settings']);
    await settle();
    expect(el().querySelector('tui-tabs [tuiTab]._active')).toBeNull();
  });

  it('closes with the close icon, Delete and a middle click', async () => {
    add('h1', 'terminal', 'Terminal 1');
    add('h1', 'terminal', 'Terminal 2');
    add('h1', 'terminal', 'Terminal 3');
    await settle();
    (byId('tab-vps-terminal-1')!.querySelector('[data-testid="tab-close"]') as HTMLElement).click();
    expect(close).toHaveBeenCalledTimes(1);
    await settle();
    press({ key: 'Delete' }, byId('tab-vps-terminal-2')!);
    expect(close).toHaveBeenCalledTimes(2);
    await settle();
    byId('tab-vps-terminal-3')!.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('opens the tab menu on right click and Shift+F10 without activating the tab', async () => {
    const tab = add('h1', 'terminal', 'Terminal 1');
    await settle();
    press({ key: 'F10', shiftKey: true }, byId('tab-vps-terminal-1')!);
    await settle();
    expect(menu).toHaveBeenCalledWith(tab);
    expect(byId('tab-menu-close')).toBeTruthy();
    expect(router.url).not.toContain('/tabs/');
  });

  it('switches with Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1..9 and closes with Ctrl+Shift+W', async () => {
    const a = add('h1', 'terminal', 'Terminal 1');
    const b = add('h2', 'terminal', 'Terminal 1');
    const c = add('h2', 'files', 'Files');
    await settle();
    expect(press({ key: 'Tab', ctrlKey: true }).defaultPrevented).toBe(true);
    await settle();
    expect(router.url).toBe(`/tabs/${a.id}`);
    press({ key: 'Tab', ctrlKey: true });
    await settle();
    expect(router.url).toBe(`/tabs/${b.id}`);
    press({ key: 'Tab', ctrlKey: true, shiftKey: true });
    await settle();
    expect(router.url).toBe(`/tabs/${a.id}`);
    press({ key: 'Tab', ctrlKey: true, shiftKey: true });
    await settle();
    expect(router.url).toBe(`/tabs/${c.id}`);
    press({ key: '1', code: 'Digit1', ctrlKey: true });
    await settle();
    expect(router.url).toBe(`/tabs/${a.id}`);
    press({ key: '9', code: 'Digit9', ctrlKey: true });
    await settle();
    expect(router.url).toBe(`/tabs/${c.id}`);
    expect(press({ key: '7', code: 'Digit7', ctrlKey: true }).defaultPrevented).toBe(false);
    press({ key: 'W', ctrlKey: true, shiftKey: true });
    expect(close).toHaveBeenCalledWith(c);
  });

  it('leaves Ctrl+W to the shell in a terminal and Ctrl+K alone', async () => {
    const a = add('h1', 'terminal', 'Terminal 1');
    await workspace.activate(a);
    await settle();
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    document.body.append(xterm);
    expect(press({ key: 'w', ctrlKey: true }, xterm).defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(press({ key: 'k', ctrlKey: true }, xterm).defaultPrevented).toBe(false);
    expect(press({ key: 'w', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledWith(a);
    xterm.remove();
  });

  it('opens a new terminal on the active tab’s host with + and Ctrl+Shift+T', async () => {
    const a = add('h1', 'terminal', 'Terminal 1');
    await workspace.activate(a);
    await settle();
    expect(byId('tabs-new')?.getAttribute('aria-label')).toBe('New terminal on vps (Ctrl+Shift+T)');
    byId('tabs-new')!.click();
    press({ key: 'T', ctrlKey: true, shiftKey: true });
    expect(launcher.newTerminal).toHaveBeenCalledTimes(2);
    expect(launcher.newTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: 'h1' }));
  });

  it('follows a switch to French', async () => {
    const transloco = TestBed.inject(TranslocoService);
    trackLanguage(transloco);
    workspace.add({
      key: 'terminal:h1:3',
      kind: 'terminal',
      hostId: 'h1',
      label: 'Terminal 3',
      status: signal<TabStatus>({ kind: 'lost', word: 'Connection lost' }),
    });
    add('h1', 'files', 'Files');
    await settle();
    transloco.setActiveLang('fr');
    await settle();
    expect(byId('workspace-tabs')?.getAttribute('aria-label')).toBe('Onglets ouverts');
    const term = byId('tab-vps-terminal-3')!;
    expect(term.getAttribute('aria-label')).toBe('Accueil / vps · Terminal 3 — Connexion perdue');
    expect(byId('tab-vps-files')?.textContent).toContain('Fichiers');
    expect(byId('tabs-new')?.getAttribute('aria-label')).toBe('Sélectionnez d’abord un onglet');
  });
});
