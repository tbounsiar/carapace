import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiTable } from '@taiga-ui/addon-table';
import {
  TuiButton,
  TuiCell,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiLink,
  TuiLoader,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiAvatar, TuiBadge, TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import type { Host } from '../../../core/ipc/config.models';
import { hostTarget } from '../../../core/ipc/connection';
import { EditedFiles } from '../../../core/ipc/edited-files';
import type { EditedFile } from '../../../core/ipc/external-edits';
import { SshService } from '../../../core/ipc/ssh';
import { OptionLabel } from '../../../shared/option-reason/option-label';
import { OptionReason } from '../../../shared/option-reason/option-reason';
import { builtInBlocker, EditedActions } from '../edited-actions';
import {
  failureReason,
  hostLabel,
  hostName,
  rowAction,
  type RowAction,
  stateLook,
  type StateLook,
  uploadBlocker,
} from '../edited-view';

const NO_CHANGES = 'No changes to upload';

interface Row {
  readonly file: EditedFile;
  readonly host: Host | null;
  readonly hostName: string;
  readonly testId: string;
  readonly location: string;
  readonly look: StateLook;
  readonly reason: string | null;
  readonly action: { action: RowAction; label: string } | null;
  /** Upload, Open and the built-in editor are off: the host is gone or reaches another server. */
  readonly blocked: string | null;
  readonly uploadReason: string | null;
  readonly builtInReason: string | null;
  readonly connected: boolean;
}

/** `/edited-files`: every file open in an external editor, across hosts (spec R1). */
@Component({
  imports: [
    RouterLink,
    OptionLabel,
    OptionReason,
    TuiAvatar,
    TuiBadge,
    TuiBlockStatus,
    TuiButton,
    TuiCell,
    TuiDataList,
    TuiDropdown,
    TuiHeader,
    TuiHint,
    TuiLink,
    TuiLoader,
    TuiNotification,
    TuiStatus,
    TuiTable,
    TuiTitle,
  ],
  selector: 'app-edited-files-page',
  styleUrl: './edited-files-page.scss',
  templateUrl: './edited-files-page.html',
  host: { 'data-testid': 'edited-files' },
})
export class EditedFilesPage {
  private readonly store = inject(EditedFiles);
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly injector = inject(Injector);
  protected readonly actions = inject(EditedActions);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly emptyHeading = viewChild<ElementRef<HTMLElement>>('emptyHeading');
  private readonly rowElements = viewChildren<ElementRef<HTMLElement>>('row');

  protected readonly loaded = this.store.loaded;
  protected readonly openMenu = signal<string | null>(null);

  protected readonly rows = computed<Row[]>(() =>
    this.store.files().map((file) => {
      const host = this.config.findHost(file.hostId)?.host ?? null;
      const name = hostName(this.config, file.hostId);
      const connected = !!host && this.ssh.stateOf(hostTarget(host).connectionId) === 'connected';
      const blocked = uploadBlocker(file, host?.name ?? null);
      return {
        file,
        host,
        hostName: name,
        testId: `edited-row-${host?.name ?? 'deleted'}-${file.name}`,
        location: `${hostLabel(this.config, file.hostId) ?? 'Deleted host'}:${file.remotePath}`,
        look: stateLook(file),
        reason: file.state === 'failed' ? failureReason(file, host?.name ?? null) : null,
        action: blocked ? null : rowAction(file),
        blocked,
        uploadReason:
          blocked ?? (file.state === 'synced' || file.state === 'opening' ? NO_CHANGES : null),
        builtInReason: blocked ?? builtInBlocker(file),
        connected,
      };
    }),
  );

  /** The actions column is wide only when a row shows a button next to its "…". */
  protected readonly hasRowAction = computed(() => this.rows().some((r) => r.action));

  constructor() {
    effect(() => {
      const request = this.store.focusRequest();
      const rows = this.rows();
      if (!request) {
        return;
      }
      const index = rows.findIndex((r) => r.file.id === request.id);
      if (index >= 0) {
        untracked(() => {
          this.store.focusRequest.set(null);
          afterNextRender(() => this.focusRow(index, 'action'), { injector: this.injector });
        });
      }
    });
  }

  protected setMenu(row: Row, open: boolean): void {
    this.openMenu.set(open ? row.file.id : null);
  }

  protected runAction(row: Row): void {
    switch (row.action?.action) {
      case 'resolve':
        void this.actions.resolve(row.file);
        return;
      case 'retry':
      case 'upload':
        void this.actions.upload(row.file);
        return;
      case 'reconnect':
        void this.actions.reconnect(row.file);
    }
  }

  protected async stop(row: Row): Promise<void> {
    const index = this.rows().indexOf(row);
    const done =
      row.file.state === 'recovered'
        ? await this.actions.discard(row.file)
        : await this.actions.stop(row.file);
    if (done) {
      afterNextRender(() => this.focusAfterRemoval(index), { injector: this.injector });
    }
  }

  /** Delete stops editing; Shift+F10 / ContextMenu open the row menu (spec R1, keyboard). */
  protected onRowKeydown(event: KeyboardEvent, row: Row): void {
    if (!(event.target instanceof HTMLButtonElement)) {
      return;
    }
    if (event.key === 'Delete' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      void this.stop(row);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      this.openMenu.set(row.file.id);
    }
  }

  private focusAfterRemoval(index: number): void {
    const count = this.rowElements().length;
    if (count) {
      this.focusRow(Math.min(index, count - 1), 'link');
    } else {
      (this.emptyHeading() ?? this.heading())?.nativeElement.focus();
    }
  }

  private focusRow(index: number, target: 'action' | 'link'): void {
    const row = this.rowElements()[index]?.nativeElement;
    const action =
      target === 'action' ? row?.querySelector<HTMLElement>('[data-row-action]') : null;
    (action ?? row?.querySelector<HTMLElement>('[data-testid="edited-open"]'))?.focus();
  }
}
