import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { Project, ResolvedHost } from '../../../core/ipc/config.models';
import { FileSources } from '../../../core/ipc/files';
import { IpcError } from '../../../core/ipc/ipc-error';
import { SecretsService } from '../../../core/ipc/secrets';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { CurrentProject } from '../../../shared/current-project';
import { HostConnector } from '../../host-connection/host-connector';
import { ProjectActions } from '../../project-tree/project-actions';
import { HostViews } from '../host-view';
import { HostDetail } from './host-detail';

const PROJECT: Project = {
  id: 'p1',
  name: 'Shop',
  variables: [],
  environments: [
    { id: 'e1', name: 'production', variables: [] },
    { id: 'e2', name: 'Dev', variables: [] },
  ],
  hosts: [
    {
      id: 'h1',
      name: 'web-1',
      hostname: '${host}',
      port: '${port}',
      username: 'deploy',
      auth: { kind: 'key', keyPath: '~/.ssh/id_ed25519', passphrase: null },
    },
  ],
  activeEnvironmentId: 'e1',
};

const RESOLVED: ResolvedHost = {
  hostname: 'web1.example.com',
  port: 2222,
  username: 'deploy',
  keyPath: '/home/me/.ssh/id_ed25519',
  missing: [],
  errors: [],
};

describe('HostDetail', () => {
  const projects = signal<Project[]>([PROJECT]);
  const states = signal<Record<string, ConnectionState>>({});
  const connector = { connect: vi.fn(() => Promise.resolve()), disconnect: vi.fn() };
  const actions = { editHost: vi.fn() };
  const secrets = { forgetSaved: vi.fn(() => Promise.resolve()) };
  const alerts = { open: vi.fn(() => of(undefined)) };
  const resolveHost = vi.fn(() => Promise.resolve(RESOLVED));
  const local = {
    side: 'local',
    home: () => Promise.resolve('/home/me'),
    list: () => Promise.resolve({ path: '/home/me', parent: '/home', entries: [] }),
  };
  let fixture: ComponentFixture<HostDetail>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => el().querySelector(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };

  async function setup(hostId = 'h1'): Promise<void> {
    fixture = TestBed.createComponent(HostDetail);
    fixture.componentRef.setInput('hostId', hostId);
    await settle();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    projects.set([PROJECT]);
    states.set({});
    resolveHost.mockResolvedValue(RESOLVED);
    await TestBed.configureTestingModule({
      imports: [HostDetail],
      providers: [
        provideRouter([]),
        provideTaiga(),
        {
          provide: ConfigService,
          useValue: {
            projects,
            variables: signal([]),
            resolveHost,
            findHost: (id: string) => {
              const project = projects()[0];
              const host = project.hosts.find((h) => h.id === id);
              return host ? { project, host } : null;
            },
          },
        },
        { provide: SshService, useValue: { states } },
        { provide: SecretsService, useValue: secrets },
        { provide: HostConnector, useValue: connector },
        { provide: ProjectActions, useValue: actions },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: FileSources, useValue: { local, remote: () => local } },
      ],
    }).compileComponents();
  });

  it('shows the host with its active environment, resolved address and auth', async () => {
    await setup();
    expect(byId('host-detail-title')?.textContent).toMatch(/web-1\s*· production/);
    expect(byId('host-detail-name')?.textContent).toContain('web-1');
    expect(resolveHost).toHaveBeenCalledWith('p1', 'h1', 'e1');
    expect(byId('host-detail-address')?.textContent).toContain('deploy@web1.example.com:2222');
    expect(byId('host-detail-env-kind')?.textContent).toContain('prod');
    expect(byId('host-detail-env')?.textContent).toContain('Shop / production');
    expect(byId('host-detail-auth')?.textContent).toContain('Private key file');
    expect(byId('host-detail-auth')?.textContent).toContain('~/.ssh/id_ed25519');
    expect(byId('host-detail-status')?.textContent).toContain('Not connected');
  });

  it('shows the missing variables instead of an address', async () => {
    resolveHost.mockResolvedValue({ ...RESOLVED, missing: ['host', 'port'] });
    await setup();
    expect(byId('host-detail-address')?.textContent).toContain('Missing variables: host, port');
  });

  it('has no environment suffix without an active environment', async () => {
    projects.set([{ ...PROJECT, activeEnvironmentId: null }]);
    await setup();
    expect(byId('host-detail-title-env')).toBeNull();
    expect(byId('host-detail-env-kind')).toBeNull();
    expect(byId('host-detail-env')?.textContent).toContain('Shop / No environment');
    expect(resolveHost).toHaveBeenCalledWith('p1', 'h1', null);
  });

  it('makes the host project current', async () => {
    await setup();
    expect(TestBed.inject(CurrentProject).project()?.id).toBe('p1');
  });

  it('connects the connection of the active environment', async () => {
    await setup();
    byId('host-connect')!.click();
    expect(connector.connect).toHaveBeenCalledWith({
      projectId: 'p1',
      hostId: 'h1',
      environmentId: 'e1',
      connectionId: 'h1@e1',
    });
    expect(byId('host-disconnect')).toBeNull();
  });

  it('follows the state of the active connection only', async () => {
    states.set({ 'h1@e2': 'connected' });
    await setup();
    expect(byId('host-connect')).not.toBeNull();
    states.set({ 'h1@e2': 'connected', 'h1@e1': 'connected' });
    await settle();
    expect(byId('host-connect')).toBeNull();
    expect(byId('host-detail-status')?.textContent).toContain('Connected');
    byId('host-disconnect')!.click();
    expect(connector.disconnect).toHaveBeenCalledWith('h1@e1');
  });

  it('forgets the saved passphrase of this connection', async () => {
    await setup();
    expect(byId('host-forget-secrets')?.textContent).toContain('Forget saved passphrase');
    byId('host-forget-secrets')!.click();
    await settle();
    expect(secrets.forgetSaved).toHaveBeenCalledWith('h1', 'e1');
    expect(alerts.open).toHaveBeenCalledOnce();
  });

  it('notifies when forgetting fails', async () => {
    secrets.forgetSaved.mockRejectedValueOnce(
      new IpcError('keychain_unavailable', 'Keychain unavailable'),
    );
    await setup();
    byId('host-forget-secrets')!.click();
    await settle();
    expect(alerts.open).toHaveBeenCalledWith('Keychain unavailable', expect.anything());
  });

  it('offers no forget action for an agent host', async () => {
    projects.set([{ ...PROJECT, hosts: [{ ...PROJECT.hosts[0], auth: { kind: 'agent' } }] }]);
    await setup();
    expect(byId('host-forget-secrets')).toBeNull();
  });

  it('opens the edit dialog for the host', async () => {
    await setup();
    byId('host-edit')!.click();
    expect(actions.editHost).toHaveBeenCalledWith(PROJECT, PROJECT.hosts[0]);
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
