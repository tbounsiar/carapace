import { LanguageService } from '../../../core/i18n/language';
import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { of } from 'rxjs';
import type { EditedFile } from '../../../core/ipc/external-edits';
import { editedFile } from '../../../core/ipc/external-edits.fixture';
import type { FileEntry, FileSide, FileSource, Listing } from '../../../core/ipc/files';
import { IpcError } from '../../../core/ipc/ipc-error';
import { FileDialogs } from '../file-dialogs';
import { FileDrag } from '../file-drag';
import { FilePane, type PaneTransfer } from './file-pane';

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
      [transferTarget]="transferTarget()"
      [revisions]="revisions()"
      (pathChange)="paths.push($event)"
      (send)="sent.push($event)"
      [editable]="editable()"
      (receive)="received.push($event)"
      (edit)="edited.push($event.path)"
      [edited]="editedFiles()"
      (openExternal)="external.push($event.path)"
    />
  </tui-root>`,
})
class Host {
  readonly source = signal<FileSource>(new FakeSource('remote'));
  readonly start = signal<string | null>(null);
  readonly transferTarget = signal<string | null>(null);
  readonly revisions = signal<ReadonlyMap<string, number>>(new Map());
  readonly paths: string[] = [];
  readonly sent: PaneTransfer[] = [];
  readonly received: PaneTransfer[] = [];
  readonly editable = signal(false);
  readonly edited: string[] = [];
  readonly editedFiles = signal<ReadonlyMap<string, EditedFile>>(new Map());
  readonly external: string[] = [];
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
    confirmDeleteMany: vi.fn<(entries: readonly FileEntry[]) => Promise<boolean>>(() =>
      Promise.resolve(true),
    ),
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
        provideRouter([]),
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

  it('follows a switch to French, sizes included', async () => {
    await setup();
    TestBed.inject(LanguageService).apply('fr');
    await settle();
    expect(byId('entry-notes.txt')!.textContent).toContain('100\u00a0o');
    expect(byId('pane-refresh')!.getAttribute('aria-label')).toBe('Actualiser');
    expect(el().querySelector('thead')!.textContent).toContain('Taille');
    TestBed.inject(LanguageService).apply('en');
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

  it('opens remote files in the editor with Enter, double-click and the Edit entry', async () => {
    fixture = TestBed.createComponent(Host);
    source = new FakeSource('remote');
    fixture.componentInstance.source.set(source);
    fixture.componentInstance.editable.set(true);
    await settle();
    const edited = fixture.componentInstance.edited;
    byId('entry-notes.txt')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await key(byId('entry-notes.txt'), 'Enter');
    await click(byId('entry-menu-notes.txt'));
    await click(document.querySelector('[data-testid="entry-edit"]'));
    expect(edited).toEqual(['/home/u/notes.txt', '/home/u/notes.txt', '/home/u/notes.txt']);
    await click(byId('entry-menu-src'));
    expect(document.querySelector('[data-testid="entry-edit"]')).toBeNull();
  });

  it('disables Edit over 5 MiB and tries a symlink as a directory first', async () => {
    TREE['/home/u'].entries.push(
      entry('/home/u', 'big.log', { size: 6 * 1024 * 1024 }),
      entry('/home/u', 'link', { kind: 'symlink', size: 10 }),
    );
    fixture = TestBed.createComponent(Host);
    source = new FakeSource('remote');
    fixture.componentInstance.source.set(source);
    fixture.componentInstance.editable.set(true);
    await settle();
    await click(byId('entry-menu-big.log'));
    const editEntry = document.querySelector<HTMLButtonElement>('[data-testid="entry-edit"]')!;
    expect(editEntry.getAttribute('aria-disabled')).toBe('true');
    expect(editEntry.textContent).toContain('Too large to edit (max 5 MiB)');
    byId('entry-link')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(source.list).toHaveBeenCalledWith('/home/u/link');
    expect(fixture.componentInstance.edited).toEqual(['/home/u/link']);
    expect(alerts.open).not.toHaveBeenCalled();
  });

  it('opens remote files in the external editor from the menu and with Shift+Enter', async () => {
    TREE['/home/u'].entries.push(entry('/home/u', 'disk.img', { size: 2 * 1024 ** 3 }));
    fixture = TestBed.createComponent(Host);
    source = new FakeSource('remote');
    fixture.componentInstance.source.set(source);
    fixture.componentInstance.editable.set(true);
    await settle();
    expect(byId('entry-notes.txt')!.getAttribute('aria-keyshortcuts')).toContain('Shift+Enter');
    await click(byId('entry-menu-notes.txt'));
    const options = [...document.querySelectorAll('tui-data-list [data-testid]')].map((o) =>
      o.getAttribute('data-testid'),
    );
    expect(options.slice(0, 2)).toEqual(['entry-edit', 'entry-external']);
    await click(document.querySelector('[data-testid="entry-external"]'));
    byId('entry-notes.txt')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    await settle();
    expect(fixture.componentInstance.external).toEqual(['/home/u/notes.txt', '/home/u/notes.txt']);
    expect(fixture.componentInstance.edited).toEqual([]);
    await click(byId('entry-menu-disk.img'));
    const tooLarge = document.querySelector<HTMLButtonElement>('[data-testid="entry-external"]')!;
    expect(tooLarge.getAttribute('aria-disabled')).toBe('true');
    expect(tooLarge.textContent).toContain('Too large (max 1 GiB)');
    tooLarge.click();
    expect(fixture.componentInstance.external).toHaveLength(2);
    await click(byId('entry-menu-src'));
    expect(document.querySelector('[data-testid="entry-external"]')).toBeNull();
  });

  it('marks the rows of files open in an external editor, warning when they need attention', async () => {
    fixture = TestBed.createComponent(Host);
    source = new FakeSource('remote');
    fixture.componentInstance.source.set(source);
    fixture.componentInstance.editable.set(true);
    fixture.componentInstance.editedFiles.set(
      new Map([
        ['/home/u/notes.txt', editedFile('e1', 'h1', '/home/u/notes.txt')],
        [
          '/home/u/.profile',
          editedFile('e2', 'h1', '/home/u/.profile', { state: 'conflict', needsAttention: true }),
        ],
      ]),
    );
    await settle();
    const marker = byId('entry-external-marker-notes.txt')!;
    expect(marker.getAttribute('data-state')).toBe('synced');
    expect(marker.getAttribute('aria-label')).toBe('Open in an external editor · No changes');
    expect(marker.getAttribute('href')).toBe('/edited-files');
    expect(marker.classList.contains('_attention')).toBe(false);
    const name = byId('entry-notes.txt')!.querySelector('.name')!;
    expect(name.firstElementChild).toBe(marker);
    expect(name.querySelector('.kind')).toBeNull();
    expect(marker.innerHTML).toContain('external-link');
    await click(byId('pane-hidden'));
    const warning = byId('entry-external-marker-.profile')!;
    expect(warning.classList.contains('_attention')).toBe(true);
    expect(warning.innerHTML).toContain('triangle-alert');
    expect(warning.getAttribute('aria-label')).toBe(
      'Open in an external editor · Changed on server',
    );
    expect(byId('entry-external-marker-src')).toBeNull();
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
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Directory not empty. '),
      expect.anything(),
    );
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
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Read failed. '),
      expect.anything(),
    );
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
  describe('multi-selection', () => {
    const clickWith = async (id: string, init: MouseEventInit = {}): Promise<void> => {
      byId(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
      await settle();
    };
    const selected = (): string[] =>
      Array.from(el().querySelectorAll('tbody tr[aria-selected="true"]')).map((r) =>
        r.getAttribute('data-testid')!,
      );

    beforeEach(() => {
      TREE['/home/u'].entries.push(entry('/home/u', 'a.log'), entry('/home/u', 'b.log'));
    });

    it('toggles with Ctrl or Cmd, ranges with Shift and shows the count', async () => {
      await setup();
      expect(rowNames()).toEqual(['entry-src', 'entry-a.log', 'entry-b.log', 'entry-notes.txt']);
      expect(byId('pane-selection-count')).toBeNull();
      await clickWith('entry-a.log');
      await clickWith('entry-notes.txt', { ctrlKey: true });
      expect(selected()).toEqual(['entry-a.log', 'entry-notes.txt']);
      expect(byId('pane-selection-count')!.textContent).toContain('2 selected');
      await clickWith('entry-a.log', { metaKey: true });
      expect(selected()).toEqual(['entry-notes.txt']);

      await clickWith('entry-src');
      await clickWith('entry-b.log', { shiftKey: true });
      expect(selected()).toEqual(['entry-src', 'entry-a.log', 'entry-b.log']);
      await clickWith('entry-a.log', { shiftKey: true });
      expect(selected()).toEqual(['entry-src', 'entry-a.log']);
      expect(byId('pane-selection-count')!.textContent).toContain('2 selected');
    });

    it('selects all with Ctrl+A and returns to single selection with the arrows', async () => {
      await setup();
      byId('entry-src')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }),
      );
      await settle();
      expect(selected().length).toBe(4);
      expect(byId('pane-selection-count')!.textContent).toContain('4 selected');
      await key(byId('entry-src'), 'ArrowDown');
      expect(selected()).toEqual(['entry-a.log']);
    });

    it('clears the selection on navigation and keeps it on refresh', async () => {
      await setup();
      await clickWith('entry-a.log');
      await clickWith('entry-b.log', { ctrlKey: true });
      await click(byId('pane-refresh'));
      expect(selected()).toEqual(['entry-a.log', 'entry-b.log']);
      byId('entry-src')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await settle();
      expect(selected()).toEqual([]);
      expect(byId('pane-selection-count')).toBeNull();
    });

    it('keeps the selection when a selected row menu opens', async () => {
      await setup();
      await clickWith('entry-a.log');
      await clickWith('entry-b.log', { ctrlKey: true });
      await click(byId('entry-menu-b.log'));
      expect(selected()).toEqual(['entry-a.log', 'entry-b.log']);
    });
  });

  describe('transfers', () => {
    const drag = (): FileDrag => TestBed.inject(FileDrag);
    const dragEvent = (type: string, target: Element): Event => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const list = (): HTMLElement => el().querySelector<HTMLElement>('.scroll')!;

    it('sends the selection to the other pane directory, in display order', async () => {
      await setup(null, 'local');
      const upload = byId('pane-upload') as HTMLButtonElement;
      expect(upload.getAttribute('aria-label')).toBe('Upload to remote');
      expect(byId('pane-download')).toBeNull();
      expect(upload.disabled).toBe(true);

      byId('entry-notes.txt')!.click();
      byId('entry-src')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      await settle();
      expect(upload.disabled).toBe(true);

      fixture.componentInstance.transferTarget.set('/srv');
      await settle();
      expect(upload.disabled).toBe(false);
      await click(upload);
      expect(fixture.componentInstance.sent).toEqual([
        { sources: ['/home/u/src', '/home/u/notes.txt'], targetDir: '/srv' },
      ]);
    });

    it('labels the remote action as a download', async () => {
      await setup();
      expect(byId('pane-download')!.getAttribute('aria-label')).toBe('Download to local');
      expect(byId('pane-upload')).toBeNull();
    });

    it('puts no path in the OS drag data', async () => {
      await setup();
      const data = new Map<string, string>();
      const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { setData: (type: string, value: string) => data.set(type, value) },
      });
      byId('entry-src')!.dispatchEvent(event);
      expect([...data.values()].join()).not.toContain('/home/u');
      expect(data.has('application/x-carapace-files')).toBe(true);
      drag().end();
    });

    it('starts a drag with the selection, or the dragged row alone', async () => {
      await setup();
      byId('entry-notes.txt')!.click();
      await settle();
      dragEvent('dragstart', byId('entry-src')!);
      expect(drag().current()).toEqual({ side: 'remote', paths: ['/home/u/src'] });
      dragEvent('dragend', byId('entry-src')!);
      expect(drag().current()).toBeNull();

      byId('entry-notes.txt')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, ctrlKey: true }),
      );
      await settle();
      dragEvent('dragstart', byId('entry-notes.txt')!);
      expect(drag().current()!.paths).toEqual(['/home/u/src', '/home/u/notes.txt']);
      drag().end();
    });

    it('accepts drops from the other pane on the list or on a directory row', async () => {
      await setup();
      drag().start({ side: 'local', paths: ['C:\\a.txt'] });

      const over = dragEvent('dragover', byId('entry-notes.txt')!);
      expect(over.defaultPrevented).toBe(true);
      await settle();
      expect(list().classList.contains('_drop')).toBe(true);
      dragEvent('drop', byId('entry-notes.txt')!);
      expect(fixture.componentInstance.received).toEqual([
        { sources: ['C:\\a.txt'], targetDir: '/home/u' },
      ]);
      expect(drag().current()).toBeNull();

      drag().start({ side: 'local', paths: ['C:\\b.txt'] });
      dragEvent('dragover', byId('entry-src')!.querySelector('td')!);
      await settle();
      expect(byId('entry-src')!.classList.contains('_drop')).toBe(true);
      expect(list().classList.contains('_drop')).toBe(false);
      dragEvent('drop', byId('entry-src')!.querySelector('td')!);
      expect(fixture.componentInstance.received[1]).toEqual({
        sources: ['C:\\b.txt'],
        targetDir: '/home/u/src',
      });
    });

    it('ignores drags from the same pane', async () => {
      await setup();
      drag().start({ side: 'remote', paths: ['/home/u/notes.txt'] });
      expect(dragEvent('dragover', byId('entry-src')!).defaultPrevented).toBe(false);
      dragEvent('drop', list());
      await settle();
      expect(fixture.componentInstance.received).toEqual([]);
      expect(list().classList.contains('_drop')).toBe(false);
      drag().end();
    });

    it('refreshes when the listed directory revision changes', async () => {
      await setup();
      const calls = source.list.mock.calls.length;
      fixture.componentInstance.revisions.set(new Map([['/elsewhere', 1]]));
      await settle();
      expect(source.list.mock.calls.length).toBe(calls);
      fixture.componentInstance.revisions.set(new Map([['/home/u', 1]]));
      await settle();
      expect(source.list.mock.calls.length).toBe(calls + 1);
      expect(source.list).toHaveBeenLastCalledWith('/home/u');
    });
  });

  describe('context menus', () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const rightClick = async (target: Element, init: MouseEventInit = {}): Promise<Event> => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
        ...init,
      });
      target.dispatchEvent(event);
      await settle();
      return event;
    };
    const clickWith = async (id: string, init: MouseEventInit = {}): Promise<void> => {
      byId(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
      await settle();
    };
    const menu = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-testid="context-menu"]');
    const lists = (): NodeListOf<Element> => document.querySelectorAll('tui-data-list');
    const entries = (root: Element | null = menu()): string[] =>
      Array.from(root?.querySelectorAll('[tuiOption]') ?? []).map((o) =>
        o.getAttribute('data-testid')!,
      );
    const option = (id: string): HTMLElement =>
      document.querySelector<HTMLElement>(`tui-data-list [data-testid="${id}"]`)!;
    const selected = (): string[] =>
      Array.from(el().querySelectorAll('tbody tr[aria-selected="true"]')).map((r) =>
        r.getAttribute('data-testid')!,
      );
    const scroll = (): HTMLElement => el().querySelector<HTMLElement>('.scroll')!;

    beforeEach(() => {
      TREE['/home/u'].entries.push(entry('/home/u', 'a.log'), entry('/home/u', 'b.log'));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    afterEach(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
    });

    it('selects an unselected row alone and opens its menu at the pointer', async () => {
      await setup();
      fixture.componentInstance.editable.set(true);
      await clickWith('entry-a.log');
      await clickWith('entry-b.log', { ctrlKey: true });
      const event = await rightClick(byId('entry-notes.txt')!.querySelector('td')!);
      expect(event.defaultPrevented).toBe(true);
      expect(selected()).toEqual(['entry-notes.txt']);
      expect(menu()!.getAttribute('data-surface')).toBe('file-row');
      expect(menu()!.getAttribute('aria-label')).toBe('Actions for notes.txt');
      expect(entries()).toEqual([
        'entry-edit',
        'entry-external',
        'entry-transfer',
        'entry-copy-path',
        'entry-rename',
        'entry-delete',
      ]);
      expect(menu()!.querySelectorAll('hr').length).toBe(2);
      expect(document.activeElement).toBe(byId('entry-notes.txt'));
      // No row of the grid carries the dropdown's aria attributes.
      expect(el().querySelector('tr[aria-expanded], tr[aria-haspopup]')).toBeNull();
    });

    it('offers Open on folders and no editor entries on the local side', async () => {
      await setup(null, 'local');
      await rightClick(byId('entry-src')!);
      expect(entries()).toEqual([
        'entry-open',
        'entry-transfer',
        'entry-copy-path',
        'entry-rename',
        'entry-delete',
      ]);
      await click(option('entry-open'));
      expect(source.list).toHaveBeenLastCalledWith('/home/u/src');
    });

    it('keeps a multi-selection on a selected row and shows the multi menu', async () => {
      await setup();
      await clickWith('entry-src');
      await clickWith('entry-b.log', { shiftKey: true });
      expect(selected()).toEqual(['entry-src', 'entry-a.log', 'entry-b.log']);
      await rightClick(byId('entry-a.log')!, { ctrlKey: true });
      expect(selected()).toEqual(['entry-src', 'entry-a.log', 'entry-b.log']);
      expect(byId('entry-a.log')!.tabIndex).toBe(0);
      expect(menu()!.getAttribute('aria-label')).toBe('Actions for 3 items');
      expect(
        menu()!.querySelector('[data-testid="entry-menu-count"]')!.getAttribute('data-label'),
      ).toBe('3 selected');
      expect(entries()).toEqual(['entry-transfer', 'entry-copy-path', 'entry-delete']);
      expect(option('entry-copy-path').textContent).toContain('Copy paths');
    });

    it('gives the "…" of a row inside a multi-selection the multi menu', async () => {
      await setup();
      await clickWith('entry-a.log');
      await clickWith('entry-b.log', { ctrlKey: true });
      await click(byId('entry-menu-b.log'));
      expect(menu()).toBeNull();
      expect(entries(lists()[0])).toEqual(['entry-transfer', 'entry-copy-path', 'entry-delete']);
    });

    it('explains the transfer entry without a destination and sends with one', async () => {
      await setup(null, 'local');
      await rightClick(byId('entry-notes.txt')!);
      const transfer = option('entry-transfer');
      expect(transfer.getAttribute('aria-disabled')).toBe('true');
      expect(transfer.textContent).toContain('Connect to the remote first');
      await click(transfer);
      expect(fixture.componentInstance.sent).toEqual([]);

      fixture.componentInstance.transferTarget.set('/srv');
      await clickWith('entry-a.log');
      await clickWith('entry-notes.txt', { ctrlKey: true });
      await rightClick(byId('entry-notes.txt')!);
      expect(option('entry-transfer').getAttribute('aria-disabled')).toBeNull();
      await click(option('entry-transfer'));
      expect(fixture.componentInstance.sent).toEqual([
        { sources: ['/home/u/a.log', '/home/u/notes.txt'], targetDir: '/srv' },
      ]);
    });

    it('says to open a local folder in the remote pane when the local pane lists drives', async () => {
      await setup();
      fixture.componentInstance.transferTarget.set('');
      await rightClick(byId('entry-notes.txt')!);
      expect(option('entry-transfer').textContent).toContain('Open a local folder first');
      expect((byId('pane-download') as HTMLButtonElement).disabled).toBe(true);
    });

    it('copies the selected paths, one per line, in display order', async () => {
      await setup();
      await clickWith('entry-notes.txt');
      await clickWith('entry-src', { ctrlKey: true });
      await rightClick(byId('entry-src')!);
      await click(option('entry-copy-path'));
      expect(writeText).toHaveBeenCalledWith('/home/u/src\n/home/u/notes.txt');
      expect(alerts.open).toHaveBeenCalledWith('2 paths copied', { appearance: 'positive' });
    });

    it('reports a failed copy', async () => {
      await setup();
      writeText.mockRejectedValueOnce(new Error('denied'));
      await rightClick(byId('entry-notes.txt')!);
      await click(option('entry-copy-path'));
      expect(alerts.open).toHaveBeenCalledWith('The clipboard is not available.', {
        label: 'Copy failed',
        appearance: 'negative',
      });
    });

    it('opens the folder menu on the empty area and clears the selection', async () => {
      await setup();
      await clickWith('entry-a.log');
      await rightClick(el().querySelector('thead th')!);
      expect(selected()).toEqual([]);
      expect(menu()!.getAttribute('data-surface')).toBe('file-pane');
      expect(menu()!.getAttribute('aria-label')).toBe('Folder actions');
      expect(entries()).toEqual([
        'pane-menu-mkdir',
        'pane-menu-refresh',
        'pane-menu-hidden',
        'pane-menu-select-all',
        'pane-menu-copy-path',
      ]);
      const hidden = option('pane-menu-hidden');
      expect(hidden.getAttribute('role')).toBe('menuitemcheckbox');
      expect(hidden.getAttribute('aria-checked')).toBe('false');
      await click(hidden);
      expect(rowNames()).toContain('entry-.profile');
      await rightClick(scroll());
      expect(option('pane-menu-hidden').getAttribute('aria-checked')).toBe('true');
      await click(option('pane-menu-select-all'));
      expect(selected().length).toBe(5);
      expect(document.activeElement?.tagName).toBe('TR');

      await rightClick(scroll());
      await click(option('pane-menu-mkdir'));
      expect(dialogs.askName).toHaveBeenCalled();
      await rightClick(scroll());
      await click(option('pane-menu-copy-path'));
      expect(writeText).toHaveBeenLastCalledWith('/home/u');
    });

    it('leaves only the context menu when a row is right-clicked with its "…" open', async () => {
      await setup();
      await click(byId('entry-menu-notes.txt'));
      expect(lists().length).toBe(1);
      expect(byId('entry-menu-notes.txt')!.getAttribute('aria-expanded')).toBe('true');
      await rightClick(byId('entry-notes.txt')!);
      expect(lists().length).toBe(1);
      expect(menu()).not.toBeNull();
      expect(byId('entry-menu-notes.txt')!.getAttribute('aria-expanded')).not.toBe('true');
    });

    it('opens the row "…" with Shift+F10 and ContextMenu, first entry focused', async () => {
      await setup();
      const row = byId('entry-notes.txt')!;
      row.focus();
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      );
      await settle();
      expect(byId('entry-menu-notes.txt')!.getAttribute('aria-expanded')).toBe('true');
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(option('entry-transfer'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      await key(byId('entry-src'), 'ContextMenu');
      expect(byId('entry-menu-src')!.getAttribute('aria-expanded')).toBe('true');
    });

    it('deletes the selection with Delete: one confirm, one call each, one refresh', async () => {
      await setup();
      await clickWith('entry-src');
      await clickWith('entry-notes.txt', { ctrlKey: true });
      const listed = source.list.mock.calls.length;
      await key(byId('entry-notes.txt'), 'Delete');
      expect(dialogs.confirmDelete).not.toHaveBeenCalled();
      expect(dialogs.confirmDeleteMany).toHaveBeenCalledTimes(1);
      expect(dialogs.confirmDeleteMany.mock.calls[0][0].map((e) => e.name)).toEqual([
        'src',
        'notes.txt',
      ]);
      expect(source.delete.mock.calls).toEqual([
        ['/home/u/src', true],
        ['/home/u/notes.txt', false],
      ]);
      expect(source.list.mock.calls.length).toBe(listed + 1);
      expect(rowNames()).toEqual(['entry-a.log', 'entry-b.log']);
    });

    it('deletes only the focused row with Delete when it is outside the selection', async () => {
      await setup();
      await clickWith('entry-a.log');
      await key(byId('entry-b.log'), 'Delete');
      expect(dialogs.confirmDelete).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'b.log' }),
      );
      expect(dialogs.confirmDeleteMany).not.toHaveBeenCalled();
    });

    it('keeps deleting after a failure and reports the failures in one toast', async () => {
      await setup();
      source.delete.mockImplementation((path: string) =>
        path.endsWith('.log')
          ? Promise.reject(new IpcError('permission_denied', 'Permission denied'))
          : Promise.resolve(),
      );
      await clickWith('entry-src');
      await clickWith('entry-notes.txt', { shiftKey: true });
      await rightClick(byId('entry-a.log')!);
      await click(option('entry-delete'));
      expect(source.delete).toHaveBeenCalledTimes(4);
      expect(alerts.open).toHaveBeenCalledTimes(1);
      const [text, options] = alerts.open.mock.calls[0] as unknown as [string, { label: string }];
      expect(options.label).toBe('Not deleted');
      expect(text).toContain('2 of 4 items not deleted: a.log, b.log.');
      expect(text).toContain('Permission denied');
    });

    it('does nothing when the multi delete is cancelled', async () => {
      await setup();
      dialogs.confirmDeleteMany.mockResolvedValueOnce(false);
      await clickWith('entry-a.log');
      await clickWith('entry-b.log', { ctrlKey: true });
      await key(byId('entry-b.log'), 'Delete');
      expect(source.delete).not.toHaveBeenCalled();
    });
  });
});
