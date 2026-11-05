import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import type { Host } from '../../../core/ipc/config.models';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { HostConnector } from '../../host-connection/host-connector';
import { HostLauncher } from '../../host-connection/host-launcher';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ProjectActions } from '../../project-tree/project-actions';
import { trackLanguage } from '../../../shared/ui-text';
import { HostCard } from './host-card';

const card = signal<Host>(host('h1', 'api', 'p1'));
const deleted: Host[] = [];

@Component({
  imports: [HostCard, TuiRoot],
  template: '<tui-root><app-host-card [host]="host()" (deleted)="onDeleted($event)" /></tui-root>',
})
class Shell {
  protected readonly host = card;
  protected onDeleted(host: Host): void {
    deleted.push(host);
  }
}

describe('HostCard', () => {
  let fixture: ComponentFixture<Shell>;
  let config: ReturnType<typeof fakeConfig>;
  const states = signal<Record<string, ConnectionState>>({});
  const connector = { connect: vi.fn(), disconnect: vi.fn() };
  const launcher = { open: vi.fn(), openTerminal: vi.fn(), openFiles: vi.fn() };
  const actions = { editHost: vi.fn(), deleteHost: vi.fn(() => Promise.resolve(true)) };
  const moves = { openDialog: vi.fn() };
  const byId = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const openMenu = async () => {
    byId('card-menu-api')!.click();
    await settle();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    deleted.length = 0;
    states.set({});
    card.set(host('h1', 'api', 'p1'));
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideTaiga(),
        provideRouter([]),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: { states } },
        { provide: HostConnector, useValue: connector },
        { provide: HostLauncher, useValue: launcher },
        { provide: ProjectActions, useValue: actions },
        { provide: MoveLauncher, useValue: moves },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    await settle();
  });

  it('shows the name link, the resolved address, the status and the auth', () => {
    expect(byId('card-open-api')?.getAttribute('href')).toBe('/hosts/h1');
    expect(byId('card-address-api')?.textContent).toBe('deploy@api.example.com:22');
    expect(byId('card-status-api')?.textContent?.trim()).toBe('Not connected');
    expect(byId('card-host-api')?.textContent).toContain('SSH agent');
    const article = byId('card-host-api')!;
    expect(article.getAttribute('aria-labelledby')).toBe(byId('card-open-api')!.id);
  });

  it('renders in French after a language switch', async () => {
    const transloco = TestBed.inject(TranslocoService);
    trackLanguage(transloco);
    transloco.setActiveLang('fr');
    await settle();
    expect(byId('card-status-api')?.textContent?.trim()).toBe('Non connecté');
    expect(byId('card-connect-api')?.textContent?.trim()).toBe('Connecter');
    expect(byId('card-connect-api')?.getAttribute('aria-label')).toBe('Connecter api');
  });

  it('names the missing variables in the address', async () => {
    card.set({ ...host('h1', 'api', 'p1'), hostname: '${db_host}', port: '${db_port}' });
    await settle();
    expect(byId('card-address-api')?.textContent).toBe('Missing: db_host, db_port');
    expect(byId('card-address-api')?.classList).toContain('_missing');
  });

  it('offers Connect while disconnected, then Terminal and Files', async () => {
    byId('card-connect-api')!.click();
    expect(connector.connect).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'h1' }));
    expect(byId('card-terminal-api')).toBeNull();

    states.set({ h1: 'connecting' });
    await settle();
    expect(byId('card-status-api')?.textContent).toContain('Connecting…');
    expect(byId('card-status-api')?.querySelector('tui-loader')).not.toBeNull();

    states.set({ h1: 'connected' });
    await settle();
    expect(byId('card-connect-api')).toBeNull();
    expect(byId('card-terminal-api')?.getAttribute('aria-label')).toBe('Open terminal on api');
    byId('card-terminal-api')!.click();
    expect(launcher.openTerminal).toHaveBeenCalledWith(card());
    byId('card-files-api')!.click();
    expect(launcher.openFiles).toHaveBeenCalledWith(card());
  });

  it('runs Edit, Move and Delete from the menu, keeping focus out of the sidebar', async () => {
    await openMenu();
    expect(byId('menu-disconnect')).toBeNull();
    byId('menu-edit')!.click();
    expect(actions.editHost).toHaveBeenCalledWith(card(), { sidebarFocus: false });
    expect(document.activeElement).toBe(byId('card-menu-api'));
    await settle();
    await openMenu();
    byId('menu-move')!.click();
    expect(moves.openDialog).toHaveBeenCalledWith(card());
    await settle();
    await openMenu();
    byId('menu-delete')!.click();
    await settle();
    expect(actions.deleteHost).toHaveBeenCalledWith(card(), { sidebarFocus: false });
    expect(deleted).toEqual([card()]);
  });

  it('offers Disconnect when connected, and opens the menu with Shift+F10', async () => {
    states.set({ h1: 'connected' });
    await settle();
    byId('card-host-api')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
    );
    await settle();
    byId('menu-disconnect')!.click();
    expect(connector.disconnect).toHaveBeenCalledWith('h1');
  });
});
