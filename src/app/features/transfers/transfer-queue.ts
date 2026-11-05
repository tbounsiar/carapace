import { computed, inject, Service, signal } from '@angular/core';
import { TuiNotificationService } from '@taiga-ui/core';
import type { FileSide } from '../../core/ipc/files';
import { IpcError } from '../../core/ipc/ipc-error';
import {
  isFinished,
  TransferIpc,
  type ConflictPolicy,
  type TransferConflict,
  type TransferDirection,
  type TransferEvent,
  type TransferView,
} from '../../core/ipc/transfers';
import { errorText, notifyError } from '../../shared/save-error';
import { ConflictPrompter } from './conflict-prompter';

/** Failures arriving within this window are reported together. */
export const FAILURE_WINDOW_MS = 300;
/** Above this many failures in one window, a single grouped notification is shown. */
export const MAX_SEPARATE_FAILURES = 3;

/** Local paths are shared by every connection; remote ones belong to theirs. */
export function dirKey(connectionId: string, side: FileSide, dir: string): string {
  return side === 'local' ? `local|${dir}` : `remote|${connectionId}|${dir}`;
}

/** The revisions of one pane's directories, keyed by path. */
export function paneRevisions(
  revisions: ReadonlyMap<string, number>,
  connectionId: string,
  side: FileSide,
): ReadonlyMap<string, number> {
  const prefix = dirKey(connectionId, side, '');
  const result = new Map<string, number>();
  for (const [key, count] of revisions) {
    if (key.startsWith(prefix)) {
      result.set(key.slice(prefix.length), count);
    }
  }
  return result;
}

function targetSide(direction: TransferDirection): FileSide {
  return direction === 'upload' ? 'remote' : 'local';
}

/**
 * A finished job never goes back to an active state: the subscription snapshot and early
 * channel events can arrive in either order.
 */
function newer(previous: TransferView | undefined, next: TransferView): TransferView {
  return previous && isFinished(previous.state) && !isFinished(next.state) ? previous : next;
}

@Service()
export class TransferQueue {
  private readonly ipc = inject(TransferIpc);
  private readonly prompter = inject(ConflictPrompter);
  private readonly alerts = inject(TuiNotificationService);

  private readonly _transfers = signal<readonly TransferView[]>([]);
  private readonly _revisions = signal<ReadonlyMap<string, number>>(new Map());
  private started = false;
  private removedBeforeSnapshot: Set<string> | null = null;
  private prompts: Promise<void> = Promise.resolve();
  private failures: TransferView[] = [];
  private failureTimer: ReturnType<typeof setTimeout> | null = null;

