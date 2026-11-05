import { translate } from '@jsverse/transloco';
import { isFinished, type TransferView } from '../../core/ipc/transfers';
import { textOf } from '../../shared/backend-text';
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

const t = (key: string, params?: Record<string, unknown>): string =>
  translate(`transfers.view.${key}`, params);

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

function amount(job: TransferView, locale: string): string {
  const done = formatSize(job.doneBytes, locale);
  const bytes =
    job.totalBytes === null
      ? done
      : t('bytesOf', { done, total: formatSize(job.totalBytes, locale) });
  return job.totalFiles !== null && job.totalFiles > 1
    ? `${bytes} · ${t('filesOf', { done: job.doneFiles, total: job.totalFiles })}`
    : bytes;
}

function stateText(job: TransferView, locale: string): string {
  switch (job.state) {
    case 'queued':
      return t('queued');
    case 'running':
      return amount(job, locale);
    case 'waitingConflict':
      return t('waiting');
    case 'done':
      return t('done', { skipped: job.skipped });
    case 'failed':
      return t('failed', { message: job.error ? textOf(job.error) : t('unexpected') });
    case 'cancelled':
      return t('cancelled', { skipped: job.skipped });
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

export function transferRow(job: TransferView, locale = 'en-US'): TransferRow {
  const upload = job.direction === 'upload';
  return {
    job,
    icon: upload ? '@tui.upload' : '@tui.download',
    directionLabel: t(upload ? 'upload' : 'download'),
    stateText: stateText(job, locale),
    progress: progressOf(job),
    color: colorOf(job),
    cancellable: !isFinished(job.state),
  };
}
