import { IpcError } from '../../core/ipc/ipc-error';
import type { UpdateProgress } from '../../core/ipc/updates';
import { textOf } from '../../shared/backend-text';
import { errorText, sentence } from '../../shared/save-error';
import { uiText } from '../../shared/ui-text';
import { formatSize } from '../files/file-list';
import type { RestartImpact } from './update-flow';
import type { UpdateFailure, UpdateFailureKind } from './update-store';

const TITLES: Readonly<Record<UpdateFailureKind, string>> = {
  check: 'updates.error.checkTitle',
  download: 'updates.error.downloadTitle',
  signature: 'updates.error.signatureTitle',
  install: 'updates.error.installTitle',
};

/** The shared next steps speak of SSH hosts and servers; these read right for an update. */
function nextStep(err: IpcError): string | null {
  if (err.key === 'errors.updates.browserFailed') {
    return uiText('updates.error.next.browser');
  }
  switch (err.code) {
    case 'network':
    case 'unsupported':
    case 'not_found':
      return uiText(`updates.error.next.${err.code}`);
    default:
      return null;
  }
}

/** "What happened. What to do." for an update error. */
export function updateErrorText(err: unknown): string {
  const next = err instanceof IpcError ? nextStep(err) : null;
  const message = err instanceof IpcError ? textOf(err).trim() : '';
  return next && message ? `${sentence(message)} ${next}` : errorText(err);
}

export interface FailureView {
  readonly title: string;
  readonly text: string;
}

export function failureView(failure: UpdateFailure): FailureView {
  const title = uiText(TITLES[failure.kind]);
  switch (failure.kind) {
    case 'signature':
      return { title, text: uiText('updates.error.signature') };
    case 'install':
      return restartRequired(failure)
        ? { title, text: updateErrorText(failure.error) }
        : {
            title,
            text: `${updateErrorText(failure.error)} ${uiText('updates.error.keepsWorking')}`,
          };
    default:
      return { title, text: updateErrorText(failure.error) };
  }
}

/** Windows: the installer did not start after external edits and analytics were shut down. */
export function restartRequired(failure: UpdateFailure): boolean {
  return failure.error instanceof IpcError && failure.error.code === 'restart_required';
}

export interface ImpactLine {
  readonly kind: 'connections' | 'transfers' | 'dialog';
  readonly text: string;
}

/** "7.2 of 18.4 MB", or "7.2 MB downloaded" without a total. */
export function progressText(progress: UpdateProgress | null, locale: string): string {
  const done = formatSize(progress?.downloaded ?? 0, locale);
  return progress?.total
    ? uiText('updates.notice.progress', { done, total: formatSize(progress.total, locale) })
    : uiText('updates.notice.progressUnknown', { done });
}

/** Only the lines that apply, in the order connections, transfers, dialog. */
export function impactLines(impact: RestartImpact): ImpactLine[] {
  const lines: ImpactLine[] = [];
  if (impact.connections) {
    lines.push({
      kind: 'connections',
      text: uiText('updates.notice.impactConnections', { count: impact.connections }),
    });
  }
  if (impact.transfers) {
    lines.push({
      kind: 'transfers',
      text: uiText('updates.notice.impactTransfers', { count: impact.transfers }),
    });
  }
  if (impact.dialog) {
    lines.push({ kind: 'dialog', text: uiText('updates.notice.impactDialog') });
  }
  return lines;
}
