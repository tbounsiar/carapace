import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { HostConnector } from '../../host-connection/host-connector';
import { HostLauncher } from '../../host-connection/host-launcher';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ProjectActions } from '../../project-tree/project-actions';
import { ProjectHosts } from './project-hosts';

const projectId = signal('p1');

@Component({
  imports: [ProjectHosts, TuiRoot],
  template: '<tui-root><app-project-hosts [projectId]="projectId()" /></tui-root>',
})
class Shell {
  protected readonly projectId = projectId;
}

describe('ProjectHosts', () => {
  let fixture: ComponentFixture<Shell>;
  let config: ReturnType<typeof fakeConfig>;
  const states = signal<Record<string, ConnectionState>>({});
  const actions = { addHost: vi.fn(), addCollection: vi.fn() };
  const launcher = { open: vi.fn(), openTerminal: vi.fn() };
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    document.body.querySelector<T>(`[data-testid="${id}"]`);
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const search = async (text: string) => {
    const input = byId<HTMLInputElement>('hosts-search')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const cards = () =>
    [...document.body.querySelectorAll('[data-testid^="card-host-"]')].map((c) =>
      c.getAttribute('data-testid')!.slice('card-host-'.length),
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    projectId.set('p1');
    states.set({});
    config = fakeConfig();
    config.projects.set([
      project('p1', 'Payments'),
      project('p2', 'Empty'),
      project('p3', 'Folders'),
    ]);
    config.nodes.set([
      collection('c1', 'Backend', 'p1'),
      collection('c2', 'Legacy', 'p1', 'c1'),
      host('h1', 'api-1', 'p1', 'c1'),
      host('h2', 'api-2', 'p1', 'c1'),
      host('h3', 'old', 'p1', 'c2'),
      host('h4', 'bastion', 'p1'),
      collection('c3', 'Nothing', 'p3'),
    ]);
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideTaiga(),
        provideRouter([]),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: { states } },
        { provide: HostConnector, useValue: { connect: vi.fn(), disconnect: vi.fn() } },
        { provide: HostLauncher, useValue: launcher },
        { provide: ProjectActions, useValue: actions },
        { provide: MoveLauncher, useValue: { openDialog: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    await settle();
  });

  it('groups the cards by collection path, scope root first', () => {
    expect(cards()).toEqual(['bastion', 'api-1', 'api-2', 'old']);
    expect(byId('host-group-Payments')).not.toBeNull();
    expect(byId('host-group-Payments/Backend/Legacy')).not.toBeNull();
    expect(byId('hosts-count')).toBeNull();
  });

  it('searches and counts, with a no-match state that clears the search', async () => {
    await search('legacy');
    expect(cards()).toEqual(['old']);
    expect(byId('hosts-count')?.textContent).toBe('1 of 4 hosts');
    await search('zzz');
    expect(byId('hosts-no-match')?.textContent).toContain('No host matches “zzz”');
    byId('hosts-clear-search')!.click();
    await settle();
    expect(cards().length).toBe(4);
    expect(document.activeElement).toBe(byId('hosts-search'));
  });

  it('shows connected hosts only, with a state when there are none', async () => {
    byId('hosts-filter-connected')!.click();
    await settle();
    expect(byId('hosts-none-connected')?.textContent).toContain('No connected hosts');
    states.set({ h2: 'connected' });
    await settle();
    expect(cards()).toEqual(['api-2']);
    expect(byId('hosts-count')?.textContent).toBe('1 of 4 hosts');
    states.set({});
    await settle();
    byId('hosts-show-all')!.click();
    await settle();
    expect(cards().length).toBe(4);
  });

  it('opens a terminal on the first visible host with Enter', async () => {
    await search('api');
    byId('hosts-search')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(launcher.openTerminal).toHaveBeenCalledWith(config.findNode('h1'));
  });

  it('resets the filters when the project changes', async () => {
    await search('api');
    projectId.set('p3');
    await settle();
    projectId.set('p1');
    await settle();
    expect(byId<HTMLInputElement>('hosts-search')?.value).toBe('');
    expect(cards().length).toBe(4);
  });

  it('shows the empty project and the no-hosts states', async () => {
    projectId.set('p2');
    await settle();
    expect(byId('project-empty')).not.toBeNull();
    byId('project-home-new-collection')!.click();
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: 'p2', parentId: null });
    projectId.set('p3');
    await settle();
    expect(byId('project-no-hosts')?.textContent).toContain('No hosts yet');
    expect(byId('hosts-search')).toBeNull();
  });

  it('shows card placeholders until the config is loaded', async () => {
    config.loaded.set(false);
    await settle();
    expect(document.body.querySelectorAll('.placeholder._skeleton').length).toBe(6);
    expect(cards()).toEqual([]);
  });
});
