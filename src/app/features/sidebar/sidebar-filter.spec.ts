import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ConfigService } from '../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../core/ipc/config.fixture';
import { SidebarFilter } from './sidebar-filter';

describe('SidebarFilter', () => {
  let filter: SidebarFilter;
  let config: ReturnType<typeof fakeConfig>;

  beforeEach(() => {
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments'), project('p2', 'Lab')]);
    config.nodes.set([
      collection('c1', 'Rack'),
      collection('c2', 'Empty'),
      host('h1', 'pi-hole', null, 'c1'),
      { ...host('h2', 'vps'), hostname: '203.0.113.7' },
      host('h3', 'api', 'p1'),
    ]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: ConfigService, useValue: config },
      ],
    });
    filter = TestBed.inject(SidebarFilter);
  });

  it('shows the whole scope without a query', () => {
    expect(filter.active()).toBe(false);
    expect(filter.visibleItems().map((i) => i.id)).toEqual(['c2', 'c1', 'h2']);
    expect(filter.visibleProjects().map((p) => p.name)).toEqual(['Lab', 'Payments']);
  });

  it('keeps matching hosts with their collections and matching projects', () => {
    filter.set('PI');
    expect(filter.visibleItems().map((i) => i.id)).toEqual(['c1']);
    expect(filter.firstMatch()?.id).toBe('h1');
    expect(filter.visibleProjects()).toEqual([]);
    filter.set('203.0');
    expect(filter.firstMatch()?.id).toBe('h2');
    filter.set('lab');
    expect(filter.visibleProjects().map((p) => p.name)).toEqual(['Lab']);
    expect(filter.noMatch()).toBe(false);
    filter.set('zzz');
    expect(filter.noMatch()).toBe(true);
    filter.clear();
    expect(filter.active()).toBe(false);
  });

  it('is enabled only when the scope has a host or, at Home, a project', () => {
    expect(filter.enabled()).toBe(true);
    config.nodes.set([collection('c1', 'Rack')]);
    expect(filter.enabled()).toBe(true);
    config.projects.set([]);
    expect(filter.enabled()).toBe(false);
    config.loaded.set(false);
    config.nodes.set([host('h1', 'a')]);
    expect(filter.enabled()).toBe(false);
  });

  it('clears the query when the scope changes', async () => {
    filter.set('pi');
    await TestBed.inject(Router).navigate(['/projects', 'p1']);
    expect(filter.query()).toBe('');
    expect(filter.visibleItems().map((i) => i.id)).toEqual(['h3']);
  });
});
