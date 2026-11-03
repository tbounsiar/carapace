import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import type { Host, Project } from '../../../core/ipc/config.models';
import { ProjectActions } from '../../project-tree/project-actions';
import { Welcome } from './welcome';

describe('Welcome', () => {
  const projects = signal<Project[]>([]);
  const actions = { createProject: vi.fn(), addHost: vi.fn() };
  let fixture: ComponentFixture<Welcome>;
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    vi.clearAllMocks();
    projects.set([]);
    await TestBed.configureTestingModule({
      imports: [Welcome],
      providers: [
        provideTaiga(),
        { provide: ConfigService, useValue: { projects } },
        { provide: ProjectActions, useValue: actions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Welcome);
    await fixture.whenStable();
  });

  it('shows the app name and tagline', () => {
    expect(el().textContent).toContain('Carapace');
    expect(el().textContent).toContain(
      'SSH and SFTP, organized by project, with environments and variables',
    );
  });

  it('offers to create the first project', () => {
    el().querySelector<HTMLButtonElement>('[data-testid="welcome-new-project"]')!.click();
    expect(actions.createProject).toHaveBeenCalledOnce();
  });

  const shop: Project = {
    id: 'p1',
    name: 'Shop',
    variables: [],
    environments: [],
    hosts: [],
    activeEnvironmentId: null,
  };

  it('offers to add a host while no project has one', async () => {
    projects.set([shop]);
    await fixture.whenStable();
    expect(el().textContent).toContain('Shop has no hosts yet');
    expect(el().textContent).not.toContain('Select a host');
    el().querySelector<HTMLButtonElement>('[data-testid="welcome-add-host"]')!.click();
    expect(actions.addHost).toHaveBeenCalledWith(shop);
  });

  it('points to the sidebar once a host exists', async () => {
    projects.set([shop, { ...shop, id: 'p2', name: 'Blog', hosts: [{ id: 'h1' } as Host] }]);
    await fixture.whenStable();
    expect(el().querySelector('[data-testid="welcome-add-host"]')).toBeNull();
    expect(el().querySelector('[data-testid="welcome-new-project"]')).toBeNull();
    expect(el().textContent).toContain('Select a host');
    expect(el().textContent).toContain('environment at the top right');
  });
});
