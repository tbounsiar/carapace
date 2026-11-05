import { TranslocoService } from '@jsverse/transloco';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { Host, Project, ResolvedHost } from '../../../core/ipc/config.models';
import { FileSources } from '../../../core/ipc/files';
import { IpcError } from '../../../core/ipc/ipc-error';
import { SecretsService } from '../../../core/ipc/secrets';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { HostConnector } from '../../host-connection/host-connector';
import { ProjectActions } from '../../project-tree/project-actions';
import { HostLauncher } from '../../host-connection/host-launcher';
import { Workspace } from '../../workspace/workspace';
import { HostDetail } from './host-detail';

const PROJECT: Project = { id: 'p1', name: 'Shop', variables: [] };

const HOST: Host = {
  kind: 'host',
  id: 'h1',
  projectId: 'p1',
  parentId: null,
  name: 'web-1',
  hostname: '${host}',
  port: '${port}',
  username: 'deploy',
  auth: { kind: 'key', keyPath: '~/.ssh/id_ed25519', passphrase: null },
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
  const hosts = signal<Host[]>([HOST]);
  const states = signal<Record<string, ConnectionState>>({});
  const connector = { connect: vi.fn(() => Promise.resolve()), disconnect: vi.fn() };
  const actions = { editHost: vi.fn() };
  const secrets = { forgetSaved: vi.fn(() => Promise.resolve()) };
  const alerts = { open: vi.fn(() => of(undefined)) };
  const resolveHost = vi.fn(() => Promise.resolve(RESOLVED));
  const launcher = { newTerminal: vi.fn(), openFiles: vi.fn() };
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
    hosts.set([HOST]);
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
            nodes: hosts,
            variables: signal([]),
            resolveHost,
            findHost: (id: string) => {
              const host = hosts().find((h) => h.id === id);
              const project = projects().find((p) => p.id === host?.projectId) ?? null;
              return host ? { project, host } : null;
            },
          },
        },
        { provide: SshService, useValue: { states } },
        { provide: HostLauncher, useValue: launcher },
        { provide: SecretsService, useValue: secrets },
        { provide: HostConnector, useValue: connector },
        { provide: ProjectActions, useValue: actions },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: FileSources, useValue: { local, remote: () => local } },
      ],
    }).compileComponents();
  });

  it('shows the host with its resolved address and auth', async () => {
    await setup();
    expect(byId('host-detail-title')?.textContent?.trim()).toBe('web-1');
    expect(byId('host-detail-name')?.textContent).toContain('web-1');
    expect(resolveHost).toHaveBeenCalledWith('h1');
    expect(byId('host-detail-address')?.textContent).toContain('deploy@web1.example.com:2222');
    expect(byId('host-detail-auth')?.textContent).toContain('Private key file');
    expect(byId('host-detail-auth')?.textContent).toContain('~/.ssh/id_ed25519');
    expect(byId('host-detail-status')?.textContent).toContain('Not connected');
    expect(byId('host-detail-status')?.getAttribute('role')).toBe('status');
  });

  it('shows the missing variables instead of an address', async () => {
    resolveHost.mockResolvedValue({ ...RESOLVED, missing: ['host', 'port'] });
    await setup();
    expect(byId('host-detail-address')?.textContent).toContain('Missing variables: host, port');
  });

  it('connects a Home host', async () => {
    hosts.set([{ ...HOST, projectId: null }]);
    await setup();
    expect(byId('host-detail-title')?.textContent?.trim()).toBe('web-1');
    expect(resolveHost).toHaveBeenCalledWith('h1');
    byId('host-connect')!.click();
    expect(connector.connect).toHaveBeenCalledWith({
      projectId: null,
      hostId: 'h1',
      connectionId: 'h1',
    });
  });

  it('connects the host, its connection id being the host id', async () => {
    await setup();
    byId('host-connect')!.click();
    expect(connector.connect).toHaveBeenCalledWith({
      projectId: 'p1',
      hostId: 'h1',
      connectionId: 'h1',
    });
    expect(byId('host-disconnect')).toBeNull();
  });

  it('follows the state of the host connection', async () => {
    states.set({ h2: 'connected' });
    await setup();
    expect(byId('host-connect')).not.toBeNull();
    states.set({ h2: 'connected', h1: 'connected' });
    await settle();
    expect(byId('host-connect')).toBeNull();
    expect(byId('host-detail-status')?.textContent).toContain('Connected');
    byId('host-disconnect')!.click();
    expect(connector.disconnect).toHaveBeenCalledWith('h1');
  });

  it('forgets the saved passphrase of this host', async () => {
    await setup();
    expect(byId('host-forget-secrets')?.textContent).toContain('Forget saved passphrase');
    byId('host-forget-secrets')!.click();
    await settle();
    expect(secrets.forgetSaved).toHaveBeenCalledWith('h1');
    expect(alerts.open).toHaveBeenCalledOnce();
  });

  it('notifies when forgetting fails', async () => {
    secrets.forgetSaved.mockRejectedValueOnce(
      new IpcError('keychain_unavailable', 'Keychain unavailable'),
    );
    await setup();
    byId('host-forget-secrets')!.click();
    await settle();
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Keychain unavailable. '),
      expect.anything(),
    );
  });

  it('offers no forget action for an agent host', async () => {
    hosts.set([{ ...HOST, auth: { kind: 'agent' } }]);
    await setup();
    expect(byId('host-forget-secrets')).toBeNull();
  });

  it('opens the edit dialog for the host', async () => {
    await setup();
    byId('host-edit')!.click();
    expect(actions.editHost).toHaveBeenCalledWith(HOST);
  });

  it('shows a not-found state for an unknown host', async () => {
    await setup('missing');
    expect(byId('host-detail')).toBeNull();
    expect(byId('host-not-found')?.textContent).toContain('Host not found');
  });

  it('shows the empty Open tabs block with New terminal and Files', async () => {
    await setup();
    expect(byId('host-view-terminal')).toBeNull();
    expect(byId('terminal-panel')).toBeNull();
    expect(byId('host-tabs-empty')?.textContent).toContain('No open tabs');
    expect(byId('host-new-terminal')?.getAttribute('data-appearance')).toBe('secondary');
    byId('host-new-terminal')!.click();
    expect(launcher.newTerminal).toHaveBeenCalledWith(HOST);
    byId('host-open-files')!.click();
    expect(launcher.openFiles).toHaveBeenCalledWith(HOST);
  });

  it('lists the host tabs as links, with New terminal primary when connected', async () => {
    states.set({ h1: 'connected' });
    const workspace = TestBed.inject(Workspace);
    workspace.add({
      key: 'files:h1',
      kind: 'files',
      hostId: 'h1',
      label: 'Files',
      status: signal({ kind: 'connected' as const, word: 'Connected' }),
    });
    workspace.add({
      key: 'files:h9',
      kind: 'files',
      hostId: 'h9',
      label: 'Files',
      status: signal({ kind: 'ended' as const, word: 'Disconnected' }),
    });
    await setup();
    expect(byId('host-tabs-empty')).toBeNull();
    const link = byId('host-tab-web-1-files');
    expect(link?.getAttribute('href')).toBe('/tabs/t1');
    expect(link?.getAttribute('aria-label')).toBe('Files — Connected');
    expect(el().querySelectorAll('[data-testid^="host-tab-"]')).toHaveLength(1);
    expect(byId('host-new-terminal')?.getAttribute('data-appearance')).toBe('primary');
  });

  it('focuses the heading after the last tab closed', async () => {
    TestBed.inject(Workspace).headingFocus.set(true);
    await setup();
    expect(document.activeElement).toBe(byId('host-detail-title'));
    expect(TestBed.inject(Workspace).headingFocus()).toBe(false);
  });

  it('renders in French', async () => {
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await setup();
    expect(byId('host-connect')?.textContent).toContain('Connecter');
    expect(el().textContent).toContain('Authentification');
  });
});
