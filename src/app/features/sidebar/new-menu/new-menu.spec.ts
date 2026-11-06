import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CurrentScope } from '../../../shared/current-scope';
import { ProjectActions } from '../../project-tree/project-actions';
import { NewMenu } from './new-menu';

describe('NewMenu', () => {
  let fixture: ComponentFixture<NewMenu>;
  const isHome = signal(true);
  const projectId = signal<string | null>(null);
  const actions = { addHost: vi.fn(), addCollection: vi.fn(), createProject: vi.fn() };

  const byId = (id: string): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);

  beforeEach(async () => {
    vi.clearAllMocks();
    isHome.set(true);
    projectId.set(null);
    await TestBed.configureTestingModule({
      imports: [NewMenu],
      providers: [
        { provide: CurrentScope, useValue: { isHome, projectId } },
        { provide: ProjectActions, useValue: actions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(NewMenu);
    await fixture.whenStable();
  });

  it('creates at the Home root, New project included, and tells the opener', async () => {
    const chosen = vi.fn();
    fixture.componentInstance.chosen.subscribe(chosen);
    byId('new-host')!.click();
    byId('new-collection')!.click();
    byId('new-project')!.click();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: null });
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: null, parentId: null });
    expect(actions.createProject).toHaveBeenCalledOnce();
    expect(chosen).toHaveBeenCalledTimes(3);
    expect(byId('context-menu')).toBeNull();
  });

  it('creates at the project root inside a project, without New project', async () => {
    isHome.set(false);
    projectId.set('p1');
    await fixture.whenStable();
    expect(byId('new-project')).toBeNull();
    byId('new-host')!.click();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: 'p1', parentId: null });
  });

  it('carries the context menu hook when it has a surface', async () => {
    fixture.componentRef.setInput('surface', 'sidebar-root');
    await fixture.whenStable();
    expect(byId('context-menu')?.getAttribute('data-surface')).toBe('sidebar-root');
  });
});
