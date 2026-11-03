import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import type { ConfigNode, Project } from '../../../core/ipc/config.models';
import { ProjectActions } from '../../project-tree/project-actions';
import { Welcome } from './welcome';

const shop: Project = {
  id: 'p1',
  name: 'Shop',
  variables: [],
  environments: [],
  activeEnvironmentId: null,
};

describe('Welcome (Home page)', () => {
  const projects = signal<Project[]>([]);
  const nodes = signal<ConfigNode[]>([]);
  const loaded = signal(true);
  const actions = { createProject: vi.fn(), addHost: vi.fn(), addCollection: vi.fn() };
  let fixture: ComponentFixture<Welcome>;
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLButtonElement | null =>
    el().querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

  beforeEach(async () => {
    vi.clearAllMocks();
    projects.set([]);
    nodes.set([]);
    loaded.set(true);
    await TestBed.configureTestingModule({
      imports: [Welcome],
      providers: [
        provideTaiga(),
        { provide: ConfigService, useValue: { projects, nodes, loaded } },
        { provide: ProjectActions, useValue: actions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Welcome);
    await fixture.whenStable();
  });

  it('offers a project, a Home host or a collection when Home is empty', () => {
    expect(el().textContent).toContain('Nothing here yet');
    byId('welcome-new-project')!.click();
    byId('welcome-add-host')!.click();
    byId('welcome-new-collection')!.click();
    expect(actions.createProject).toHaveBeenCalledOnce();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: null });
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: null, parentId: null });
  });

  it('shows the Home header and the sidebar hint once something exists', async () => {
    projects.set([shop]);
    await fixture.whenStable();
    expect(el().querySelector('h1')?.textContent).toBe('Home');
    expect(byId('home-hint')?.textContent).toBe('Double-click a project to open it.');
    nodes.set([
      {
        kind: 'host',
        id: 'h1',
        name: 'vps',
        projectId: null,
        parentId: null,
        hostname: 'h',
        port: '22',
        username: 'u',
        auth: { kind: 'agent' },
      },
    ]);
    await fixture.whenStable();
    expect(byId('home-hint')?.textContent).toContain('Pick a host in the sidebar');
    expect(byId('welcome-new-project')).toBeNull();
  });

  it('shows nothing before the config is loaded', async () => {
    loaded.set(false);
    await fixture.whenStable();
    expect(el().textContent?.trim()).toBe('');
  });
});
