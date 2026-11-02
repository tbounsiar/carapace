import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { of } from 'rxjs';
import type { FileEntry, FileSide, FileSource, Listing } from '../../../core/ipc/files';
import { IpcError } from '../../../core/ipc/ipc-error';
import { FileDialogs } from '../file-dialogs';
import { FilePane } from './file-pane';

function entry(dir: string, name: string, patch: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: dir === '/' ? `/${name}` : `${dir}/${name}`,
    kind: 'file',
    size: 100,
    modified: 1_700_000_000,
    permissions: 'rw-r--r--',
    hidden: name.startsWith('.'),
    ...patch,
  };
}

const TREE: Record<string, Listing> = {
  '/home/u': {
    path: '/home/u',
    parent: '/home',
    entries: [
      entry('/home/u', 'notes.txt'),
      entry('/home/u', 'src', { kind: 'dir', size: null }),
      entry('/home/u', '.profile'),
    ],
  },
  '/home/u/src': {
    path: '/home/u/src',
    parent: '/home/u',
    entries: [entry('/home/u/src', 'main.rs')],
  },
  '/home': {
    path: '/home',
    parent: '/',
    entries: [entry('/home', 'u', { kind: 'dir', size: null })],
  },
  '/': { path: '/', parent: null, entries: [entry('/', 'home', { kind: 'dir', size: null })] },
};

class FakeSource implements FileSource {
  constructor(readonly side: FileSide) {}
  home = vi.fn(() => Promise.resolve(''));
  list = vi.fn((path: string): Promise<Listing> => {
    const listing = TREE[path === '' ? '/home/u' : path];
    return listing
      ? Promise.resolve(structuredClone(listing))
      : Promise.reject(new IpcError('not_found', `Not found: ${path}`));
  });
  mkdir = vi.fn((parent: string, name: string) => {
    const created = entry(parent, name, { kind: 'dir', size: null });
    TREE[parent].entries.push(created);
    return Promise.resolve(created);
  });
  rename = vi.fn((path: string, newName: string) => {
    const dir = path.slice(0, path.lastIndexOf('/'));
    const listing = TREE[dir];
    const old = listing.entries.find((e) => e.path === path)!;
    const renamed = { ...old, name: newName, path: `${dir}/${newName}` };
    listing.entries = listing.entries.map((e) => (e === old ? renamed : e));
    return Promise.resolve(renamed);
  });
  delete = vi.fn((path: string) => {
    const dir = path.slice(0, path.lastIndexOf('/'));
    TREE[dir].entries = TREE[dir].entries.filter((e) => e.path !== path);
    return Promise.resolve();
  });
}

@Component({
  imports: [FilePane, TuiRoot],
  template: `<tui-root>
    <app-file-pane
      [source]="source()"
      [label]="'Remote'"
      [startPath]="start()"
      (pathChange)="paths.push($event)"
    />
  </tui-root>`,
})
class Host {
  readonly source = signal<FileSource>(new FakeSource('remote'));
  readonly start = signal<string | null>(null);
  readonly paths: string[] = [];
}

