import { TestBed } from '@angular/core/testing';
import { ConfigService } from './config';
import { fakeConfig, host, project } from './config.fixture';
import { type EditedChange, EditedFiles, sortEdited } from './edited-files';
import { type EditedEvent, type EditedFile, ExternalEditsIpc } from './external-edits';
import { editedFile } from './external-edits.fixture';

describe('EditedFiles', () => {
  let emit: (event: EditedEvent) => void;
  let resolveSubscribe: (list: EditedFile[]) => void;
  let failSubscribe: boolean;
  const ipc = {
    subscribe: vi.fn((onEvent: (event: EditedEvent) => void) => {
      emit = onEvent;
      if (failSubscribe) {
        return Promise.reject(new Error('no'));
      }
      return new Promise<EditedFile[]>((resolve) => (resolveSubscribe = resolve));
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    failSubscribe = false;
    const config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set([host('h1', 'vps', 'p1'), host('h2', 'alpha')]);
    TestBed.configureTestingModule({
      providers: [
        { provide: ExternalEditsIpc, useValue: ipc },
        { provide: ConfigService, useValue: config },
      ],
    });
  });

  it('loads the snapshot once, then applies events, buffering those that came first', async () => {
    const store = TestBed.inject(EditedFiles);
    const started = store.start();
    void store.start();
    expect(ipc.subscribe).toHaveBeenCalledOnce();
    emit({ kind: 'updated', file: editedFile('e2', 'h1', '/b', { state: 'uploading' }) });
    resolveSubscribe([editedFile('e1', 'h1', '/a'), editedFile('e2', 'h1', '/b')]);
    await started;
    expect(store.loaded()).toBe(true);
    expect(store.find('e2')?.state).toBe('uploading');
    emit({ kind: 'removed', id: 'e1' });
    expect(store.count()).toBe(1);
    expect(store.findByPath('h1', '/b')?.id).toBe('e2');
    expect([...store.ofHost('h1').keys()]).toEqual(['/b']);
  });

  it('reports state changes with the previous file, not repeated identical states', async () => {
    const store = TestBed.inject(EditedFiles);
    const changes: EditedChange[] = [];
    store.changes.subscribe((c) => changes.push(c));
    const started = store.start();
    resolveSubscribe([editedFile('e1', 'h1', '/a')]);
    await started;
    emit({ kind: 'updated', file: editedFile('e1', 'h1', '/a', { lastSyncedAt: 5 }) });
    emit({ kind: 'updated', file: editedFile('e1', 'h1', '/a', { state: 'conflict' }) });
    emit({ kind: 'updated', file: editedFile('e3', 'h1', '/c') });
    expect(changes.map((c) => [c.previous?.state ?? null, c.file.state])).toEqual([
      ['synced', 'conflict'],
      [null, 'synced'],
    ]);
  });

  it('counts the files needing attention and allows a retry after a failed subscribe', async () => {
    failSubscribe = true;
    const store = TestBed.inject(EditedFiles);
    await store.start();
    expect(store.loaded()).toBe(false);
    failSubscribe = false;
    const started = store.start();
    resolveSubscribe([
      editedFile('e1', 'h1', '/a', { state: 'conflict', needsAttention: true }),
      editedFile('e2', 'h2', '/b'),
    ]);
    await started;
    expect(store.count()).toBe(2);
    expect(store.attention()).toBe(1);
    store.upsert(editedFile('e1', 'h1', '/a'));
    expect(store.attention()).toBe(0);
    store.reset([]);
    expect(store.count()).toBe(0);
  });

  it('sorts attention first (conflict, failed, waiting, recovered), then by host and path', () => {
    const names: Record<string, string> = { h1: 'vps', h2: 'alpha' };
    const files = [
      editedFile('a', 'h1', '/z'),
      editedFile('b', 'h2', '/y'),
      editedFile('c', 'h1', '/r', { state: 'recovered' }),
      editedFile('d', 'h1', '/w', { state: 'waiting' }),
      editedFile('e', 'h2', '/f', { state: 'failed' }),
      editedFile('f', 'h1', '/c', { state: 'conflict' }),
      editedFile('g', 'h2', '/a', { state: 'uploading' }),
    ];
    expect(sortEdited(files, (id) => names[id]).map((f) => f.id)).toEqual([
      'f',
      'e',
      'd',
      'c',
      'g',
      'b',
      'a',
    ]);
  });

  it('orders the live list by host name through the config', async () => {
    const store = TestBed.inject(EditedFiles);
    const started = store.start();
    resolveSubscribe([editedFile('a', 'h1', '/a'), editedFile('b', 'h2', '/b')]);
    await started;
    expect(store.files().map((f) => f.id)).toEqual(['b', 'a']);
  });
});
