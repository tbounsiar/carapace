import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { IpcError } from '../../../core/ipc/ipc-error';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { DataTransferActions } from '../../data-transfer/data-transfer-actions';
import { HostConnector } from '../../host-connection/host-connector';
import { HostLauncher } from '../../host-connection/host-launcher';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ProjectActions } from '../../project-tree/project-actions';
import { Welcome } from './welcome';

@Component({
  imports: [TuiRoot, Welcome],
  template: '<tui-root><app-welcome /></tui-root>',
})
class Shell {}

@Component({ template: '' })
class Blank {}

describe('Welcome (Home page)', () => {
  let fixture: ComponentFixture<Shell>;
  let config: ReturnType<typeof fakeConfig>;
  const states = signal<Record<string, ConnectionState>>({});
  const actions = { createProject: vi.fn(), addHost: vi.fn(), addCollection: vi.fn() };
  const launcher = { open: vi.fn(), openTerminal: vi.fn() };
  const transfer = { importing: signal(false), exportData: vi.fn(), importData: vi.fn() };
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

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [
        provideTaiga(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: { states } },
        { provide: HostConnector, useValue: { connect: vi.fn(), disconnect: vi.fn() } },
        { provide: HostLauncher, useValue: launcher },
        { provide: ProjectActions, useValue: actions },
        { provide: DataTransferActions, useValue: transfer },
        { provide: MoveLauncher, useValue: { openDialog: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    await settle();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    states.set({});
    config = fakeConfig();
    config.projects.set([project('p2', 'Shop'), project('p1', 'Payments')]);
    config.nodes.set([
      collection('c1', 'Lab'),
      host('h1', 'pi-hole', null, 'c1'),
      host('h2', 'my-vps'),
      host('h3', 'api', 'p1'),
      host('h4', 'web', 'p1'),
    ]);
  });

  it('offers a project, a Home host or a collection when Home is empty', async () => {
    config.projects.set([]);
    config.nodes.set([]);
    await setup();
    expect(byId('welcome')?.textContent).toContain('Nothing here yet');
    byId('welcome-new-project')!.click();
    byId('welcome-add-host')!.click();
    byId('welcome-new-collection')!.click();
    expect(actions.createProject).toHaveBeenCalledOnce();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: null });
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: null, parentId: null });
    byId('welcome-import')!.click();
    expect(transfer.importData).toHaveBeenCalledOnce();
    expect(byId('home-title')).toBeNull();
    expect(byId('hosts-search')).toBeNull();
  });

  it('shows the header with stats and the Home actions', async () => {
    states.set({ h2: 'connected', h3: 'connected' });
    await setup();
    expect(byId('home-title')?.textContent).toBe('Home');
    expect(byId('home-stats')?.textContent).toBe(
      '2 hosts · 1 collection · 1 connected · 2 projects',
    );
    expect(byId('home-hint')).toBeNull();
    byId('home-new-host')!.click();
    byId('home-new-collection')!.click();
    expect(actions.addHost).toHaveBeenCalledWith({ projectId: null, parentId: null });
    expect(actions.addCollection).toHaveBeenCalledWith({ projectId: null, parentId: null });
  });

  it('exports Home and imports from the Home menu', async () => {
    await setup();
    const open = async () => {
      byId('home-menu')!.click();
      await settle();
    };
    await open();
    byId('home-export')!.click();
    expect(transfer.exportData).toHaveBeenCalledWith({ kind: 'home' });
    await settle();
    await open();
    byId('home-import')!.click();
    expect(transfer.importData).toHaveBeenCalledOnce();
  });

  it('lists the projects first, ending with New project, then the Home hosts', async () => {
    states.set({ h3: 'connected' });
    await setup();
    const order = [
      ...document.body.querySelectorAll(
        '[data-testid^="project-card-"], [data-testid="home-new-project"], [data-testid^="host-group-"]',
      ),
    ].map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual([
      'project-card-Payments',
      'project-card-Shop',
      'home-new-project',
      'host-group-Home',
      'host-group-Home/Lab',
    ]);
    const payments = byId('project-card-Payments')!;
    expect(payments.getAttribute('href')).toBe('/projects/p1');
    expect(payments.textContent).toContain('2 hosts · 1 connected');
    expect(payments.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '1 open connection',
    );
    expect(byId('project-card-Shop')?.textContent).toContain('0 hosts');
    byId('home-new-project')!.click();
    expect(actions.createProject).toHaveBeenCalledOnce();
  });

  it('filters projects and hosts together', async () => {
    await setup();
    await search('pay');
    expect(byId('project-card-Payments')).not.toBeNull();
    expect(byId('project-card-Shop')).toBeNull();
    expect(byId('host-group-Home')).toBeNull();
    await search('pi');
    expect(byId('home-new-project')).toBeNull();
    expect(byId('card-host-pi-hole')).not.toBeNull();
    expect(byId('hosts-count')?.textContent).toBe('1 of 2 hosts');
    await search('zzz');
    expect(byId('hosts-no-match')?.textContent).toContain('No host or project matches “zzz”');
  });

  it('keeps projects with open connections under Connected', async () => {
    states.set({ h3: 'connected' });
    await setup();
    byId('hosts-filter-connected')!.click();
    await settle();
    expect(byId('project-card-Payments')).not.toBeNull();
    expect(byId('project-card-Shop')).toBeNull();
    expect(byId('host-group-Home')).toBeNull();
    states.set({});
    await settle();
    expect(byId('hosts-none-connected')).not.toBeNull();
  });

  it('opens a terminal on the first host with Enter, else enters the first project', async () => {
    await setup();
    const input = () => byId('hosts-search')!;
    const enter = () =>
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await search('vps');
    enter();
    expect(launcher.openTerminal).toHaveBeenCalledWith(config.findNode('h2'));
    await search('shop');
    enter();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/projects/p2');
  });

  it('hides the host groups when Home has projects only', async () => {
    config.nodes.set([host('h3', 'api', 'p1')]);
    await setup();
    expect(byId('project-card-Payments')).not.toBeNull();
    expect(document.body.querySelector('[data-testid^="host-group-"]')).toBeNull();
    expect(byId('home-stats')?.textContent).toBe('No hosts yet · 2 projects');
  });

  it('shows skeletons until the config is loaded, then the error state', async () => {
    config.loaded.set(false);
    await setup();
    expect(byId('welcome-new-project')).toBeNull();
    expect(document.body.querySelectorAll('.placeholder._skeleton').length).toBe(6);
    config.loadError.set(new IpcError('io', 'disk gone'));
    await settle();
    expect(byId('dashboard-error')?.textContent).toContain('Hosts could not be loaded');
    const load = vi.spyOn(config, 'load');
    byId('dashboard-retry')!.click();
    expect(load).toHaveBeenCalledOnce();
  });
});
