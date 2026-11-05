import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  RouterOutlet,
  withComponentInputBinding,
  withRouterConfig,
} from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { IpcError } from '../../../core/ipc/ipc-error';
import { SshService } from '../../../core/ipc/ssh';
import { ProjectActions } from '../../project-tree/project-actions';
import { type LeaveGuarded, unsavedChangesGuard } from '../../variables/unsaved-changes-guard';
import { DataTransferActions } from '../../data-transfer/data-transfer-actions';
import { trackLanguage } from '../../../shared/ui-text';
import { ProjectHome } from './project-home';

@Component({
  imports: [RouterOutlet, TuiRoot],
  template: '<tui-root><router-outlet /></tui-root>',
})
class Shell {}

@Component({ template: '<p data-testid="hosts-tab">hosts</p>' })
class HostsTab {}

let leave = true;

@Component({ template: '<p data-testid="variables-tab">variables</p>' })
class VariablesTab implements LeaveGuarded {
  canLeave(): Promise<boolean> {
    return Promise.resolve(leave);
  }
}

describe('ProjectHome', () => {
  let fixture: ComponentFixture<Shell>;
  let config: ReturnType<typeof fakeConfig>;
  let router: Router;
  const states = signal<Record<string, string>>({});
  const actions = {
    addHost: vi.fn(),
    addCollection: vi.fn(),
    renameProject: vi.fn(),
    deleteProject: vi.fn(),
  };
  const transfer = { exportData: vi.fn() };
  const byId = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const go = async (url: string) => {
    await router.navigateByUrl(url);
    await settle();
  };
  const active = (id: string) => byId(id)?.classList.contains('_active');

  beforeEach(async () => {
    vi.clearAllMocks();
    leave = true;
    states.set({});
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments'), project('p2', 'Empty')]);
    config.nodes.set([
      collection('c1', 'Backend', 'p1'),
      host('h1', 'a', 'p1', 'c1'),
      host('h2', 'b', 'p1'),
    ]);
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideTaiga(),
        provideRouter(
          [
            {
              path: 'projects/:projectId',
              component: ProjectHome,
              children: [
                { path: '', component: HostsTab },
                {
                  path: 'variables',
                  component: VariablesTab,
                  canDeactivate: [unsavedChangesGuard],
                },
              ],
            },
            { path: '**', component: HostsTab },
          ],
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: { states } },
        { provide: ProjectActions, useValue: actions },
        { provide: DataTransferActions, useValue: transfer },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    router = TestBed.inject(Router);
    await go('/projects/p1');
  });

  it('names the project with its stats and New host', async () => {
    expect(byId('project-home-title')?.textContent).toBe('Payments');
    expect(byId('project-home-stats')?.textContent).toBe('2 hosts · 1 collection');
    states.set({ h2: 'connected' });
    await settle();
    expect(byId('project-home-stats')?.textContent).toBe('2 hosts · 1 collection · 1 connected');
    byId('project-home-new-host')!.click();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: 'p1', parentId: null });
  });

  it('renders in French after a language switch', async () => {
    const transloco = TestBed.inject(TranslocoService);
    trackLanguage(transloco);
    transloco.setActiveLang('fr');
    await settle();
    expect(byId('project-home-stats')?.textContent).toBe('2 hôtes · 1 collection');
    expect(byId('project-home-new-host')?.textContent?.trim()).toBe('Nouvel hôte');
    expect(byId('project-tab-hosts')?.textContent?.trim()).toBe('Hôtes');
  });

  it('runs New collection, Rename and Delete from the project menu', async () => {
    const open = async () => {
      byId('project-menu')!.click();
      await settle();
    };
    await open();
    byId('project-home-new-collection')!.click();
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: 'p1', parentId: null });
    await settle();
    await open();
    byId('project-rename')!.click();
    expect(actions.renameProject).toHaveBeenCalledWith(config.findProject('p1'));
    await settle();
    await open();
    byId('project-delete')!.click();
    expect(actions.deleteProject).toHaveBeenCalledWith(config.findProject('p1'));
    await settle();
    await open();
    byId('project-export')!.click();
    expect(transfer.exportData).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' });
  });

  it('switches tabs through the URL and keeps the header mounted', async () => {
    const title = byId('project-home-title');
    expect(active('project-tab-hosts')).toBe(true);
    expect(byId('hosts-tab')).not.toBeNull();
    byId('project-tab-variables')!.click();
    await settle();
    expect(router.url).toBe('/projects/p1/variables');
    expect(byId('variables-tab')).not.toBeNull();
    expect(active('project-tab-variables')).toBe(true);
    expect(active('project-tab-hosts')).toBe(false);
    expect(byId('project-home-title')).toBe(title);
  });

  it('selects the Variables tab on a deep link and keeps it when leaving is refused', async () => {
    await go('/projects/p1/variables');
    expect(active('project-tab-variables')).toBe(true);
    leave = false;
    byId('project-tab-hosts')!.click();
    await settle();
    expect(router.url).toBe('/projects/p1/variables');
    expect(active('project-tab-variables')).toBe(true);
    expect(active('project-tab-hosts')).toBe(false);
    leave = true;
    byId('project-tab-hosts')!.click();
    await settle();
    expect(router.url).toBe('/projects/p1');
    expect(active('project-tab-hosts')).toBe(true);
  });

  it('hides the header New host and the menu New collection for an empty project', async () => {
    await go('/projects/p2');
    expect(byId('project-home-stats')?.textContent).toBe('No hosts yet');
    expect(byId('project-home-new-host')).toBeNull();
    expect(byId('project-tab-variables')).not.toBeNull();
    byId('project-menu')!.click();
    await settle();
    expect(byId('project-rename')).not.toBeNull();
    expect(byId('project-home-new-collection')).toBeNull();
  });

  it('shows skeletons while loading, then not found for an unknown project', async () => {
    config.loaded.set(false);
    await go('/projects/nope');
    expect(byId('project-home-title')?.classList).toContain('_skeleton');
    expect((byId('project-menu') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('project-not-found')).toBeNull();
    config.loaded.set(true);
    await settle();
    expect(byId('project-not-found')?.textContent).toContain('Project not found');
    expect(byId('project-tab-hosts')).toBeNull();
  });

  it('shows the load error under the tabs and retries', async () => {
    config.loaded.set(false);
    config.loadError.set(new IpcError('io', 'disk gone'));
    await settle();
    expect(byId('dashboard-error')?.textContent).toContain('Hosts could not be loaded');
    expect(byId('project-tab-hosts')).not.toBeNull();
    expect(byId('hosts-tab')).toBeNull();
    const load = vi.spyOn(config, 'load');
    byId('dashboard-retry')!.click();
    expect(load).toHaveBeenCalledOnce();
  });
});
