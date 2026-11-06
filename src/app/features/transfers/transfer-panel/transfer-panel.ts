import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TuiButton, TuiDataList, TuiDropdown, TuiExpand, TuiHint, TuiIcon } from '@taiga-ui/core';
import { TuiBadge, TuiProgress } from '@taiga-ui/kit';
import { LanguageService } from '../../../core/i18n/language';
import type { FileSide } from '../../../core/ipc/files';
import { isFinished, type TransferView } from '../../../core/ipc/transfers';
import { isMenuKey, openContextMenuAt } from '../../../shared/context-menu/context-menu';
import { ContextMenuTarget } from '../../../shared/context-menu/context-menu-target';
import { OptionLabel } from '../../../shared/option-reason/option-label';
import { OptionReason } from '../../../shared/option-reason/option-reason';
import { childPath } from '../../files/file-path';
import { TransferQueue } from '../transfer-queue';
import { transferRow, type TransferRow } from '../transfer-view';

/** The pane to show for a job, the folder it writes into and the item in it, when known. */
export interface TransferReveal {
  readonly side: FileSide;
  readonly dir: string;
  readonly path: string | null;
}

export interface TransferMenuEntry {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  readonly reason: string | null;
  /** Preceded by an `<hr />`. */
  readonly separated?: boolean;
  readonly run: () => void;
}

@Component({
  imports: [
    ContextMenuTarget,
    OptionLabel,
    OptionReason,
    TranslocoPipe,
    TuiBadge,
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiExpand,
    TuiHint,
    TuiIcon,
    TuiProgress,
  ],
  selector: 'app-transfer-panel',
  styleUrl: './transfer-panel.scss',
  templateUrl: './transfer-panel.html',
  host: { 'data-testid': 'transfer-panel' },
})
export class TransferPanel {
  private readonly queue = inject(TransferQueue);
  private readonly language = inject(LanguageService);
  private readonly transloco = inject(TranslocoService);
  /** Read by `rows` so its texts follow a language switch once its translations are loaded. */
  private readonly translation = toSignal(this.transloco.selectTranslation());

  readonly connectionId = input.required<string>();
  /** Retry and the remote pane need the connection. */
  readonly connected = input(true);
  /** "Show in pane": the files panel lists that folder in that pane. */
  readonly reveal = output<TransferReveal>();

  private readonly jobs = computed(() => this.queue.forConnection(this.connectionId()));
  protected readonly rows = computed<TransferRow[]>(() => {
    this.translation();
    const locale = this.language.locale();
    // Newest first: the list is height-bounded and the row just acted on must stay visible.
    return this.jobs()
      .map((job) => transferRow(job, locale))
      .reverse();
  });
  protected readonly running = computed(
    () => this.jobs().filter((j) => j.state === 'running').length,
  );
  protected readonly waiting = computed(
    () => this.jobs().filter((j) => j.state === 'waitingConflict').length,
  );
  protected readonly queued = computed(
    () => this.jobs().filter((j) => j.state === 'queued').length,
  );
  protected readonly done = computed(() => this.jobs().filter((j) => j.state === 'done').length);
  protected readonly failed = computed(
    () => this.jobs().filter((j) => j.state === 'failed').length,
  );
  protected readonly canClear = computed(() => this.jobs().some((j) => isFinished(j.state)));
  protected readonly expanded = signal(false);
  /** The job whose context menu opened last; its entries follow the job's live state. */
  protected readonly menuJobId = signal<string | null>(null);
  private readonly menuJob = computed(() => {
    const id = this.menuJobId();
    return this.jobs().find((j) => j.id === id) ?? null;
  });
  protected readonly menuEntries = computed<TransferMenuEntry[]>(() => {
    this.translation();
    const job = this.menuJob();
    return job ? this.entriesOf(job) : [];
  });
  protected readonly menuLabel = computed(() => {
    this.translation();
    const job = this.menuJob();
    return job ? this.t('transfers.menu.label', { name: job.name }) : '';
  });

  private seen: ReadonlySet<string> | null = null;

  constructor() {
    effect(() => {
      const jobs = this.jobs();
      const seen = this.seen;
      this.seen = new Set(jobs.map((j) => j.id));
      const opened =
        seen === null ? jobs.some((j) => !isFinished(j.state)) : jobs.some((j) => !seen.has(j.id));
      if (opened) {
        untracked(() => this.expanded.set(true));
      }
    });
  }

  protected toggle(): void {
    this.expanded.update((v) => !v);
  }

  protected cancel(row: TransferRow): void {
    void this.queue.cancel(row.job.id);
  }

  protected clear(): void {
    void this.queue.clearFinished();
  }

  protected onContextTarget(row: HTMLElement | null): void {
    this.menuJobId.set(row?.dataset['menuRow'] ?? null);
  }

  /** Shift+F10 / ContextMenu on a row's Cancel button opens the row's menu. */
  protected onCancelKeydown(event: KeyboardEvent): void {
    if (isMenuKey(event)) {
      event.preventDefault();
      openContextMenuAt(event.currentTarget as HTMLElement);
    }
  }

  private entriesOf(job: TransferView): TransferMenuEntry[] {
    const upload = job.direction === 'upload';
    const offline = this.connected() ? null : this.t('transfers.menu.notConnected');
    const entries: TransferMenuEntry[] = [];
    if (!isFinished(job.state)) {
      entries.push({
        id: 'transfer-menu-cancel',
        icon: '@tui.x',
        label: this.t('common.cancel'),
        reason: null,
        run: () => void this.queue.cancel(job.id),
      });
    } else if (job.state !== 'done') {
      entries.push({
        id: 'transfer-menu-retry',
        icon: '@tui.rotate-ccw',
        label: this.t('transfers.menu.retry'),
        reason: offline,
        run: () =>
          void this.queue.enqueue(
            job.connectionId,
            job.direction,
            [job.source],
            job.targetDir,
            'ask',
          ),
      });
    }
    entries.push({
      id: 'transfer-menu-reveal',
      icon: '@tui.folder-open',
      label: this.t(upload ? 'transfers.menu.showRemote' : 'transfers.menu.showLocal'),
      reason: upload ? offline : null,
      run: () => {
        const side = upload ? 'remote' : 'local';
        const name = this.queue.writtenName(job);
        this.reveal.emit({
          side,
          dir: job.targetDir,
          path: name === null ? null : childPath(job.targetDir, name, side),
        });
      },
    });
    if (this.canClear()) {
      entries.push({
        id: 'transfer-menu-clear',
        icon: '@tui.list-x',
        label: this.t('transfers.panel.clear'),
        reason: null,
        separated: true,
        run: () => this.clear(),
      });
    }
    return entries;
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
