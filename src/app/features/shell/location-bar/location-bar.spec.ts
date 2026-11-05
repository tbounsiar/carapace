import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { EditedFiles } from '../../../core/ipc/edited-files';
import { editedFile } from '../../../core/ipc/external-edits.fixture';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ProjectActions } from '../../project-tree/project-actions';
import { SidebarState } from '../../sidebar/sidebar-state';
import { Workspace } from '../../workspace/workspace';
import { WorkspaceActions } from '../../workspace/workspace-actions';
import { LocationBar } from './location-bar';
import { TranslocoService } from '@jsverse/transloco';
import { trackLanguage } from '../../../shared/ui-text';

@Component({
  imports: [LocationBar, TuiRoot],
  template: '<tui-root><app-location-bar /></tui-root>',
})
class Host {}

@Component({ template: '' })
class Blank {}

describe('LocationBar', () => {
  let fixture: ComponentFixture<Host>;
  let config: ReturnType<typeof fakeConfig>;
  const actions = { renameProject: vi.fn(), deleteProject: vi.fn(), deleteHost: vi.fn() };
  const moves = { openDialog: vi.fn() };
  const run = vi.fn();
  const tabActions = {
    menu: vi.fn(() => [{ id: 'tab-menu-close', label: 'Close', icon: '@tui.x', run }]),
  };
  const byId = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const crumbs = (): string[] =>
    [...document.body.querySelectorAll('[data-testid^="crumb-"]')].map(
      (e) => e.textContent?.trim() ?? '',
    );
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const go = async (url: string) => {
    await TestBed.inject(Router).navigateByUrl(url);
    await settle();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set([
      collection('c1', 'Backend', 'p1'),
      host('h1', 'api-1', 'p1', 'c1'),
      collection('c2', 'Lab'),
      host('h2', 'pi-hole', null, 'c2'),
    ]);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
        { provide: ProjectActions, useValue: actions },
        { provide: MoveLauncher, useValue: moves },
        { provide: WorkspaceActions, useValue: tabActions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('shows Home alone at the root', async () => {
    await go('/');
    expect(crumbs()).toEqual(['Home']);
    expect(byId('crumb-current')?.textContent?.trim()).toBe('Home');
  });

  it('shows the path of a host, collections as buttons revealing them in the sidebar', async () => {
    await go('/hosts/h1');
    expect(crumbs()).toEqual(['Home', 'Payments', 'Backend', 'api-1']);
    byId('crumb-collection-Backend')!.click();
    const state = TestBed.inject(SidebarState);
    expect(state.isOpen('c1')).toBe(true);
    expect(state.focusRequest()).toBe('c1');
    await go('/hosts/h2');
    expect(crumbs()).toEqual(['Home', 'Lab', 'pi-hole']);
  });

  it('shows the host location and the tab label on a tab, with the tab menu', async () => {
    const tab = TestBed.inject(Workspace).add({
      key: 'terminal:h1:2',
      kind: 'terminal',
      hostId: 'h1',
      label: 'Terminal 2',
      status: signal({ kind: 'connected' as const, word: 'Connected' }),
    });
    await go(`/tabs/${tab.id}`);
    expect(crumbs()).toEqual(['Home', 'Payments', 'Backend', 'api-1', 'Terminal 2']);
    expect(byId('crumb-host')?.getAttribute('href')).toBe('/hosts/h1');
    byId('tab-page-menu')!.click();
    await settle();
    byId('tab-menu-close')!.click();
    expect(tabActions.menu).toHaveBeenCalledWith(tab);
    expect(run).toHaveBeenCalled();
  });

  it('offers Move to and Delete host on a host page', async () => {
    await go('/hosts/h1');
    byId('host-menu')!.click();
    await settle();
    byId('host-move')!.click();
    expect(moves.openDialog).toHaveBeenCalledWith(config.findNode('h1'));
  });

  it('leaves the project actions to the project dashboard', async () => {
    await go('/projects/p1');
    expect(crumbs()).toEqual(['Home', 'Payments']);
    expect(byId('project-menu')).toBeNull();
  });

  it('names the variables and global pages', async () => {
    await go('/projects/p1/variables');
    expect(crumbs()).toEqual(['Home', 'Payments', 'Variables']);
    expect(byId('project-menu')).toBeNull();
    await go('/keys');
    expect(crumbs()).toEqual(['Home', 'SSH keys']);
    expect(byId('host-menu')).toBeNull();
  });

  it('names the Edited files page, with Stop all in its menu while files are edited', async () => {
    await go('/edited-files');
    expect(crumbs()).toEqual(['Home', 'Edited files']);
    expect(byId('edited-menu')).toBeNull();
    TestBed.inject(EditedFiles).reset([editedFile('e1', 'h1', '/a')]);
    await settle();
    byId('edited-menu')!.click();
    await settle();
    expect(byId('edited-stop-all')?.textContent).toContain('Stop all');
  });

  it('follows a switch to French', async () => {
    const transloco = TestBed.inject(TranslocoService);
    trackLanguage(transloco);
    await go('/keys');
    transloco.setActiveLang('fr');
    await settle();
    expect(crumbs()).toEqual(['Accueil', 'Clés SSH']);
    await go('/hosts/h1');
    expect(byId('host-menu')?.getAttribute('aria-label')).toBe('Actions pour api-1');
  });
});
