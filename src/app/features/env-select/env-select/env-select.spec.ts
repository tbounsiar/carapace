import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { Project } from '../../../core/ipc/config.models';
import { IpcError } from '../../../core/ipc/ipc-error';
import { CurrentProject } from '../../../shared/current-project';
import { EnvSelect } from './env-select';

@Component({
  imports: [EnvSelect, TuiRoot],
  template: '<tui-root><app-env-select /></tui-root>',
})
class Host {}

const project = (id: string, name: string, active: string | null): Project => ({
  id,
  name,
  variables: [],
  environments: [
    { id: `${id}-dev`, name: 'Dev', variables: [] },
    { id: `${id}-prod`, name: 'Production', variables: [] },
  ],
  hosts: [],
  activeEnvironmentId: active,
});

describe('EnvSelect', () => {
  const projects = signal<Project[]>([]);
  const alerts = { open: vi.fn(() => of(undefined)) };
  const setActiveEnvironment = vi.fn((projectId: string, environmentId: string | null) => {
    projects.update((list) =>
      list.map((p) => (p.id === projectId ? { ...p, activeEnvironmentId: environmentId } : p)),
    );
    return Promise.resolve();
  });
  let fixture: ComponentFixture<Host>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null =>
    document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const open = async (): Promise<void> => {
    byId('env-select')!.click();
    await settle();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    projects.set([project('p1', 'Shop', null), project('p2', 'Blog', 'p2-prod')]);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        { provide: ConfigService, useValue: { projects, setActiveEnvironment } },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('renders nothing without projects', async () => {
    projects.set([]);
    await settle();
    expect(el().querySelector('[data-testid="env-select"]')).toBeNull();
  });

  it('shows the current project and "No environment" when none is active', () => {
    expect(byId('env-select-project')?.textContent).toContain('Shop');
    expect((byId('env-select') as HTMLInputElement).value).toBe('No environment');
    expect(byId('env-select-kind')).toBeNull();
  });

  it('lists the environments of the project plus "No environment"', async () => {
    await open();
    expect(byId('env-option-none')?.textContent).toContain('No environment');
    expect(byId('env-option-Dev')?.textContent).toContain('Dev');
    expect(byId('env-option-Production')?.textContent).toContain('prod');
  });

  it('sets the active environment and shows its kind badge', async () => {
    await open();
    byId('env-option-Production')!.click();
    await settle();
    expect(setActiveEnvironment).toHaveBeenCalledWith('p1', 'p1-prod');
    expect((byId('env-select') as HTMLInputElement).value).toBe('Production');
    expect(byId('env-select-kind')?.textContent).toContain('prod');
  });

  it('clears the active environment with "No environment"', async () => {
    TestBed.inject(CurrentProject).select('p2');
    await settle();
    expect(byId('env-select-project')?.textContent).toContain('Blog');
    expect((byId('env-select') as HTMLInputElement).value).toBe('Production');
    await open();
    byId('env-option-none')!.click();
    await settle();
    expect(setActiveEnvironment).toHaveBeenCalledWith('p2', null);
    expect(byId('env-select-kind')).toBeNull();
  });

  it('notifies when the backend refuses', async () => {
    setActiveEnvironment.mockRejectedValueOnce(new IpcError('io', 'Could not save'));
    await open();
    byId('env-option-Dev')!.click();
    await settle();
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Could not save. '),
      expect.anything(),
    );
  });
});
