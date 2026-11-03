import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ProjectActions } from '../../project-tree/project-actions';
import { SidebarState } from '../../sidebar/sidebar-state';
import { LocationBar } from './location-bar';

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

  it('offers Move to and Delete host on a host page', async () => {
    await go('/hosts/h1');
    byId('host-menu')!.click();
    await settle();
    byId('host-move')!.click();
    expect(moves.openDialog).toHaveBeenCalledWith(config.findNode('h1'));
  });

  it('offers Rename and Delete on the project home', async () => {
    await go('/projects/p1');
    expect(crumbs()).toEqual(['Home', 'Payments']);
    byId('project-menu')!.click();
    await settle();
    byId('project-delete')!.click();
    expect(actions.deleteProject).toHaveBeenCalledWith(config.findProject('p1'));
  });

  it('names the variables and global pages', async () => {
    await go('/projects/p1/variables');
    expect(crumbs()).toEqual(['Home', 'Payments', 'Variables and environments']);
    await go('/keys');
    expect(crumbs()).toEqual(['Home', 'SSH keys']);
    expect(byId('host-menu')).toBeNull();
  });
});
