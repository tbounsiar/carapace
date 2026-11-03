import { Component, computed, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { TuiNavigation } from '@taiga-ui/layout';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { Project } from '../../../core/ipc/config.models';
import { IpcError } from '../../../core/ipc/ipc-error';
import { EnvSelect } from './env-select';

const projects = signal<Project[]>([]);
const current = computed(() => projects()[0]);

@Component({
  imports: [EnvSelect, TuiNavigation, TuiRoot],
  template: `<tui-root>
    <aside [tuiNavigationAside]="true"><app-env-select [project]="project()" /></aside>
  </tui-root>`,
})
class Host {
  protected readonly project = current;
}

const project = (active: string | null, envs = true): Project => ({
  id: 'p1',
  name: 'Shop',
  variables: [],
  environments: envs
    ? [
        { id: 'dev', name: 'Dev', variables: [] },
        { id: 'prod', name: 'Production', variables: [] },
      ]
    : [],
  activeEnvironmentId: active,
});

describe('EnvSelect', () => {
  const alerts = { open: vi.fn(() => of(undefined)) };
  const setActiveEnvironment = vi.fn((projectId: string, environmentId: string | null) => {
    projects.update((list) => list.map((p) => ({ ...p, activeEnvironmentId: environmentId })));
    return Promise.resolve();
  });
  let fixture: ComponentFixture<Host>;

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

  async function setup(value: Project): Promise<void> {
    projects.set([value]);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        provideRouter([]),
        { provide: ConfigService, useValue: { projects, setActiveEnvironment } },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  }

  beforeEach(() => vi.clearAllMocks());

  it('shows the active environment with its kind badge and a production label', async () => {
    await setup(project('prod'));
    const item = byId('env-select')!;
    expect(item.textContent).toContain('Production');
    expect(byId('env-select-kind')?.textContent?.trim()).toBe('prod');
    expect(item.getAttribute('aria-label')).toBe('Environment: Production, production');
  });

  it('reads "No environment" without an active one', async () => {
    await setup(project(null));
    expect(byId('env-select')!.textContent?.trim()).toBe('No environment');
    expect(byId('env-select-kind')).toBeNull();
  });

  it('switches the environment from the menu, never disconnecting', async () => {
    await setup(project(null));
    await open();
    expect(byId('env-option-none')?.getAttribute('aria-checked')).toBe('true');
    byId('env-option-Dev')!.click();
    await settle();
    expect(setActiveEnvironment).toHaveBeenCalledWith('p1', 'dev');
    expect(byId('env-select')!.textContent).toContain('Dev');
  });

  it('does nothing when the active environment is picked again', async () => {
    await setup(project('dev'));
    await open();
    byId('env-option-Dev')!.click();
    await settle();
    expect(setActiveEnvironment).not.toHaveBeenCalled();
  });

  it('offers only No environment and Manage environments without environments', async () => {
    await setup(project(null, false));
    await open();
    expect(byId('env-option-none')).not.toBeNull();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    byId('env-option-manage')!.click();
    expect(navigate).toHaveBeenCalledWith(['/projects', 'p1', 'variables']);
  });

  it('notifies when the change fails', async () => {
    await setup(project(null));
    setActiveEnvironment.mockRejectedValueOnce(new IpcError('io', 'disk full'));
    await open();
    byId('env-option-Production')!.click();
    await settle();
    expect(alerts.open).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ label: 'Environment not changed' }),
    );
  });
});
