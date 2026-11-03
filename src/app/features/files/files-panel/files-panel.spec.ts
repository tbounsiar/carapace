import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { FileSources, type FileSide, type FileSource, type Listing } from '../../../core/ipc/files';
import { type ConnectionTarget, connectionTarget } from '../../../core/ipc/connection';
import { SshService } from '../../../core/ipc/ssh';
import type { ConnectionState } from '../../../core/ipc/ssh.models';
import { HostConnector } from '../../host-connection/host-connector';
import { dirKey, TransferQueue } from '../../transfers/transfer-queue';
import { FileDialogs } from '../file-dialogs';
import { PanePaths } from '../pane-paths';
import { FilesPanel } from './files-panel';

function fakeSource(side: FileSide, home: string, files: string[] = []): FileSource {
  const sep = side === 'local' ? '\\' : '/';
  return {
    side,
    home: vi.fn(() => Promise.resolve(home)),
    list: vi.fn((path: string): Promise<Listing> =>
      Promise.resolve({
        path: path || home || '/home/u',
        parent: null,
        entries: files.map((name) => ({
          name,
          path: `${path || home || '/home/u'}${sep}${name}`,
          kind: 'file',
          size: 1,
          modified: null,
          permissions: null,
          hidden: false,
        })),
      }),
    ),
    mkdir: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
  };
}

const DEV = connectionTarget('p1', 'h1', 'e1');

describe('FilesPanel', () => {
  const states = signal<Record<string, ConnectionState>>({});
  const connector = {
    connect: vi.fn((target: ConnectionTarget) => {
      states.update((s) => ({ ...s, [target.connectionId]: 'connected' }));
      return Promise.resolve();
    }),
  };
  const queue = {
    revisions: signal<ReadonlyMap<string, number>>(new Map()),
    forConnection: () => [],
    enqueue: vi.fn(() => Promise.resolve()),
  };
  let local: FileSource;
  let remote: FileSource;
  let fixture: ComponentFixture<FilesPanel>;
  const remoteFor = vi.fn<(connectionId: string) => FileSource>(() => remote);

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const pane = (side: FileSide): HTMLElement =>
    el().querySelector<HTMLElement>(`[data-testid="pane-${side}"]`)!;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };

  async function setup(target = DEV): Promise<void> {
    fixture = TestBed.createComponent(FilesPanel);
    fixture.componentRef.setInput('target', target);
    await settle();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    states.set({});
    queue.revisions.set(new Map());
    local = fakeSource('local', 'C:\\Users\\me', ['a.txt']);
    remote = fakeSource('remote', '', ['b.txt']);
    await TestBed.configureTestingModule({
      imports: [FilesPanel],
      providers: [
        provideTaiga(),
        { provide: SshService, useValue: { states } },
        { provide: HostConnector, useValue: connector },
        { provide: FileSources, useValue: { local, remote: remoteFor } },
        { provide: FileDialogs, useValue: {} },
        { provide: TransferQueue, useValue: queue },
        { provide: TuiNotificationService, useValue: { open: vi.fn(() => of(undefined)) } },
      ],
    }).compileComponents();
  });

  it('shows the local pane and a Connect state for the remote pane', async () => {
    await setup();
    expect(el().getAttribute('data-testid')).toBe('files-panel');
    expect(local.list).toHaveBeenCalledWith('C:\\Users\\me');
    expect(pane('local').tagName).toBe('APP-FILE-PANE');
    expect(pane('remote').querySelector('[data-testid="pane-connect"]')).toBeTruthy();
    expect(remote.list).not.toHaveBeenCalled();
  });

  it('connects through the host connector, then lists the remote home', async () => {
    await setup();
    pane('remote').querySelector<HTMLElement>('[data-testid="pane-connect"]')!.click();
    await settle();
    expect(connector.connect).toHaveBeenCalledWith(DEV);
    expect(remoteFor).toHaveBeenCalledWith('h1@e1');
    expect(pane('remote').tagName).toBe('APP-FILE-PANE');
    expect(remote.list).toHaveBeenCalledWith('');
  });

  it('switches the remote pane back to the Connect state on disconnect', async () => {
    states.set({ 'h1@e1': 'connected' });
    await setup();
    expect(pane('remote').tagName).toBe('APP-FILE-PANE');
    states.set({ 'h1@e1': 'idle' });
    await settle();
    expect(pane('remote').querySelector('[data-testid="pane-connect"]')).toBeTruthy();
  });

  it('remembers the listed paths per connection and side', async () => {
    states.set({ 'h1@e1': 'connected' });
    remote = fakeSource('remote', '');
    (remote.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/home/u',
      parent: '/home',
      entries: [],
    });
    await setup();
    const paths = TestBed.inject(PanePaths);
    expect(paths.get('h1@e1', 'local')).toBe('C:\\Users\\me');
    expect(paths.get('h1@e1', 'remote')).toBe('/home/u');

    paths.set('h1@e1', 'local', 'D:\\work');
    fixture.destroy();
    await setup();
    expect(local.list).toHaveBeenLastCalledWith('D:\\work');
  });

  it('treats another environment of the host as a separate connection', async () => {
    states.set({ 'h1@e1': 'connected' });
    await setup(connectionTarget('p1', 'h1', null));
    expect(pane('remote').querySelector('[data-testid="pane-connect"]')).toBeTruthy();
  });

  const button = (root: HTMLElement, id: string): HTMLButtonElement =>
    root.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

  it('uploads the local selection into the remote directory once connected', async () => {
    await setup();
    const upload = button(pane('local'), 'pane-upload');
    button(pane('local'), 'entry-a.txt').click();
    await settle();
    expect(upload.disabled).toBe(true);

    states.set({ 'h1@e1': 'connected' });
    await settle();
    expect(upload.disabled).toBe(false);
    upload.click();
    await settle();
    expect(queue.enqueue).toHaveBeenCalledWith(
      'h1@e1',
      'upload',
      ['C:\\Users\\me\\a.txt'],
      '/home/u',
    );
  });

  it('downloads the remote selection into the local directory', async () => {
    states.set({ 'h1@e1': 'connected' });
    await setup();
    button(pane('remote'), 'entry-b.txt').click();
    await settle();
    button(pane('remote'), 'pane-download').click();
    await settle();
    expect(queue.enqueue).toHaveBeenCalledWith(
      'h1@e1',
      'download',
      ['/home/u/b.txt'],
      'C:\\Users\\me',
    );
  });

  it('refreshes a pane when a transfer into its directory finishes', async () => {
    states.set({ 'h1@e1': 'connected' });
    await setup();
    const remoteCalls = vi.mocked(remote.list).mock.calls.length;
    const localCalls = vi.mocked(local.list).mock.calls.length;
    queue.revisions.set(new Map([[dirKey('h1@e1', 'remote', '/home/u'), 1]]));
    await settle();
    expect(vi.mocked(remote.list).mock.calls.length).toBe(remoteCalls + 1);
    expect(vi.mocked(local.list).mock.calls.length).toBe(localCalls);

    queue.revisions.set(
      new Map([
        [dirKey('h1@e1', 'remote', '/home/u'), 1],
        [dirKey('h2@none', 'local', 'C:\\Users\\me'), 1],
      ]),
    );
    await settle();
    expect(vi.mocked(local.list).mock.calls.length).toBe(localCalls + 1);
  });

  it('shows the transfer panel below the panes', async () => {
    await setup();
    expect(el().querySelector('[data-testid="transfer-panel"]')).toBeTruthy();
  });
});
