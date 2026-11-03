import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet, withComponentInputBinding } from '@angular/router';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { Project, VariableView } from '../../../core/ipc/config.models';
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

const PROJECT: Project = { id: 'p1', name: 'Shop', variables: [v('host', 'example.com')] };

describe('VariablesPage', () => {
  const projects = signal<Project[]>([PROJECT]);
  const variables = signal<VariableView[]>([v('user', 'carapace')]);
  const loading = signal(false);
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
            {
              path: 'tab/:projectId',
              component: VariablesPage,
              data: { embedded: true },
            },
            { path: 'elsewhere', component: Blank },
          ],
          withComponentInputBinding(),
        ),
        provideTaiga(),
        {
          provide: ConfigService,
          useValue: { projects, variables, loading, setVariables, load: vi.fn() },
        },
        { provide: TuiNotificationService, useValue: { open: vi.fn(() => of(undefined)) } },
      ],
    });
    fixture = TestBed.createComponent(Shell);
    router = TestBed.inject(Router);
    await settle();
  });

  it('edits the global variables', async () => {
    await go('/variables');
    expect(byId('vars-title')?.textContent?.trim()).toBe('Global variables');
    expect(document.body.textContent).toContain('Projects can override them.');
    expect(value('var-name-0')).toBe('user');
  });

  it('edits the project variables only', async () => {
    await go('/projects/p1/variables');
    expect(byId('vars-title')?.textContent?.trim()).toBe('Shop: variables');
    expect(document.body.textContent).toContain('Project variables win over global ones.');
    expect(value('var-value-0')).toBe('example.com');
    await type('var-value-0', 'shop.example.com');
    await click('vars-save');
    expect(setVariables).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, [
      { name: 'host', kind: 'plain', value: 'shop.example.com' },
    ]);
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

  it('drops its own heading as a dashboard tab', async () => {
    await go('/tab/p1');
    expect(byId('vars-title')).toBeNull();
    expect(document.body.textContent).toContain('Project variables win over global ones.');
    expect(value('var-value-0')).toBe('example.com');
    await go('/tab/nope');
    expect(byId('vars-not-found')).toBeNull();
  });
});