  readonly transfers = this._transfers.asReadonly();
  /** Bumped per target directory each time a job writing into it finishes. */
  readonly revisions = this._revisions.asReadonly();
  readonly hasFinished = computed(() => this._transfers().some((t) => isFinished(t.state)));

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.removedBeforeSnapshot = new Set();
    try {
      const snapshot = await this.ipc.subscribe((event) => this.onEvent(event));
      const removed = this.removedBeforeSnapshot;
      const current = new Map(this._transfers().map((t) => [t.id, t]));
      const merged = snapshot
        .filter((t) => !removed.has(t.id))
        .map((t) => newer(current.get(t.id), t));
      const known = new Set(merged.map((t) => t.id));
      this._transfers.set([...merged, ...this._transfers().filter((t) => !known.has(t.id))]);
    } catch (err) {
      this.started = false;
      notifyError(this.alerts, err, 'Transfers unavailable');
    } finally {
      this.removedBeforeSnapshot = null;
    }
  }

  async enqueue(
    connectionId: string,
    direction: TransferDirection,
    sources: readonly string[],
    targetDir: string,
    conflict: ConflictPolicy = 'ask',
  ): Promise<void> {
    if (sources.length === 0) {
      return;
    }
    try {
      await this.ipc.enqueue({
        connectionId,
        direction,
        sources: [...sources],
        targetDir,
        conflict,
      });
    } catch (err) {
      notifyError(this.alerts, err, 'Transfer not started');
    }
  }

  async cancel(jobId: string): Promise<void> {
    try {
      await this.ipc.cancel(jobId);
    } catch (err) {
      if (!(err instanceof IpcError && err.code === 'not_found')) {
        notifyError(this.alerts, err, 'Transfer not cancelled');
      }
    }
  }

  async clearFinished(): Promise<void> {
    try {
      await this.ipc.clearFinished();
    } catch (err) {
      notifyError(this.alerts, err, 'Finished transfers not cleared');
    }
  }

  forConnection(connectionId: string): TransferView[] {
    return this._transfers().filter((t) => t.connectionId === connectionId);
  }

  private onEvent(event: TransferEvent): void {
    switch (event.kind) {
      case 'updated':
        this.update(event.transfer);
        break;
      case 'removed': {
        const ids = new Set(event.jobIds);
        ids.forEach((id) => this.removedBeforeSnapshot?.add(id));
        this._transfers.update((list) => list.filter((t) => !ids.has(t.id)));
        break;
      }
      case 'conflict':
        this.queuePrompt(event);
        break;
    }
  }

  private update(next: TransferView): void {
    const list = this._transfers();
    const index = list.findIndex((t) => t.id === next.id);
    const previous = index >= 0 ? list[index] : undefined;
    const merged = newer(previous, next);
    if (merged === previous) {
      return;
    }
    this._transfers.set(
      index >= 0 ? list.map((t, i) => (i === index ? merged : t)) : [...list, merged],
    );
    if (isFinished(merged.state) && !(previous && isFinished(previous.state))) {
      this.bump(merged);
      if (merged.state === 'failed') {
        this.reportFailure(merged);
      }
    }
  }

  private bump(job: TransferView): void {
    const key = dirKey(job.connectionId, targetSide(job.direction), job.targetDir);
    this._revisions.update((map) => new Map(map).set(key, (map.get(key) ?? 0) + 1));
  }

  /** One dialog at a time: several jobs can hit a conflict at once. */
  private queuePrompt(conflict: TransferConflict): void {
    this.prompts = this.prompts.then(() => this.prompt(conflict));
  }

  private async prompt(conflict: TransferConflict): Promise<void> {
    const job = this._transfers().find((t) => t.id === conflict.jobId);
    if (job && isFinished(job.state)) {
      return;
    }
    const name = conflict.path.split(/[\\/]/).filter(Boolean).at(-1) ?? conflict.path;
    const answer = await this.prompter.ask(name, conflict);
    try {
      await this.ipc.answerConflict(
        conflict.jobId,
        conflict.conflictId,
        answer.decision,
        answer.applyToAll,
      );
    } catch (err) {
      if (!(err instanceof IpcError && err.code === 'not_found')) {
        notifyError(this.alerts, err, 'Conflict answer not sent');
      }
    }
  }

  private reportFailure(job: TransferView): void {
    this.failures.push(job);
    this.failureTimer ??= setTimeout(() => this.flushFailures(), FAILURE_WINDOW_MS);
  }

  private flushFailures(): void {
    const failed = this.failures;
    this.failures = [];
    this.failureTimer = null;
    if (failed.length <= MAX_SEPARATE_FAILURES) {
      for (const job of failed) {
        this.alerts
          .open(`${job.name}: ${errorText(job.error)}`, {
            label: 'Transfer failed',
            appearance: 'negative',
          })
          .subscribe();
      }
      return;
    }
    const names = failed.slice(0, MAX_SEPARATE_FAILURES).map((j) => j.name);
    const rest = failed.length - names.length;
    const reasons = [...new Set(failed.map((j) => errorText(j.error)))];
    const reason = reasons.length === 1 ? ` ${reasons[0]}` : '';
    this.alerts
      .open(`${names.join(', ')} and ${rest} more.${reason}`, {
        label: `${failed.length} transfers failed`,
        appearance: 'negative',
      })
      .subscribe();
  }
}
