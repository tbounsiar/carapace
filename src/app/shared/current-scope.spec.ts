import { Component, signal } from '@angular/core';
import { Workspace } from '../features/workspace/workspace';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ConfigService } from '../core/ipc/config';
import { fakeConfig, host, project } from '../core/ipc/config.fixture';
import { CurrentScope, parseScopeRoute } from './current-scope';

@Component({ template: '' })
class Blank {}

describe('parseScopeRoute', () => {
  it('reads the scope routes', () => {
    expect(parseScopeRoute('/')).toEqual({ kind: 'home' });
    expect(parseScopeRoute('/projects/p1?x=1')).toEqual({
      kind: 'project',
      projectId: 'p1',
      variables: false,
    });
    expect(parseScopeRoute('/projects/p1/variables')).toEqual({
      kind: 'project',
      projectId: 'p1',
      variables: true,
    });
    expect(parseScopeRoute('/hosts/h1')).toEqual({ kind: 'host', hostId: 'h1' });
    expect(parseScopeRoute('/tabs/t3')).toEqual({ kind: 'tab', tabId: 't3' });
    expect(parseScopeRoute('/keys')).toEqual({ kind: 'other', path: '/keys' });
  });
});

describe('CurrentScope', () => {
  let config: ReturnType<typeof fakeConfig>;
  let router: Router;

  function setup(): CurrentScope {
    config = fakeConfig();
    config.projects.set([project('p1', 'Shop'), project('p2', 'Blog')]);
    config.nodes.set([host('h1', 'web', 'p2'), host('h2', 'vps', null)]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
      ],
    });
    router = TestBed.inject(Router);
    return TestBed.inject(CurrentScope);
  }

  const go = async (url: string): Promise<void> => {
    await router.navigateByUrl(url);
    TestBed.tick();
  };

  beforeEach(() => localStorage.clear());

  it('follows the route and keeps the last scope on global pages', async () => {
    const scope = setup();
    await go('/projects/p1');
    expect(scope.projectId()).toBe('p1');
    await go('/keys');
    expect(scope.projectId()).toBe('p1');
    await go('/hosts/h1');
    expect(scope.projectId()).toBe('p2');
    await go('/hosts/h2');
    expect(scope.isHome()).toBe(true);
    await go('/projects/p1');
    await go('/');
    expect(scope.project()).toBeNull();
  });

  it('resets to Home for an unknown project, keeps the scope for an unknown host', async () => {
    const scope = setup();
    await go('/projects/p1');
    await go('/hosts/nope');
    expect(scope.projectId()).toBe('p1');
    await go('/projects/nope');
    expect(scope.projectId()).toBeNull();
  });

  it('takes the scope of the active tab’s host', async () => {
    const scope = setup();
    const workspace = TestBed.inject(Workspace);
    const tab = workspace.add({
      key: 'files:h1',
      kind: 'files',
      hostId: 'h1',
      label: 'Files',
      status: signal({ kind: 'connected' as const, word: 'Connected' }),
    });
    await go('/projects/p1');
    await go(`/tabs/${tab.id}`);
    expect(scope.projectId()).toBe('p2');
    expect(scope.hostId()).toBe('h1');
    expect(scope.tab()).toBe(tab);
    await go('/tabs/unknown');
    expect(scope.projectId()).toBe('p2');
    expect(scope.hostId()).toBeNull();
  });

  it('follows a host moved to another scope', async () => {
    const scope = setup();
    await go('/hosts/h1');
    config.nodes.update((list) => list.map((n) => (n.id === 'h1' ? { ...n, projectId: 'p1' } : n)));
    expect(scope.projectId()).toBe('p1');
  });

  it('persists the scope and restores it on start at Home', async () => {
    setup();
    await go('/projects/p2');
    expect(localStorage.getItem('carapace.scope')).toBe('p2');

    TestBed.resetTestingModule();
    const restored = setup();
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    restored.restore();
    expect(navigate).toHaveBeenCalledWith(['/projects', 'p2']);
  });

  it('does not restore while the first navigation goes to a deep link', async () => {
    localStorage.setItem('carapace.scope', 'p2');
    const scope = setup();
    const navigate = vi.spyOn(router, 'navigate');
    const first = router.navigateByUrl('/projects/p1/variables');
    expect(router.url).toBe('/');
    scope.restore();
    await first;
    expect(navigate).not.toHaveBeenCalled();
    expect(router.url).toBe('/projects/p1/variables');
  });

  it('does not restore a project that no longer exists', () => {
    localStorage.setItem('carapace.scope', 'gone');
    const scope = setup();
    const navigate = vi.spyOn(router, 'navigate');
    scope.restore();
    expect(navigate).not.toHaveBeenCalled();
  });
});
