import { isFinished, type TransferView } from '../../core/ipc/transfers';
import { formatSize } from '../files/file-list';

export interface TransferRow {
  readonly job: TransferView;
  readonly icon: string;
  readonly directionLabel: string;
  readonly stateText: string;
  /** Null renders an indeterminate bar. */
  readonly progress: { readonly value: number; readonly max: number } | null;
  readonly color: string | null;
  readonly cancellable: boolean;
}

function progressOf(job: TransferView): TransferRow['progress'] {
  if (job.state === 'done') {
    return { value: 1, max: 1 };
  }
  if (job.totalBytes !== null) {
    return job.totalBytes === 0
      ? { value: job.state === 'running' ? 0 : 1, max: 1 }
      : { value: Math.min(job.doneBytes, job.totalBytes), max: job.totalBytes };
  }
  return job.state === 'running' || job.state === 'waitingConflict' ? null : { value: 0, max: 1 };
}

function amount(job: TransferView): string {
  const bytes =
    job.totalBytes === null
      ? formatSize(job.doneBytes)
      : `${formatSize(job.doneBytes)} of ${formatSize(job.totalBytes)}`;
  const files =
    job.totalFiles !== null && job.totalFiles > 1
      ? ` · ${job.doneFiles} of ${job.totalFiles} files`
      : '';
  return bytes + files;
}

function stateText(job: TransferView): string {
  const skipped = job.skipped > 0 ? ` · ${job.skipped} skipped` : '';
  switch (job.state) {
    case 'queued':
      return 'Queued';
    case 'running':
      return amount(job);
    case 'waitingConflict':
      return 'Waiting for a decision';
    case 'done':
      return `Done${skipped}`;
    case 'failed':
      return `Failed: ${job.error?.message ?? 'Unexpected error'}`;
    case 'cancelled':
      return `Cancelled${skipped}`;
  }
}

function colorOf(job: TransferView): string | null {
  switch (job.state) {
    case 'done':
      return 'var(--tui-status-positive)';
    case 'failed':
      return 'var(--tui-status-negative)';
    case 'cancelled':
      return 'var(--tui-status-neutral)';
    default:
      return null;
  }
}

export function transferRow(job: TransferView): TransferRow {
  const upload = job.direction === 'upload';
  return {
    job,
    icon: upload ? '@tui.upload' : '@tui.download',
    directionLabel: upload ? 'Upload' : 'Download',
    stateText: stateText(job),
    progress: progressOf(job),
    color: colorOf(job),
    cancellable: !isFinished(job.state),
  };
}
