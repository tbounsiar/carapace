import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { SshService } from '../../../core/ipc/ssh';
import { ProjectActions } from '../../project-tree/project-actions';
import { ProjectSelect } from './project-select';

@Component({
  imports: [ProjectSelect, TuiRoot],
  template: '<tui-root><app-project-select /></tui-root>',
})
class Host {}

@Component({ template: '' })
class Blank {}

describe('ProjectSelect', () => {
  let fixture: ComponentFixture<Host>;
  const actions = { createProject: vi.fn() };
  const byId = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const config = fakeConfig();
    config.projects.set([project('p2', 'Shop'), project('p1', 'Payments')]);
    config.nodes.set([host('h1', 'api', 'p1')]);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: { states: signal({ h1: 'connected' }) } },
        { provide: ProjectActions, useValue: actions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('reads Home at the root and the project name inside a project', async () => {
    expect(byId('project-select')?.textContent?.trim()).toBe('Home');
    expect(byId('project-select')?.getAttribute('aria-label')).toBe('Project: Home');
    await TestBed.inject(Router).navigateByUrl('/projects/p2');
    await settle();
    expect(byId('project-select')?.textContent?.trim()).toBe('Shop');
  });

  it('lists Home, the projects sorted with open connections, and New project', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    byId('project-select')!.click();
    await settle();
    expect(byId('project-option-home')?.getAttribute('aria-checked')).toBe('true');
    const names = [...document.body.querySelectorAll('[data-testid^="project-option-"]')].map((e) =>
      e.getAttribute('data-testid'),
    );
    expect(names).toEqual([
      'project-option-home',
      'project-option-Payments',
      'project-option-Shop',
      'project-option-new',
    ]);
    expect(
      byId('project-option-Payments')?.querySelector('[role="img"]')?.getAttribute('aria-label'),
    ).toBe('1 open connection');
    byId('project-option-Payments')!.click();
    expect(navigate).toHaveBeenCalledWith(['/projects', 'p1']);
  });

  it('creates a project from the menu', async () => {
    byId('project-select')!.click();
    await settle();
    byId('project-option-new')!.click();
    expect(actions.createProject).toHaveBeenCalledOnce();
  });
});
