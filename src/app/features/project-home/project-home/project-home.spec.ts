import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { ProjectActions } from '../../project-tree/project-actions';
import { ProjectHome } from './project-home';

describe('ProjectHome', () => {
  let fixture: ComponentFixture<ProjectHome>;
  let config: ReturnType<typeof fakeConfig>;
  const actions = { addHost: vi.fn(), addCollection: vi.fn() };
  const byId = (id: string): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);

  async function setup(projectId = 'p1') {
    await TestBed.configureTestingModule({
      imports: [ProjectHome],
      providers: [
        provideTaiga(),
        provideRouter([]),
        { provide: ConfigService, useValue: config },
        { provide: ProjectActions, useValue: actions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ProjectHome);
    fixture.componentRef.setInput('projectId', projectId);
    await fixture.whenStable();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    config = fakeConfig();
    config.projects.set([
      project('p1', 'Payments', {
        environments: [{ id: 'e1', name: 'Prod', variables: [] }],
        activeEnvironmentId: 'e1',
      }),
      project('p2', 'Empty'),
    ]);
    config.nodes.set([
      collection('c1', 'Backend', 'p1'),
      host('h1', 'a', 'p1', 'c1'),
      host('h2', 'b', 'p1'),
    ]);
  });

  it('summarises the project and its environment', async () => {
    await setup();
    expect(byId('project-home-title')?.textContent).toBe('Payments');
    const text = byId('project-home')?.textContent ?? '';
    expect(text).toContain('2 hosts in 1 collection');
    expect(text).toContain('Environment: Prod');
    expect(text).toContain('prod');
    byId('project-home-new-host')!.click();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: 'p1', parentId: null });
  });

  it('shows the empty state with one primary action', async () => {
    await setup('p2');
    expect(byId('project-empty')).not.toBeNull();
    expect(byId('project-home')?.textContent).toContain('No environment');
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="project-home-new-host"]',
      ).length,
    ).toBe(1);
    byId('project-home-new-collection')!.click();
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: 'p2', parentId: null });
  });

  it('shows not found for an unknown project', async () => {
    await setup('nope');
    expect(byId('project-not-found')?.textContent).toContain('Project not found');
  });
});
