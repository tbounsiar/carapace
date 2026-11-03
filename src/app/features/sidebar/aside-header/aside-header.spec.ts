import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { TuiNavigation } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, project } from '../../../core/ipc/config.fixture';
import { ProjectActions } from '../../project-tree/project-actions';
import { AsideHeader } from './aside-header';

@Component({
  imports: [AsideHeader, TuiNavigation, TuiRoot],
  template: `<tui-root>
    <aside [tuiNavigationAside]="true">
      <header><app-aside-header /></header>
    </aside>
  </tui-root>`,
})
class Host {}

@Component({ template: '' })
class Blank {}

describe('AsideHeader', () => {
  let fixture: ComponentFixture<Host>;
  const actions = { addHost: vi.fn(), addCollection: vi.fn(), createProject: vi.fn() };
  const byId = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const openNew = async () => {
    byId('aside-new')!.click();
    await settle();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    const config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
        { provide: ProjectActions, useValue: actions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('has only the New menu at Home, with New project', async () => {
    expect(byId('aside-project')).toBeNull();
    expect(byId('env-select')).toBeNull();
    await openNew();
    byId('new-project')!.click();
    expect(actions.createProject).toHaveBeenCalledOnce();
    await settle();
    await openNew();
    byId('new-host')!.click();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: null });
  });

  it('shows the project, its environment and variables inside a project', async () => {
    await TestBed.inject(Router).navigateByUrl('/projects/p1');
    await settle();
    expect(byId('aside-project')?.getAttribute('href')).toBe('/projects/p1');
    expect(byId('env-select')).not.toBeNull();
    expect(byId('project-variables')?.getAttribute('href')).toBe('/projects/p1/variables');
    await openNew();
    expect(byId('new-project')).toBeNull();
    byId('new-collection')!.click();
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: 'p1', parentId: null });
  });
});
