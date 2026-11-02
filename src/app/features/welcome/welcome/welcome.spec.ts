import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import type { Project } from '../../../core/ipc/config.models';
import { ProjectActions } from '../../project-tree/project-actions';
import { Welcome } from './welcome';

describe('Welcome', () => {
  const projects = signal<Project[]>([]);
  const actions = { createProject: vi.fn() };
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

  it('points to the sidebar once projects exist', async () => {
    projects.set([
      {
        id: 'p1',
        name: 'Shop',
        variables: [],
        environments: [],
        hosts: [],
        activeEnvironmentId: null,
      },
    ]);
    await fixture.whenStable();
    expect(el().querySelector('[data-testid="welcome-new-project"]')).toBeNull();
    expect(el().textContent).toContain('Select a host');
    expect(el().textContent).toContain('environment at the top right');
  });
});
