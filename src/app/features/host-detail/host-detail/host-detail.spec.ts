import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { FileSources } from '../../../core/ipc/files';
import type { Project } from '../../../core/ipc/config.models';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { HostConnector } from '../../host-connection/host-connector';
import { ProjectActions } from '../../project-tree/project-actions';
import { HostViews } from '../host-view';
import { HostDetail } from './host-detail';

const PROJECTS: Project[] = [
  {
    id: 'p1',
    name: 'Shop',
    environments: [
      {
        id: 'e1',
        name: 'production',
        hosts: [
          {
            id: 'h1',
            name: 'web-1',
            hostname: 'web1.example.com',
            port: 2222,
            username: 'deploy',
            auth: { kind: 'key', keyPath: '~/.ssh/id_ed25519' },
          },
        ],
      },
    ],
  },
];

describe('HostDetail', () => {
  const projects = signal<Project[]>(PROJECTS);
  const states = signal<Record<string, ConnectionState>>({});
  const connector = { connect: vi.fn(() => Promise.resolve()), disconnect: vi.fn() };
  const actions = { edit: vi.fn() };
  const local = {
    side: 'local',
    home: () => Promise.resolve('/home/me'),
    list: () => Promise.resolve({ path: '/home/me', parent: '/home', entries: [] }),
  };
  let fixture: ComponentFixture<HostDetail>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => el().querySelector(`[data-testid="${id}"]`);

  async function setup(hostId = 'h1'): Promise<void> {
    fixture = TestBed.createComponent(HostDetail);
    fixture.componentRef.setInput('hostId', hostId);
    await fixture.whenStable();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    projects.set(PROJECTS);
    states.set({});
    await TestBed.configureTestingModule({
      imports: [HostDetail],
      providers: [
        provideRouter([]),
        provideTaiga(),
        { provide: ConfigService, useValue: { projects } },
        { provide: SshService, useValue: { states } },
        { provide: HostConnector, useValue: connector },
        { provide: ProjectActions, useValue: actions },
        { provide: FileSources, useValue: { local, remote: () => local } },
      ],
    }).compileComponents();
  });

  it('shows the host header with address, environment and auth', async () => {
    await setup();
    expect(byId('host-detail-name')?.textContent).toContain('web-1');
    expect(byId('host-detail-address')?.textContent).toContain('deploy@web1.example.com:2222');
    expect(byId('host-detail-env-kind')?.textContent).toContain('prod');
    expect(byId('host-detail-env')?.textContent).toContain('Shop / production');
    expect(byId('host-detail-auth')?.textContent).toContain('Private key file');
    expect(byId('host-detail-auth')?.textContent).toContain('~/.ssh/id_ed25519');
    expect(byId('host-detail-status')?.textContent).toContain('Not connected');
  });

  it('connects with the primary button', async () => {
    await setup();
    byId('host-connect')!.click();
    expect(connector.connect).toHaveBeenCalledWith('h1');
    expect(byId('host-disconnect')).toBeNull();
  });

  it('offers Disconnect and shows the status word once connected', async () => {
    states.set({ h1: 'connected' });
    await setup();
    expect(byId('host-connect')).toBeNull();
    expect(byId('host-detail-status')?.textContent).toContain('Connected');
    byId('host-disconnect')!.click();
    expect(connector.disconnect).toHaveBeenCalledWith('h1');
  });

  it('opens the edit dialog for the host', async () => {
    await setup();
    byId('host-edit')!.click();
    expect(actions.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'host',
        id: 'h1',
        host: PROJECTS[0].environments[0].hosts[0],
      }),
    );
  });

  it('shows a not-found state for an unknown host', async () => {
    await setup('missing');
    expect(byId('host-detail')).toBeNull();
    expect(byId('host-not-found')?.textContent).toContain('Host not found');
  });

  it('switches between terminal and files and remembers the view per host', async () => {
    await setup();
    expect(byId('terminal-panel')).toBeTruthy();
    expect(byId('files-panel')).toBeNull();
    expect(byId('host-view-terminal')?.getAttribute('aria-pressed')).toBe('true');

    byId('host-view-files')!.click();
    await fixture.whenStable();
    expect(byId('files-panel')).toBeTruthy();
    expect(byId('terminal-panel')).toBeNull();
    expect(byId('host-view-files')?.getAttribute('aria-pressed')).toBe('true');
    expect(TestBed.inject(HostViews).of('h1')).toBe('files');

    fixture.destroy();
    await setup();
    expect(byId('files-panel')).toBeTruthy();

    byId('host-view-terminal')!.click();
    await fixture.whenStable();
    expect(byId('terminal-panel')).toBeTruthy();
  });
});
