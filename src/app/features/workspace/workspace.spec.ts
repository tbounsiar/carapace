import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { host, project } from '../../core/ipc/config.fixture';
import type { TabStatus } from './tab-status';
import { tabTitles, unsavedNames } from './tab-titles';
import { type TabSpec, tabKey, Workspace } from './workspace';

@Component({ template: '' })
class Blank {}

const UP: TabStatus = { kind: 'connected', word: 'Connected' };

function spec(hostId: string, kind: 'terminal' | 'files' | 'edit', extra: Partial<TabSpec> = {}) {
  const label = kind === 'files' ? 'Files' : kind === 'edit' ? 'nginx.conf' : 'Terminal 1';
  return {
    key: `${kind}:${hostId}:${Math.random()}`,
    kind,
    hostId,
    label,
    status: signal(UP),
    ...extra,
  } satisfies TabSpec;
}

describe('Workspace', () => {
  let workspace: Workspace;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', component: Blank }])],
    });
    workspace = TestBed.inject(Workspace);
    router = TestBed.inject(Router);
  });

  it('builds the tab keys', () => {
    expect(tabKey('files', 'h1')).toBe('files:h1');
    expect(tabKey('terminal', 'h1', 2)).toBe('terminal:h1:2');
    expect(tabKey('edit', 'h1', '/etc/hosts')).toBe('edit:h1:/etc/hosts');
  });

  it('inserts a tab after the last tab of its host, else at the end', () => {
    const a1 = workspace.add(spec('a', 'terminal'));
    const b1 = workspace.add(spec('b', 'terminal'));
    const a2 = workspace.add(spec('a', 'files'));
    const c1 = workspace.add(spec('c', 'files'));
    expect(workspace.tabs()).toEqual([a1, a2, b1, c1]);
    expect(workspace.ofHost('a')).toEqual([a1, a2]);
  });

  it('routes to the activated tab and follows the route', async () => {
    const tab = workspace.add(spec('a', 'terminal'));
    expect(workspace.active()).toBeNull();
    const before = workspace.focusRequest();
    expect(await workspace.activate(tab)).toBe(true);
    expect(router.url).toBe(`/tabs/${tab.id}`);
    expect(workspace.active()).toBe(tab);
    expect(workspace.focusRequest()).toBe(before + 1);
    await router.navigate(['/settings']);
    expect(workspace.active()).toBeNull();
  });

  it('knows the most recently activated tab of a kind', async () => {
    const t1 = workspace.add(spec('a', 'terminal'));
    const t2 = workspace.add(spec('a', 'terminal'));
    await workspace.activate(t2);
    await workspace.activate(t1);
    expect(workspace.mostRecent('a', 'terminal')).toBe(t1);
    expect(workspace.mostRecent('a', 'terminal', (t) => t !== t1)).toBe(t2);
    expect(workspace.mostRecent('a', 'files')).toBeNull();
  });

  it('activates the right neighbour, else the left one, then the host page', async () => {
    const dispose = vi.fn();
    const t1 = workspace.add(spec('a', 'terminal'));
    const t2 = workspace.add(spec('a', 'files', { dispose }));
    const t3 = workspace.add(spec('a', 'edit'));
    await workspace.activate(t2);
    await workspace.remove(t2);
    expect(dispose).toHaveBeenCalled();
    expect(router.url).toBe(`/tabs/${t3.id}`);
    await workspace.remove(t3);
    expect(router.url).toBe(`/tabs/${t1.id}`);
    await workspace.remove(t1);
    expect(router.url).toBe('/hosts/a');
    expect(workspace.headingFocus()).toBe(true);
    expect(workspace.tabs()).toEqual([]);
  });

  it('removes a background tab without routing', async () => {
    const t1 = workspace.add(spec('a', 'terminal'));
    const t2 = workspace.add(spec('a', 'files'));
    await workspace.activate(t1);
    await workspace.remove(t2);
    expect(router.url).toBe(`/tabs/${t1.id}`);
    expect(workspace.find(t2.id)).toBeNull();
  });
});

describe('tabTitles', () => {
  const vps = host('h1', 'vps', null);
  const other = host('h2', 'vps', 'p1');
  const tab = (
    id: string,
    hostId: string,
    kind: 'terminal' | 'edit',
    label: string,
    path?: string,
  ) =>
    ({
      id,
      key: id,
      kind,
      hostId,
      label,
      path: path ?? null,
      status: signal(UP),
      modified: signal(kind === 'edit'),
      readOnly: signal(false),
      terminal: null,
      doc: null,
    }) as const;

  it('formats titles, disambiguates repeated names and adds the full path', () => {
    const tabs = [
      tab('t1', 'h1', 'terminal', 'Terminal 1'),
      tab('t2', 'h1', 'edit', 'app.conf', '/etc/nginx/app.conf'),
      tab('t3', 'h1', 'edit', 'app.conf', '/etc/php/app.conf'),
      tab('t4', 'h2', 'terminal', 'Terminal 1'),
    ];
    const titles = tabTitles(tabs, [vps, other], [project('p1', 'Payments')]);
    expect(titles.get('t1')?.title).toBe('vps · Terminal 1');
    expect(titles.get('t2')?.label).toBe('nginx/app.conf');
    expect(titles.get('t3')?.label).toBe('php/app.conf');
    expect(titles.get('t1')?.hint).toBe('vps (Home) · Terminal 1 — Connected');
    expect(titles.get('t4')?.hint).toBe('vps (Payments) · Terminal 1 — Connected');
    expect(titles.get('t2')?.aria).toBe(
      'vps (Home) · nginx/app.conf — Connected, vps:/etc/nginx/app.conf, modified',
    );
  });

  it('lists unsaved files, five at most', () => {
    const tabs = Array.from({ length: 7 }, (_, i) => tab(`t${i}`, 'h1', 'edit', `f${i}`));
    expect(unsavedNames(tabs.slice(0, 2), () => 'vps')).toBe('f0 (vps), f1 (vps)');
    expect(unsavedNames(tabs, () => 'vps')).toBe(
      'f0 (vps), f1 (vps), f2 (vps), f3 (vps), f4 (vps) and 2 more',
    );
  });
});