describe('FilePane', () => {
  let snapshot: string;
  let fixture: ComponentFixture<Host>;
  let source: FakeSource;
  let pendingSave: ((name: string) => Promise<unknown>) | null;
  const dialogs = {
    askName: vi.fn(
      (
        _label: string,
        _side: FileSide,
        _initial: string,
        save: (n: string) => Promise<unknown>,
      ) => {
        pendingSave = save;
      },
    ),
    confirmDelete: vi.fn(() => Promise.resolve(true)),
  };
  const alerts = { open: vi.fn(() => of(undefined)) };

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => el().querySelector(`[data-testid="${id}"]`);
  const rowNames = (): string[] =>
    Array.from(el().querySelectorAll('tbody tr[data-testid]')).map((r) =>
      r.getAttribute('data-testid')!,
    );
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };
  const click = async (target: Element | null): Promise<void> => {
    (target as HTMLElement).click();
    await settle();
  };
  const key = async (target: Element | null, k: string): Promise<void> => {
    target!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await settle();
  };
  const crumbLabels = (): string[] =>
    Array.from(byId('pane-path')!.querySelectorAll('button')).map((b) => b.textContent!.trim());

  async function setup(start: string | null = null, side: FileSide = 'remote'): Promise<void> {
    fixture = TestBed.createComponent(Host);
    source = new FakeSource(side);
    fixture.componentInstance.source.set(source);
    fixture.componentInstance.start.set(start);
    await settle();
  }

  beforeAll(() => {
    snapshot = JSON.stringify(TREE);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    pendingSave = null;
    for (const k of Object.keys(TREE)) delete TREE[k];
    Object.assign(TREE, JSON.parse(snapshot) as Record<string, Listing>);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        { provide: FileDialogs, useValue: dialogs },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
  });

  it('lists home with directories first and hidden entries hidden', async () => {
    await setup();
    expect(source.home).toHaveBeenCalled();
    expect(source.list).toHaveBeenCalledWith('');
    expect(rowNames()).toEqual(['entry-src', 'entry-notes.txt']);
    expect(crumbLabels()).toEqual(['/', 'home', 'u']);
    expect(fixture.componentInstance.paths).toEqual(['/home/u']);
    expect(byId('entry-notes.txt')!.textContent).toContain('100 B');
    expect(byId('entry-notes.txt')!.textContent).toContain('rw-r--r--');
  });

  it('shows hidden entries with the toggle', async () => {
    await setup();
    const toggle = byId('pane-hidden')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(rowNames()).toEqual(['entry-src', 'entry-.profile', 'entry-notes.txt']);
  });

  it('opens a directory on double-click and goes back up, selecting it', async () => {
    await setup();
    byId('entry-src')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(source.list).toHaveBeenLastCalledWith('/home/u/src');
    expect(rowNames()).toEqual(['entry-main.rs']);

    await click(byId('pane-up'));
    expect(source.list).toHaveBeenLastCalledWith('/home/u');
    expect(byId('entry-src')!.getAttribute('aria-selected')).toBe('true');
  });

  it('does not open files on double-click', async () => {
    await setup();
    const calls = source.list.mock.calls.length;
    byId('entry-notes.txt')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(source.list.mock.calls.length).toBe(calls);
  });

  it('navigates with the breadcrumbs', async () => {
    await setup();
    const home = Array.from(byId('pane-path')!.querySelectorAll('button')).find(
      (b) => b.textContent!.trim() === 'home',
    );
    await click(home!);
    expect(source.list).toHaveBeenLastCalledWith('/home');
    expect(crumbLabels()).toEqual(['/', 'home']);
  });

  it('disables Up at the root', async () => {
    await setup('/');
    expect((byId('pane-up') as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves the selection with the arrow keys and opens with Enter', async () => {
    await setup();
    const first = byId('entry-src')!;
    expect(first.tabIndex).toBe(0);
    expect(byId('entry-notes.txt')!.tabIndex).toBe(-1);
    await key(first, 'ArrowDown');
    expect(byId('entry-notes.txt')!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(byId('entry-notes.txt'));
    await key(byId('entry-notes.txt'), 'ArrowUp');
    expect(byId('entry-src')!.getAttribute('aria-selected')).toBe('true');
    await key(byId('entry-src'), 'Enter');
    expect(source.list).toHaveBeenLastCalledWith('/home/u/src');
    await key(byId('entry-main.rs'), 'Backspace');
    expect(source.list).toHaveBeenLastCalledWith('/home/u');
  });

  it('sorts when a column header is clicked', async () => {
    TREE['/home/u'].entries.push(entry('/home/u', 'big.bin', { size: 5000 }));
    await setup();
    const header = (label: string): HTMLButtonElement =>
      Array.from(el().querySelectorAll<HTMLButtonElement>('th button')).find((b) =>
        b.textContent!.includes(label),
      )!;
    expect(rowNames()).toEqual(['entry-src', 'entry-big.bin', 'entry-notes.txt']);
    await click(header('Size'));
    expect(rowNames()).toEqual(['entry-src', 'entry-notes.txt', 'entry-big.bin']);
    await click(header('Size'));
    expect(rowNames()).toEqual(['entry-src', 'entry-big.bin', 'entry-notes.txt']);
  });

  it('creates a folder in the current directory and selects it', async () => {
    await setup();
    await click(byId('pane-mkdir'));
    expect(dialogs.askName).toHaveBeenCalledWith('New folder', 'remote', '', expect.any(Function));
    await pendingSave!('logs');
    await settle();
    expect(source.mkdir).toHaveBeenCalledWith('/home/u', 'logs');
    expect(byId('entry-logs')!.getAttribute('aria-selected')).toBe('true');
  });

  it('renames from the row menu', async () => {
    await setup();
    await click(byId('entry-menu-notes.txt'));
    await click(document.querySelector('[data-testid="entry-rename"]'));
    expect(dialogs.askName).toHaveBeenCalledWith(
      'Rename "notes.txt"',
      'remote',
      'notes.txt',
      expect.any(Function),
    );
    await pendingSave!('todo.txt');
    await settle();
    expect(source.rename).toHaveBeenCalledWith('/home/u/notes.txt', 'todo.txt');
    expect(rowNames()).toEqual(['entry-src', 'entry-todo.txt']);
  });

  it('skips the rename call when the name is unchanged', async () => {
    await setup();
    await key(byId('entry-src'), 'F2');
    await pendingSave!('src');
    expect(source.rename).not.toHaveBeenCalled();
  });

  it('propagates rename conflicts to the dialog', async () => {
    await setup();
    source.rename.mockRejectedValueOnce(new IpcError('already_exists', 'exists'));
    await key(byId('entry-src'), 'F2');
    await expect(pendingSave!('notes.txt')).rejects.toMatchObject({ code: 'already_exists' });
  });

  it('deletes a directory recursively after confirming', async () => {
    await setup();
    await click(byId('entry-menu-src'));
    await click(document.querySelector('[data-testid="entry-delete"]'));
    expect(dialogs.confirmDelete).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/home/u/src' }),
    );
    expect(source.delete).toHaveBeenCalledWith('/home/u/src', true);
    expect(rowNames()).toEqual(['entry-notes.txt']);
  });

  it('deletes a file non-recursively with the Delete key', async () => {
    await setup();
    await key(byId('entry-notes.txt'), 'Delete');
    expect(source.delete).toHaveBeenCalledWith('/home/u/notes.txt', false);
  });

  it('does nothing when the delete is cancelled', async () => {
    dialogs.confirmDelete.mockResolvedValueOnce(false);
    await setup();
    await key(byId('entry-notes.txt'), 'Delete');
    expect(source.delete).not.toHaveBeenCalled();
  });

  it('notifies a failed delete and refreshes', async () => {
    await setup();
    source.delete.mockRejectedValueOnce(new IpcError('not_empty', 'Directory not empty'));
    const calls = source.list.mock.calls.length;
    await key(byId('entry-notes.txt'), 'Delete');
    expect(alerts.open).toHaveBeenCalledWith('Directory not empty', expect.anything());
    expect(source.list.mock.calls.length).toBe(calls + 1);
  });

  it('keeps the previous path and shows an inline error on permission_denied', async () => {
    await setup();
    source.list.mockRejectedValueOnce(
      new IpcError('permission_denied', 'Permission denied: /home/u/src'),
    );
    byId('entry-src')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(byId('pane-error')!.textContent).toContain('Permission denied: /home/u/src');
    expect(crumbLabels()).toEqual(['/', 'home', 'u']);
    expect(rowNames()).toEqual(['entry-src', 'entry-notes.txt']);
    expect(alerts.open).not.toHaveBeenCalled();

    await click(byId('pane-refresh'));
    expect(byId('pane-error')).toBeNull();
  });

  it('notifies other listing errors and keeps the listing', async () => {
    await setup();
    source.list.mockRejectedValueOnce(new IpcError('io', 'Read failed'));
    await click(byId('pane-refresh'));
    expect(alerts.open).toHaveBeenCalledWith('Read failed', expect.anything());
    expect(byId('pane-error')).toBeNull();
    expect(rowNames()).toEqual(['entry-src', 'entry-notes.txt']);
  });

  it('starts at the remembered path, falling back to home', async () => {
    await setup('/home/u/src');
    expect(rowNames()).toEqual(['entry-main.rs']);

    await setup('/gone');
    expect(source.list).toHaveBeenCalledWith('/gone');
    expect(source.list).toHaveBeenLastCalledWith('');
    expect(rowNames()).toEqual(['entry-src', 'entry-notes.txt']);
    expect(alerts.open).not.toHaveBeenCalled();
  });

  it('hides the permissions column for the local side', async () => {
    await setup(null, 'local');
    expect(el().querySelectorAll('thead th').length).toBe(4);
    expect(byId('entry-notes.txt')!.textContent).not.toContain('rw-r--r--');
  });
});
