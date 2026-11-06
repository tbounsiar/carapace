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
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { RouterLink } from '@angular/router';
import { TuiTable, type TuiComparator, type TuiTableSortChange } from '@taiga-ui/addon-table';
import { TuiAutoFocus, TuiItem } from '@taiga-ui/cdk';
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
import { TuiBadge, TuiBreadcrumbs } from '@taiga-ui/kit';
import { LanguageService } from '../../../core/i18n/language';
import { MAX_EDIT_BYTES } from '../../../core/ipc/editor-files';
import { isMenuKey } from '../../../shared/context-menu/context-menu';
import { ContextMenuTarget } from '../../../shared/context-menu/context-menu-target';
import { OptionLabel } from '../../../shared/option-reason/option-label';
import { OptionReason } from '../../../shared/option-reason/option-reason';
import { type EditedFile, MAX_EXTERNAL_BYTES } from '../../../core/ipc/external-edits';
import type { FileEntry, FileSource, Listing } from '../../../core/ipc/files';
import { IpcError } from '../../../core/ipc/ipc-error';
import { stateLook } from '../../external-editor/edited-view';
import { escapeHtml } from '../../../shared/path-breaks';
import { errorText, notifyError } from '../../../shared/save-error';
import { ClipboardText } from '../../../core/clipboard/clipboard-text';
import { FileDialogs, fileNames } from '../file-dialogs';
import { DRAG_PLACEHOLDER, DRAG_TYPE, FileDrag } from '../file-drag';
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

interface Marker {
  readonly state: EditedFile['state'];
  readonly attention: boolean;
  readonly label: string;
}

interface Row {
  entry: FileEntry;
  icon: string;
  size: string;
  modified: string;
  marker: Marker | null;
}

/** Paths to copy and the directory they go into. */
export interface PaneTransfer {
  readonly sources: readonly string[];
  readonly targetDir: string;
}

interface NavigateOptions {
  select?: string | null;
  focus?: boolean;
  fallbackHome?: boolean;
  /** Runs instead of reporting a failed listing. */
  onFail?: () => void;
}

/** One entry of a file row or pane menu; the "…" and the context menu render the same list. */
export interface MenuEntry {
  /** The `data-testid`. */
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  /** Why the entry is unavailable; null when it can run. */
  readonly reason: string | null;
  /** Set for a toggle (`menuitemcheckbox`). */
  readonly checked?: boolean;
  readonly run: () => void;
}

export interface PaneMenu {
  readonly aria: string;
  /** Group label of a multi-selection menu ("3 selected"). */
  readonly count: string | null;
  /** Separated by `<hr />`. */
  readonly groups: readonly (readonly MenuEntry[])[];
}

const SORT_KEYS: readonly SortKey[] = ['name', 'size', 'modified'];

// The table only uses these as column identities; rows are sorted by `sortEntries`.
const SORTERS = Object.fromEntries(
  SORT_KEYS.map((key) => [key, (a: FileEntry, b: FileEntry) => compareEntries(a, b, key, 1)]),
) as Record<SortKey, TuiComparator<FileEntry>>;

@Component({
  imports: [
    ContextMenuTarget,
    NgTemplateOutlet,
    OptionLabel,
    OptionReason,
    RouterLink,
    TuiBadge,
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
    TuiAutoFocus,
    TuiTable,
    TranslocoPipe,
  ],
  selector: 'app-file-pane',
  styleUrl: './file-pane.scss',
  templateUrl: './file-pane.html',
})
export class FilePane {
  private readonly dialogs = inject(FileDialogs);
  private readonly alerts = inject(TuiNotificationService);
  private readonly clipboard = inject(ClipboardText);
  private readonly injector = inject(Injector);
  private readonly drag = inject(FileDrag);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  /** Read by computed texts so they follow a language switch once its translations are loaded. */
  private readonly translation = toSignal(this.transloco.selectTranslation());

