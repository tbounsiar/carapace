import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { TuiButton, TuiExpand, TuiHint, TuiIcon } from '@taiga-ui/core';
import { TuiBadge, TuiProgress } from '@taiga-ui/kit';
import { isFinished } from '../../../core/ipc/transfers';
import { TransferQueue } from '../transfer-queue';
import { transferRow, type TransferRow } from '../transfer-view';

@Component({
  imports: [TuiBadge, TuiButton, TuiExpand, TuiHint, TuiIcon, TuiProgress],
  selector: 'app-transfer-panel',
  styleUrl: './transfer-panel.scss',
  templateUrl: './transfer-panel.html',
  host: { 'data-testid': 'transfer-panel' },
})
export class TransferPanel {
  private readonly queue = inject(TransferQueue);

  readonly connectionId = input.required<string>();

  private readonly jobs = computed(() => this.queue.forConnection(this.connectionId()));
  protected readonly rows = computed<TransferRow[]>(() =>
    // Newest first: the list is height-bounded and the row just acted on must stay visible.
    this.jobs().map(transferRow).reverse(),
  );
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
}
