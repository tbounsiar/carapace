import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { TuiTable, type TuiComparator, type TuiTableSortChange } from '@taiga-ui/addon-table';
import { TuiItem } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiIcon,
  TuiLink,
  TuiLoader,
  TuiNotification,
  TuiNotificationService,
} from '@taiga-ui/core';
import { TuiBreadcrumbs } from '@taiga-ui/kit';
import type { FileEntry, FileSource, Listing } from '../../../core/ipc/files';
import { IpcError } from '../../../core/ipc/ipc-error';
import { notifyError } from '../../project-tree/save-error';
import { FileDialogs } from '../file-dialogs';
import {
  compareEntries,
  formatModified,
  formatSize,
  isOpenable,
  KIND_ICONS,
  sortEntries,
  visibleEntries,
  type SortDirection,
  type SortKey,
} from '../file-list';
import { crumbs, upTarget } from '../file-path';
import { FileSelection } from '../file-selection';

interface Row {
  entry: FileEntry;
  icon: string;
  size: string;
  modified: string;
}

interface NavigateOptions {
  select?: string | null;
  focus?: boolean;
  fallbackHome?: boolean;
}

const SORT_KEYS: readonly SortKey[] = ['name', 'size', 'modified'];

// The table only uses these as column identities; rows are sorted by `sortEntries`.
const SORTERS = Object.fromEntries(
  SORT_KEYS.map((key) => [key, (a: FileEntry, b: FileEntry) => compareEntries(a, b, key, 1)]),
) as Record<SortKey, TuiComparator<FileEntry>>;

@Component({
  imports: [
    TuiBreadcrumbs,
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiHint,
    TuiIcon,
    TuiItem,
    TuiLink,
    TuiLoader,
    TuiNotification,
    TuiTable,
  ],
  selector: 'app-file-pane',
  styleUrl: './file-pane.scss',
  templateUrl: './file-pane.html',
})
export class FilePane {
  private readonly dialogs = inject(FileDialogs);
  private readonly alerts = inject(TuiNotificationService);
  private readonly injector = inject(Injector);

  readonly source = input.required<FileSource>();
  readonly label = input.required<string>();
  /** Where to start; the home directory when null or when it can't be listed. */
  readonly startPath = input<string | null>(null);
  readonly pathChange = output<string>();

  protected readonly sorters = SORTERS;
  protected readonly selection = new FileSelection();
  protected readonly listing = signal<Listing | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showHidden = signal(false);
  protected readonly sortKey = signal<SortKey>('name');
  protected readonly direction = signal<SortDirection>(1);
  protected readonly openMenu = signal<string | null>(null);

  private readonly rowElements = viewChildren<ElementRef<HTMLElement>>('row');
  private sequence = 0;

  protected readonly side = computed(() => this.source().side);
  protected readonly showPermissions = computed(() => this.side() === 'remote');
  protected readonly columnCount = computed(() => (this.showPermissions() ? 5 : 4));
  protected readonly sorter = computed(() => SORTERS[this.sortKey()]);
  protected readonly path = computed(() => this.listing()?.path ?? null);
  protected readonly crumbs = computed(() => {
    const path = this.path();
    return path === null ? [] : crumbs(path, this.side());
  });
  protected readonly upPath = computed(() => {
    const listing = this.listing();
    return listing ? upTarget(listing.path, listing.parent, this.side()) : null;
  });
  protected readonly canCreate = computed(() => !!this.path());
  protected readonly rows = computed<Row[]>(() =>
    sortEntries(
      visibleEntries(this.listing()?.entries ?? [], this.showHidden()),
      this.sortKey(),
      this.direction(),
    ).map((entry) => ({
      entry,
      icon: KIND_ICONS[entry.kind],
      size: entry.kind === 'dir' ? '' : formatSize(entry.size),
      modified: formatModified(entry.modified),
    })),
  );
  protected readonly hiddenCount = computed(
    () => this.listing()?.entries.filter((e) => e.hidden).length ?? 0,
  );
  protected readonly activeIndex = computed(() => {
    const primary = this.selection.primary();
    const index = primary === null ? -1 : this.rows().findIndex((r) => r.entry.path === primary);
    return Math.max(index, 0);
  });

  constructor() {
    effect(() => {
      const source = this.source();
      const start = untracked(this.startPath);
      untracked(() => void this.start(source, start));
    });
  }

  protected navigate(path: string, options: NavigateOptions = {}): Promise<void> {
    return this.load(this.source(), path, options);
  }

  protected refresh(): void {
    const path = this.path();
    if (path !== null) {
      void this.navigate(path, { select: this.selection.primary() });
    }
  }

  protected up(focus = false): void {
    const target = this.upPath();
    if (target !== null) {
      void this.navigate(target, { select: this.path(), focus });
    }
  }