  readonly source = input.required<FileSource>();
  readonly label = input.required<string>();
  /** Where to start; the home directory when null or when it can't be listed. */
  readonly startPath = input<string | null>(null);
  /** The other pane's directory; null when transfers to it are not possible. */
  readonly transferTarget = input<string | null>(null);
  /** Per listed directory, a counter bumped when something was written into it. */
  readonly revisions = input<ReadonlyMap<string, number>>(new Map());
  readonly pathChange = output<string>();
  /** Selected entries to copy into `transferTarget`. */
  readonly send = output<PaneTransfer>();
  /** Entries dropped from the other pane into this one. */
  readonly receive = output<PaneTransfer>();
  /** Files open in the editor (remote panes only). */
  readonly editable = input(false);
  /** A file to open in the editor: Edit, Enter or double-click. */
  readonly edit = output<FileEntry>();
  /** Files of this host open in an external editor, by remote path (remote panes only). */
  readonly edited = input<ReadonlyMap<string, EditedFile>>(new Map());
  /** A file to open in the external editor: its menu entry or Shift+Enter. */
  readonly openExternal = output<FileEntry>();

  protected readonly sorters = SORTERS;
  protected readonly selection = new FileSelection();
  protected readonly listing = signal<Listing | null>(null);
  protected readonly loading = signal(false);
  /** Several entries are being deleted: the loader stays on and the rows ignore keys. */
  protected readonly deleting = signal(false);
  /** From the confirm to the reload: a second delete meanwhile is refused. */
  private deleteRunning = false;
  protected readonly error = signal<string | null>(null);
  protected readonly showHidden = signal(false);
  protected readonly sortKey = signal<SortKey>('name');
  protected readonly direction = signal<SortDirection>(1);
  protected readonly openMenu = signal<string | null>(null);
  /** The entries the row menu acts on, captured when it opened. */
  private readonly menuEntries = signal<readonly FileEntry[]>([]);
  /** What the open context menu is about: rows, or the listed folder. */
  protected readonly contextKind = signal<'row' | 'pane'>('row');
  /** The "…" menu was opened from the keyboard: its first entry takes the focus. */
  protected readonly keyboardMenu = signal(false);
  private readonly dropTarget = signal<string | null>(null);

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
  protected readonly rows = computed<Row[]>(() => {
    this.translation();
    const locale = this.language.locale();
    return sortEntries(
      visibleEntries(this.listing()?.entries ?? [], this.showHidden()),
      this.sortKey(),
      this.direction(),
    ).map((entry) => ({
      entry,
      icon: KIND_ICONS[entry.kind],
      size: entry.kind === 'dir' ? '' : formatSize(entry.size, locale),
      modified: formatModified(entry.modified, locale),
      marker: this.markerOf(this.edited().get(entry.path), locale),
    }));
  });
  protected readonly transferLabel = computed(() => {
    this.translation();
    return this.t(this.side() === 'local' ? 'files.pane.upload' : 'files.pane.download');
  });
  /** `''` is the local drive list: nothing can be written there. */
  protected readonly canSend = computed(
    () => !!this.transferTarget() && this.selection.count() > 0,
  );
  protected readonly rowMenu = computed<PaneMenu>(() => {
    this.translation();
    return this.entryMenuOf(this.menuEntries());
  });
  protected readonly paneMenu = computed<PaneMenu>(() => {
    this.translation();
    return this.folderMenu();
  });
  protected readonly activeDrop = computed(() => (this.drag.current() ? this.dropTarget() : null));
  private readonly revision = computed(
    () => {
      const path = this.path();
      return path === null ? null : { path, count: this.revisions().get(path) ?? 0 };
    },
    { equal: (a, b) => a?.path === b?.path && a?.count === b?.count },
  );
  private lastRevision: { path: string; count: number } | null = null;
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
    effect(() => {
      const current = this.revision();
      const last = this.lastRevision;
      this.lastRevision = current;
      if (current && last && current.path === last.path && current.count !== last.count) {
        untracked(() => this.refresh());
      }
    });
  }

  protected navigate(path: string, options: NavigateOptions = {}): Promise<void> {
    return this.load(this.source(), path, options);
  }

  protected refresh(): void {
    const path = this.path();
    if (path !== null) {
      void this.navigate(path);
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

  protected onRowClick(event: MouseEvent, entry: FileEntry): void {
    if (event.target instanceof Element && event.target.closest('button, a')) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      this.selection.toggle(entry.path);
    } else if (event.shiftKey) {
      this.selection.range(this.orderedPaths(), entry.path);
    } else {
      this.selection.select(entry.path);
    }
  }

  protected sendSelection(): void {
    this.sendEntries(this.selectedInOrder());
  }

  /** Lists `dir` and selects `select` when it is listed there (transfer "Show in pane"). */
  show(dir: string, select: string | null): void {
    void this.navigate(dir, { select, focus: true });
  }

  private sendEntries(sources: readonly string[]): void {
    const targetDir = this.transferTarget();
    if (targetDir && sources.length > 0) {
      this.send.emit({ sources: [...sources], targetDir });
    }
  }

  protected onDragStart(event: DragEvent, entry: FileEntry): void {
    if (!this.selection.has(entry.path)) {
      this.selection.select(entry.path);
    }
    const paths = this.selectedInOrder();
    if (event.dataTransfer) {
      event.dataTransfer.setData(DRAG_TYPE, DRAG_PLACEHOLDER);
      event.dataTransfer.effectAllowed = 'copy';
    }
    this.drag.start({ side: this.side(), paths });
  }

  protected onDragEnd(): void {
    this.drag.end();
  }

  protected onDragOver(event: DragEvent): void {
    const target = this.dropTargetOf(event);
    if (target === null) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.dropTarget.set(target);
  }

  protected onDragLeave(event: DragEvent): void {
    const container = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node && container.contains(event.relatedTarget))) {
      this.dropTarget.set(null);
    }
  }

  protected onDrop(event: DragEvent): void {
    const target = this.dropTargetOf(event);
    const files = this.drag.current();
    this.dropTarget.set(null);
    if (target === null || !files) {
      return;
    }
    event.preventDefault();
    this.drag.end();
    this.receive.emit({ sources: files.paths, targetDir: target });
  }

  /** Only drags from the other pane are accepted: same-side copies are not transfers. */
  private dropTargetOf(event: DragEvent): string | null {
    const files = this.drag.current();
    const path = this.path();
    if (!files || files.side === this.side() || path === null) {
      return null;
    }
    const row =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-drop-dir]') : null;
    return row?.dataset['dropDir'] ?? path;
  }

  private orderedPaths(): string[] {
    return this.rows().map((r) => r.entry.path);
  }

  private selectedInOrder(): string[] {
    return this.orderedPaths().filter((p) => this.selection.has(p));
  }

  private selectedEntries(): FileEntry[] {
    return this.rows()
      .map((r) => r.entry)
      .filter((e) => this.selection.has(e.path));
  }

  /** Right click and "…" rule: an unselected row becomes the selection, a selected one keeps it. */
  private target(entry: FileEntry): void {
    if (this.selection.has(entry.path)) {
      this.selection.focus(entry.path);
    } else {
      this.selection.select(entry.path);
    }
    this.menuEntries.set(this.selectedEntries());
  }

  /** Runs before Taiga opens the pane's context menu (spec F1). */
  protected onContextTarget(row: HTMLElement | null): void {
    this.openMenu.set(null);
    this.keyboardMenu.set(false);
    const path = row?.dataset['menuRow'];
    const found = path === undefined ? undefined : this.rows().find((r) => r.entry.path === path);
    if (!found || !row) {
      this.selection.clear();
      this.contextKind.set('pane');
      return;
    }
    this.contextKind.set('row');
    this.target(found.entry);
    row.focus();
  }

  private entryMenuOf(entries: readonly FileEntry[]): PaneMenu {
    const [entry] = entries;
    const paths = entries.map((e) => e.path);
    const transfer: MenuEntry = {
      id: 'entry-transfer',
      icon: this.side() === 'local' ? '@tui.upload' : '@tui.download',
      label: this.transferLabel(),
      reason: this.transferTarget()
        ? null
        : this.t(this.side() === 'local' ? 'files.menu.noRemote' : 'files.menu.noLocal'),
      run: () => this.sendEntries(paths),
    };
    const remove: MenuEntry = {
      id: 'entry-delete',
      icon: '@tui.trash',
      label: this.t('common.delete'),
      reason: null,
      run: () => void this.removeEntries(entries),
    };
    if (entries.length > 1) {
      return {
        aria: this.t('files.menu.actionsForMany', { count: entries.length }),
        count: this.t('files.pane.selected', { count: entries.length }),
        groups: [
          [transfer],
          [
            {
              id: 'entry-copy-path',
              icon: '@tui.copy',
              label: this.t('files.menu.copyPaths'),
              reason: null,
              run: () => void this.copyPaths(paths),
            },
          ],
          [remove],
        ],
      };
    }
    if (!entry) {
      return { aria: '', count: null, groups: [] };
    }
    const open: MenuEntry[] = [];
    if (isOpenable(entry)) {
      open.push({
        id: 'entry-open',
        icon: '@tui.folder-open',
        label: this.t('files.menu.open'),
        reason: null,
        run: () => this.open(entry, true),
      });
    }
    if (this.canEdit(entry)) {
      open.push(
        {
          id: 'entry-edit',
          icon: '@tui.file-pen',
          label: this.t('common.edit'),
          reason: this.isTooLarge(entry) ? this.t('files.pane.tooLargeEdit') : null,
          run: () => this.edit.emit(entry),
        },
        {
          id: 'entry-external',
          icon: '@tui.external-link',
          label: this.t('files.pane.openExternal'),
          reason: this.isTooLargeExternal(entry) ? this.t('files.pane.tooLargeExternal') : null,
          run: () => this.openExternal.emit(entry),
        },
      );
    }
    open.push(transfer);
    return {
      aria: this.t('files.pane.actionsFor', { name: entry.name }),
      count: null,
      groups: [
        open,
        [
          {
            id: 'entry-copy-path',
            icon: '@tui.copy',
            label: this.t('files.menu.copyPath'),
            reason: null,
            run: () => void this.copyPaths(paths),
          },
          {
            id: 'entry-rename',
            icon: '@tui.pencil',
            label: this.t('common.rename'),
            reason: null,
            run: () => this.rename(entry),
          },
        ],
        [remove],
      ],
    };
  }

  private folderMenu(): PaneMenu {
    const path = this.path();
    const folder: MenuEntry[] = [];
    if (this.canCreate()) {
      folder.push({
        id: 'pane-menu-mkdir',
        icon: '@tui.folder-plus',
        label: this.t('files.pane.newFolder'),
        reason: null,
        run: () => this.mkdir(),
      });
    }
    if (path !== null) {
      folder.push({
        id: 'pane-menu-refresh',
        icon: '@tui.refresh-cw',
        label: this.t('files.pane.refresh'),
        reason: null,
        run: () => this.refresh(),
      });
    }
    folder.push({
      id: 'pane-menu-hidden',
      icon: '@tui.eye',
      label: this.t('files.pane.showHidden'),
      reason: null,
      checked: this.showHidden(),
      run: () => this.toggleHidden(),
    });
    const list: MenuEntry[] = [];
    if (this.rows().length) {
      list.push({
        id: 'pane-menu-select-all',
        icon: '@tui.list-checks',
        label: this.t('files.menu.selectAll'),
        reason: null,
        run: () => this.selectAll(),
      });
    }
    if (path) {
      list.push({
        id: 'pane-menu-copy-path',
        icon: '@tui.copy',
        label: this.t('files.menu.copyFolderPath'),
        reason: null,
        run: () => void this.copyPaths([path]),
      });
    }
    return { aria: this.t('files.menu.folderActions'), count: null, groups: [folder, list] };
  }

  /** Focuses the primary row afterwards, so Delete and Shift+F10 work right away. */
  private selectAll(): void {
    this.selection.selectAll(this.orderedPaths());
    afterNextRender(() => this.focusActiveRow(), { injector: this.injector });
  }

  private async copyPaths(paths: readonly string[]): Promise<void> {
    try {
      await this.clipboard.write(paths.join('\n'));
      this.alerts
        .open(this.t('files.menu.pathsCopied', { count: paths.length }), {
          appearance: 'positive',
        })
        .subscribe();
    } catch {
      this.alerts
        .open(this.t('files.menu.noClipboard'), {
          label: this.t('files.menu.copyFailed'),
          appearance: 'negative',
        })
        .subscribe();
    }
  }

  protected canEdit(entry: FileEntry): boolean {
    return this.editable() && (entry.kind === 'file' || entry.kind === 'symlink');
  }

  protected isTooLargeExternal(entry: FileEntry): boolean {
    return entry.size !== null && entry.size > MAX_EXTERNAL_BYTES;
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }

  private markerOf(file: EditedFile | undefined, locale: string): Marker | null {
    if (!file) {
      return null;
    }
    return {
      state: file.state,
      attention: file.needsAttention,
      label: this.t('files.pane.marker', { state: stateLook(file, locale).word }),
    };
  }

  protected isTooLarge(entry: FileEntry): boolean {
    return entry.size !== null && entry.size > MAX_EDIT_BYTES;
  }

  /** Directories open; files go to the editor; a symlink is tried as a directory first. */
  protected open(entry: FileEntry, focus = false): void {
    if (entry.kind === 'symlink' && this.editable()) {
      void this.navigate(entry.path, { focus, onFail: () => this.edit.emit(entry) });
    } else if (isOpenable(entry)) {
      void this.navigate(entry.path, { focus });
    } else if (this.canEdit(entry)) {
      this.edit.emit(entry);
    }
  }

  protected onDblClick(event: MouseEvent, entry: FileEntry): void {
    if (!(event.target instanceof Element && event.target.closest('button, a'))) {
      this.open(entry);
    }
  }

  protected onRowKeydown(event: KeyboardEvent, index: number): void {
    if (event.target !== event.currentTarget || this.deleting()) {
      return;
    }
    if (isMenuKey(event)) {
      const entry = this.rows()[index]?.entry;
      if (entry) {
        event.preventDefault();
        this.setMenu(entry, true);
        this.keyboardMenu.set(true);
      }
      return;
    }
    if (event.altKey) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selection.selectAll(this.orderedPaths());
      return;
    }
    if (event.ctrlKey || event.metaKey) {
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
        if (!event.shiftKey) {
          this.open(entry, true);
        } else if (this.canEdit(entry)) {
          this.openExternal.emit(entry);
        }
        break;
      case 'Backspace':
        this.up(true);
        break;
      case 'F2':
        this.rename(entry);
        break;
      case 'Delete':
        void this.removeEntries(this.selection.has(entry.path) ? this.selectedEntries() : [entry]);
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
    if (open) {
      this.keyboardMenu.set(false);
      this.target(entry);
      this.openMenu.set(entry.path);
      return;
    }
    if (this.openMenu() !== entry.path) {
      return;
    }
    this.openMenu.set(null);
    if (this.keyboardMenu()) {
      this.keyboardMenu.set(false);
      afterNextRender(() => this.refocusRow(entry.path), { injector: this.injector });
    }
  }

  /** Esc on a keyboard-opened menu puts the focus back on its row, not on the "…" button. */
  private refocusRow(path: string): void {
    const index = this.rows().findIndex((r) => r.entry.path === path);
    const row = this.rowElements()[index]?.nativeElement;
    const active = document.activeElement;
    if (row && (!active || active === document.body || row.contains(active))) {
      row.focus();
    }
  }

  protected mkdir(): void {
    const parent = this.path();
    if (!parent) {
      return;
    }
    const source = this.source();
    this.dialogs.askName(this.t('files.pane.newFolder'), source.side, '', async (name) => {
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
    const label = this.t('files.pane.renameTitle', { name: escapeHtml(entry.name) });
    this.dialogs.askName(label, source.side, entry.name, async (name) => {
      if (name === entry.name) {
        return;
      }
      const renamed = await source.rename(entry.path, name);
      await this.load(source, parent, { select: renamed.path });
    });
  }

  /** Several entries: one confirm, deletes one after the other, one refresh, one failure toast. */
  protected async removeEntries(entries: readonly FileEntry[]): Promise<void> {
    if (entries.length <= 1) {
      if (entries[0]) {
        await this.remove(entries[0]);
      }
      return;
    }
    const parent = this.path();
    if (parent === null || this.deleteRunning) {
      return;
    }
    this.deleteRunning = true;
    try {
      if (await this.dialogs.confirmDeleteMany(entries)) {
        this.deleting.set(true);
        await this.deleteMany(parent, entries);
      }
    } finally {
      this.deleteRunning = false;
      this.deleting.set(false);
    }
  }

  private async deleteMany(parent: string, entries: readonly FileEntry[]): Promise<void> {
    const source = this.source();
    const failed: { name: string; error: unknown }[] = [];
    for (const entry of entries) {
      try {
        await source.delete(entry.path, entry.kind === 'dir');
      } catch (error) {
        failed.push({ name: entry.name, error });
      }
    }
    if (failed.length) {
      const names = fileNames(
        failed.map((f) => f.name),
        3,
      );
      this.alerts
        .open(
          this.t('files.menu.notDeletedText', {
            failed: failed.length,
            count: entries.length,
            names,
            reason: errorText(failed[0].error),
          }),
          { label: this.t('files.menu.notDeleted'), appearance: 'negative' },
        )
        .subscribe();
    }
    await this.reloadAfterDelete(source, parent);
  }

  protected async remove(entry: FileEntry): Promise<void> {
    const parent = this.path();
    if (parent === null || this.deleteRunning) {
      return;
    }
    this.deleteRunning = true;
    try {
      if (!(await this.dialogs.confirmDelete(entry))) {
        return;
      }
      const source = this.source();
      try {
        await source.delete(entry.path, entry.kind === 'dir');
      } catch (err) {
        notifyError(
          this.alerts,
          err,
          this.t(
            entry.kind === 'dir' ? 'files.pane.folderNotDeleted' : 'files.pane.fileNotDeleted',
          ),
        );
      }
      await this.reloadAfterDelete(source, parent);
    } finally {
      this.deleteRunning = false;
    }
  }

  /** The toolbar and breadcrumbs stay usable during a delete: a pane that moved stays there. */
  private async reloadAfterDelete(source: FileSource, parent: string): Promise<void> {
    if (source === this.source() && this.path() === parent) {
      await this.load(source, parent, { select: null });
    }
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
      if (options.onFail) {
        options.onFail();
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
      this.error.set(errorText(err));
      return;
    }
    if (this.listing() === null) {
      this.error.set(errorText(err));
    }
    notifyError(this.alerts, err, this.t('files.pane.folderNotOpened'));
  }

  private focusActiveRow(): void {
    this.rowElements()[this.activeIndex()]?.nativeElement.focus();
  }
}
