import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import type { Project } from '../../../core/ipc/config.models';
import { IpcError } from '../../../core/ipc/ipc-error';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { ProjectTree } from './project-tree';

@Component({
  imports: [ProjectTree, TuiRoot],
  template: '<tui-root><app-project-tree /></tui-root>',
})
class Host {}

const PROJECTS: Project[] = [
  {
    id: 'p1',
    name: 'Shop',
    environments: [
      {
        id: 'e1',
        name: 'staging',
        hosts: [
          {
            id: 'h1',
            name: 'web-1',
            hostname: 'web1.example.com',
            port: 22,
            username: 'deploy',
            auth: { kind: 'agent' },
          },
        ],
      },
    ],
  },
];

describe('ProjectTree', () => {
  const projects = signal<Project[]>([]);
  const loading = signal(false);
  const config = {
    projects,
    loading,
    load: vi.fn(() => Promise.resolve()),
    createProject: vi.fn(() => Promise.resolve({})),
    deleteProject: vi.fn(() => Promise.resolve()),
    deleteHost: vi.fn(() => Promise.resolve()),
  };
  const states = signal<Record<string, ConnectionState>>({});
  const ssh = {
    states,
    loadConnections: vi.fn(() => Promise.resolve([])),
    connect: vi.fn(() => Promise.resolve({ hostId: 'h1', state: 'connected' })),
    disconnect: vi.fn(() => Promise.resolve()),
    replaceHostKey: vi.fn(() => Promise.resolve()),
  };
  let fixture: ComponentFixture<Host>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const click = async (button: Element | null | undefined): Promise<void> => {
    (button as HTMLElement).click();
    await settle();
  };
  const byTestId = (id: string): HTMLElement | null =>
    el().querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const byText = (selector: string, text: string): HTMLElement | undefined =>
    Array.from(document.body.querySelectorAll<HTMLElement>(selector)).find((n) =>
      n.textContent?.includes(text),
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    projects.set([]);
    loading.set(false);
    states.set({});
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideTaiga(),
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: ssh },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('loads the configuration on init', () => {
    expect(config.load).toHaveBeenCalledOnce();
  });

  it('shows a loader while loading', async () => {
    loading.set(true);
    await settle();
    expect(el().querySelector('tui-loader')).not.toBeNull();
    expect(el().querySelector('tui-tree')).toBeNull();
  });

  it('shows the empty state and creates a project from the dialog', async () => {
    expect(el().textContent).toContain('No projects yet');
    await click(byText('app-project-tree button', 'New project'));

    const input = document.body.querySelector<HTMLInputElement>('app-name-dialog input')!;
    input.value = 'Shop';
    input.dispatchEvent(new Event('input'));
    await click(document.body.querySelector('app-name-dialog button[type="submit"]'));

    expect(config.createProject).toHaveBeenCalledWith('Shop');
  });

  it('does not submit an empty project name', async () => {
    await click(byText('app-project-tree button', 'New project'));
    await click(document.body.querySelector('app-name-dialog button[type="submit"]'));
    expect(config.createProject).not.toHaveBeenCalled();
  });

  it('renders projects, environments and hosts', async () => {
    projects.set(PROJECTS);
    await settle();
    const items = el().querySelectorAll('tui-tree-item');
    expect(items.length).toBe(3);
    const text = el().textContent ?? '';
    expect(text).toContain('Shop');
    expect(text).toContain('staging');
    expect(text).toContain('web-1');
    expect(el().querySelector('button[aria-label="Actions for web-1"]')).not.toBeNull();
  });

  it('deletes a host after confirmation', async () => {
    projects.set(PROJECTS);
    await settle();
    await click(el().querySelector('button[aria-label="Actions for web-1"]'));
    await click(byText('button[tuiOption]', 'Delete'));
    await click(byText('tui-confirm button, button', 'Delete'));

    expect(config.deleteHost).toHaveBeenCalledWith('p1', 'e1', 'h1');
  });

  it('does not delete when the confirmation is cancelled', async () => {
    projects.set(PROJECTS);
    await settle();
    await click(el().querySelector('button[aria-label="Actions for Shop"]'));
    await click(byText('button[tuiOption]', 'Delete'));
    await click(byText('button', 'Cancel'));

    expect(config.deleteProject).not.toHaveBeenCalled();
  });

  it('connects a host from the menu', async () => {
    projects.set(PROJECTS);
    await settle();
    await click(el().querySelector('button[aria-label="Actions for web-1"]'));
    await click(byText('button[tuiOption]', 'Connect'));
    expect(ssh.connect).toHaveBeenCalledWith('h1', {
      decide: expect.any(Function),
      changed: expect.any(Function),
    });
  });

  it('shows the status as a dot with a word and offers Disconnect when connected', async () => {
    projects.set(PROJECTS);
    states.set({ h1: 'connected' });
    await settle();
    expect(byTestId('status-host-web-1')?.getAttribute('aria-label')).toBe('Connected');
    expect(byTestId('connect-host-web-1')).toBeNull();
    await click(el().querySelector('button[aria-label="Actions for web-1"]'));
    expect(byText('button[tuiOption]', 'Connect')).toBeUndefined();
    await click(byText('button[tuiOption]', 'Disconnect'));
    expect(ssh.disconnect).toHaveBeenCalledWith('h1');
  });

  it('shows a neutral status for idle hosts and connects from the row action', async () => {
    projects.set(PROJECTS);
    await settle();
    expect(byTestId('status-host-web-1')?.getAttribute('aria-label')).toBe('Not connected');
    await click(byTestId('connect-host-web-1'));
    expect(ssh.connect).toHaveBeenCalledWith('h1', expect.anything());
  });

  it('disables the row connect action while connecting', async () => {
    projects.set(PROJECTS);
    states.set({ h1: 'connecting' });
    await settle();
    expect(byTestId('connect-host-web-1')?.hasAttribute('disabled')).toBe(true);
    expect(byTestId('status-host-web-1')?.tagName.toLowerCase()).toBe('tui-loader');
  });

  it('marks environments by kind and links hosts to their detail route', async () => {
    projects.set(PROJECTS);
    await settle();
    expect(byTestId('env-kind-env-staging')?.textContent).toContain('staging');
    expect(byTestId('open-host-web-1')?.getAttribute('href')).toBe('/hosts/h1');
    expect(byTestId('tree-host-web-1')?.getAttribute('style')).toContain('--tui-status-warning');
  });

  it('adds a host from the environment row action', async () => {
    projects.set(PROJECTS);
    await settle();
    await click(byTestId('add-env-staging'));
    expect(document.body.querySelector('app-host-dialog')).not.toBeNull();
  });

  it('shows the safe message when connecting fails', async () => {
    ssh.connect.mockRejectedValueOnce(new IpcError('auth_failed', 'Authentication failed'));
    projects.set(PROJECTS);
    await settle();
    await click(el().querySelector('button[aria-label="Actions for web-1"]'));
    await click(byText('button[tuiOption]', 'Connect'));
    expect(document.body.textContent).toContain('Authentication failed');
  });
});