  protected toggleHidden(): void {
    this.showHidden.update((v) => !v);
  }

  protected onSort(change: TuiTableSortChange<FileEntry>): void {
    const key = SORT_KEYS.find((k) => SORTERS[k] === change.sortComparator) ?? 'name';
    this.sortKey.set(key);
    this.direction.set(change.sortDirection);
  }

  protected select(entry: FileEntry): void {
    this.selection.select(entry.path);
  }

  protected open(entry: FileEntry, focus = false): void {
    if (isOpenable(entry)) {
      void this.navigate(entry.path, { focus });
    }
  }

  protected onDblClick(event: MouseEvent, entry: FileEntry): void {
    if (!(event.target instanceof Element && event.target.closest('button'))) {
      this.open(entry);
    }
  }

  protected onRowKeydown(event: KeyboardEvent, index: number): void {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const rows = this.rows();
    const entry = rows[index]?.entry;
    if (!entry) {
      return;
    }
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(index + 1, rows.length - 1);
        break;
      case 'ArrowUp':
        next = Math.max(index - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      case 'Enter':
        this.open(entry, true);
        break;
      case 'Backspace':
        this.up(true);
        break;
      case 'F2':
        this.rename(entry);
        break;
      case 'Delete':
        void this.remove(entry);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== null) {
      this.selection.select(rows[next].entry.path);
      this.rowElements()[next]?.nativeElement.focus();
    }
  }

  protected setMenu(entry: FileEntry, open: boolean): void {
    this.openMenu.set(open ? entry.path : null);
    if (open) {
      this.select(entry);
    }
  }

  protected mkdir(): void {
    const parent = this.path();
    if (!parent) {
      return;
    }
    const source = this.source();
    this.dialogs.askName('New folder', source.side, '', async (name) => {
      const created = await source.mkdir(parent, name);
      await this.load(source, parent, { select: created.path });
    });
  }

  protected rename(entry: FileEntry): void {
    const parent = this.path();
    if (parent === null) {
      return;
    }
    const source = this.source();
    this.dialogs.askName(`Rename "${entry.name}"`, source.side, entry.name, async (name) => {
      if (name === entry.name) {
        return;
      }
      const renamed = await source.rename(entry.path, name);
      await this.load(source, parent, { select: renamed.path });
    });
  }

  protected async remove(entry: FileEntry): Promise<void> {
    const parent = this.path();
    if (parent === null || !(await this.dialogs.confirmDelete(entry))) {
      return;
    }
    const source = this.source();
    try {
      await source.delete(entry.path, entry.kind === 'dir');
    } catch (err) {
      notifyError(this.alerts, err);
    }
    await this.load(source, parent, { select: null });
  }

  private async start(source: FileSource, start: string | null): Promise<void> {
    this.listing.set(null);
    this.error.set(null);
    this.selection.clear();
    if (start !== null) {
      await this.load(source, start, { fallbackHome: true });
      return;
    }
    try {
      await this.load(source, await source.home());
    } catch (err) {
      this.fail(err);
    }
  }

  private async load(
    source: FileSource,
    path: string,
    options: NavigateOptions = {},
  ): Promise<void> {
    const sequence = ++this.sequence;
    this.loading.set(true);
    try {
      const listing = await source.list(path);
      if (sequence !== this.sequence || source !== this.source()) {
        return;
      }
      const previous = this.path();
      this.listing.set(listing);
      this.error.set(null);
      if (options.select !== undefined) {
        this.selection.clear();
        if (options.select !== null) {
          this.selection.select(options.select);
        }
      } else if (previous !== listing.path) {
        this.selection.clear();
      }
      this.selection.retain(new Set(listing.entries.map((e) => e.path)));
      this.pathChange.emit(listing.path);
      if (options.focus) {
        afterNextRender(() => this.focusActiveRow(), { injector: this.injector });
      }
    } catch (err) {
      if (sequence !== this.sequence || source !== this.source()) {
        return;
      }
      if (options.fallbackHome) {
        this.sequence++;
        this.loading.set(false);
        await this.load(source, await source.home().catch(() => ''));
        return;
      }
      this.fail(err);
    } finally {
      if (sequence === this.sequence) {
        this.loading.set(false);
      }
    }
  }

  /** A refused listing stays in the pane, so the previous path remains usable. */
  private fail(err: unknown): void {
    if (err instanceof IpcError && err.code === 'permission_denied') {
      this.error.set(err.message);
      return;
    }
    if (this.listing() === null) {
      this.error.set(err instanceof IpcError ? err.message : 'Unexpected error');
    }
    notifyError(this.alerts, err);
  }

  private focusActiveRow(): void {
    this.rowElements()[this.activeIndex()]?.nativeElement.focus();
  }
}
