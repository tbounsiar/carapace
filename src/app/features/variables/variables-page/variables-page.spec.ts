import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet, withComponentInputBinding } from '@angular/router';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { Project, VariableView } from '../../../core/ipc/config.models';
import { ProjectActions } from '../../project-tree/project-actions';
import { unsavedChangesGuard } from '../unsaved-changes-guard';
import { VariablesPage } from './variables-page';

@Component({ template: '' })
class Blank {}

@Component({
  imports: [RouterOutlet, TuiRoot],
  template: '<tui-root><router-outlet /></tui-root>',
})
class Shell {}

const v = (name: string, value: string): VariableView => ({
  name,
  kind: 'plain',
  value,
  hasValue: true,
});

const PROJECT: Project = {
  id: 'p1',
  name: 'Shop',
  variables: [v('host', 'example.com')],
  environments: [
    { id: 'e1', name: 'Dev', variables: [v('host', '127.0.0.1')] },
    { id: 'e2', name: 'Production', variables: [] },
  ],
  activeEnvironmentId: 'e2',
};

describe('VariablesPage', () => {
  const projects = signal<Project[]>([PROJECT]);
  const variables = signal<VariableView[]>([v('user', 'carapace')]);
  const loading = signal(false);
  const actions = {
    addEnvironment: vi.fn(),
    renameEnvironment: vi.fn(),
    removeEnvironment: vi.fn(() => Promise.resolve(true)),
  };
  const setVariables = vi.fn(() => Promise.resolve([]));
  let fixture: ComponentFixture<Shell>;
  let router: Router;

  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    document.body.querySelector<T>(`[data-testid="${id}"]`);
  const value = (id: string): string => byId<HTMLInputElement>(id)?.value ?? '';
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  /** `whenStable` would wait for the navigation the guard is holding. */
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r));
    }
  };
  const go = async (url: string): Promise<void> => {
    await router.navigateByUrl(url);
    await settle();
  };
  const click = async (id: string): Promise<void> => {
    byId(id)!.click();
    await settle();
  };
  const type = async (id: string, text: string): Promise<void> => {
    const input = byId<HTMLInputElement>(id)!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const confirmButton = (text: string): HTMLElement | undefined =>
    Array.from(document.body.querySelectorAll<HTMLElement>('button')).find(
      (b) => b.textContent?.trim() === text,
    );

  beforeEach(async () => {
    await import('../../../shared/destructive-confirm/destructive-confirm');
    vi.clearAllMocks();
    projects.set([PROJECT]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            {
              path: 'projects/:projectId/variables',
              component: VariablesPage,
              canDeactivate: [unsavedChangesGuard],
            },
            { path: 'variables', component: VariablesPage, canDeactivate: [unsavedChangesGuard] },
            { path: 'elsewhere', component: Blank },
          ],
          withComponentInputBinding(),
        ),
        provideTaiga(),
        {
          provide: ConfigService,
          useValue: { projects, variables, loading, setVariables, load: vi.fn() },
        },
        { provide: ProjectActions, useValue: actions },
        { provide: TuiNotificationService, useValue: { open: vi.fn(() => of(undefined)) } },
      ],
    });
    fixture = TestBed.createComponent(Shell);
    router = TestBed.inject(Router);
    await settle();
  });

  it('edits the global variables without an environment list', async () => {
    await go('/variables');
    expect(byId('vars-title')?.textContent).toContain('Global variables');
    expect(byId('vars-scope-project')).toBeNull();
    expect(value('var-name-0')).toBe('user');
  });

  it('shows project variables first, then the selected environment', async () => {
    await go('/projects/p1/variables');
    expect(byId('vars-title')?.textContent).toContain('Shop: variables and environments');
    expect(byId('vars-scope-project')?.getAttribute('aria-current')).toBe('true');
    expect(value('var-value-0')).toBe('example.com');

    await click('vars-scope-env-Dev');
    expect(byId('vars-scope-title')?.textContent).toContain('Environment Dev');
    expect(value('var-value-0')).toBe('127.0.0.1');
  });

  it('marks the active environment and its kind', async () => {
    await go('/projects/p1/variables');
    const prod = byId('vars-scope-env-Production')!;
    expect(prod.textContent).toContain('prod');
    expect(prod.querySelector('[data-testid="vars-env-active"]')).not.toBeNull();
    expect(byId('vars-scope-env-Dev')!.querySelector('[data-testid="vars-env-active"]')).toBeNull();
  });

  it('adds, renames and deletes environments', async () => {
    await go('/projects/p1/variables');
    await click('vars-env-add');
    expect(actions.addEnvironment).toHaveBeenCalledWith(PROJECT);

    await click('vars-env-menu-Dev');
    await click('vars-env-rename');
    expect(actions.renameEnvironment).toHaveBeenCalledOnce();
    expect(actions.renameEnvironment).toHaveBeenCalledWith(PROJECT, PROJECT.environments[0]);

    await click('vars-scope-env-Dev');
    await click('vars-env-menu-Dev');
    await click('vars-env-delete');
    expect(actions.removeEnvironment).toHaveBeenCalledWith(PROJECT, PROJECT.environments[0]);
    expect(byId('vars-scope-project')?.getAttribute('aria-current')).toBe('true');
  });

  it('asks before switching scope with unsaved changes', async () => {
    await go('/projects/p1/variables');
    await type('var-value-0', 'changed');
    await click('vars-scope-env-Dev');
    confirmButton('Keep editing')!.click();
    await settle();
    expect(value('var-value-0')).toBe('changed');

    await click('vars-scope-env-Dev');
    confirmButton('Discard')!.click();
    await settle();
    expect(value('var-value-0')).toBe('127.0.0.1');
  });

  it('guards navigation away with unsaved changes', async () => {
    await go('/projects/p1/variables');
    await router.navigateByUrl('/elsewhere');
    expect(router.url).toBe('/elsewhere');

    await go('/projects/p1/variables');
    await type('var-value-0', 'changed');
    const leaving = router.navigateByUrl('/elsewhere');
    await tick();
    confirmButton('Keep editing')!.click();
    expect(await leaving).toBe(false);
    expect(router.url).toBe('/projects/p1/variables');

    const again = router.navigateByUrl('/elsewhere');
    await tick();
    confirmButton('Discard')!.click();
    expect(await again).toBe(true);
  });

  it('shows a not-found state for an unknown project', async () => {
    await go('/projects/nope/variables');
    expect(byId('vars-not-found')?.textContent).toContain('Project not found');
  });
});
