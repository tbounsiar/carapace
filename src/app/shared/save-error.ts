import type { AbstractControl } from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import type { TuiNotificationService } from '@taiga-ui/core';
import type { IpcErrorCode } from '../core/ipc/config.models';
import { IpcError } from '../core/ipc/ipc-error';
import { uiText } from './ui-text';

/** Error codes with a "what to do next" text (`common.error.next.<code>`). */
const NEXT_STEPS: Readonly<Record<IpcErrorCode, true>> = {
  not_found: true,
  invalid_input: true,
  conflict: true,
  already_exists: true,
  io: true,
  corrupt_config: true,
  host_key_rejected: true,
  auth_failed: true,
  unsupported: true,
  timeout: true,
  network: true,
  host_key_changed: true,
  host_key_revoked: true,
  secret_required: true,
  invalid_passphrase: true,
  keychain_unavailable: true,
  not_connected: true,
  busy: true,
  permission_denied: true,
  not_empty: true,
  too_large: true,
  missing_variables: true,
  cancelled: true,
  not_text: true,
  partial_write: true,
  large_file: true,
  sensitive: true,
  blocked_type: true,
  app_not_found: true,
  app_not_editor: true,
  host_changed: true,
  app_failed: true,
  not_regular_file: true,
  not_uploaded: true,
  import_format: true,
  import_version: true,
  import_malformed: true,
  import_invalid: true,
  import_secret_value: true,
  unknown: true,
};

/** What the user can do next, by error code; the backend message says what happened. */
function nextStep(code: IpcErrorCode): string {
  return uiText(`common.error.next.${code}`);
}

function isCode(code: unknown): code is IpcErrorCode {
  return typeof code === 'string' && Object.hasOwn(NEXT_STEPS, code);
}

/**
 * "What happened. What to do." for a notification. Takes an `IpcError` or a `{code, message}`
 * from an event payload; backend messages are lower-case fragments.
 */
export function errorText(err: unknown): string {
  const { code, message } =
    typeof err === 'object' && err !== null
      ? (err as { code?: unknown; message?: unknown })
      : { code: undefined, message: undefined };
  if (!isCode(code) || code === 'unknown' || typeof message !== 'string' || !message.trim()) {
    return `${uiText('common.error.unexpected')} ${nextStep('unknown')}`;
  }
  return `${sentence(message)} ${nextStep(code)}`;
}

/** A backend message (a lower-case fragment) as a sentence. */
export function sentence(message: string): string {
  const raw = message.trim();
  const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** `label` names what failed ("Connection failed", "Folder not deleted"). */
export function notifyError(alerts: TuiNotificationService, err: unknown, label: string): void {
  alerts.open(errorText(err), { label, appearance: 'negative' }).subscribe();
}

/**
 * `noun` is `host`, `project` or `collection`: it picks the field error and the toast title.
 * `conflictMessage` replaces the field error.
 */
export function handleSaveError(
  alerts: TuiNotificationService,
  err: unknown,
  nameControl: AbstractControl,
  noun: string,
  conflictCode: IpcErrorCode = 'conflict',
  conflictMessage?: string,
): void {
  if (err instanceof IpcError && err.code === conflictCode) {
    const message = conflictMessage ?? uiText('common.error.nameTaken', { noun });
    nameControl.setErrors({ invalid: new TuiValidationError(message) });
    nameControl.markAsTouched();
    return;
  }
  notifyError(alerts, err, uiText('common.error.notSaved', { noun }));
}

const FILE_PREFIX = /^file “([^”]*)”:\s*/;

export interface ImportFileError {
  /** Base name of the picked file, when the backend named it. */
  readonly fileName: string | null;
  readonly title: string;
  /** One sentence per line. */
  readonly lines: readonly string[];
}

/** Title and body of an unreadable import file (spec S5), by error code. */
export function importFileError(err: unknown): ImportFileError {
  const code = err instanceof IpcError ? err.code : 'unknown';
  const raw = err instanceof IpcError ? err.message : '';
  const fileName = FILE_PREFIX.exec(raw)?.[1] ?? null;
  const message = raw.replace(FILE_PREFIX, '').trim();
  const of = (title: string, ...lines: string[]): ImportFileError => ({ fileName, title, lines });
  const t = (key: string, params?: Record<string, unknown>) =>
    uiText(`common.error.import.${key}`, params);
  switch (code) {
    case 'import_format':
      return of(t('formatTitle'), nextStep('import_format'));
    case 'import_version': {
      const version = /version (\d+)/i.exec(message)?.[1];
      return of(t('versionTitle'), version ? t('versionKnown', { version }) : t('versionNewer'));
    }
    case 'import_malformed': {
      const at = /line (\d+)\D+?column (\d+)/i.exec(message);
      const what = at
        ? t('jsonAt', { line: at[1], column: at[2] })
        : /utf-?8/i.test(message)
          ? t('notUtf8')
          : t('notJson');
      return of(t('malformedTitle'), `${what} ${nextStep('import_malformed')}`);
    }
    case 'import_invalid': {
      const lines = message
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 5)
        .map(sentence);
      return of(t('invalidTitle'), ...(lines.length ? lines : [nextStep('import_malformed')]));
    }
    case 'import_secret_value':
      return of(t('secretTitle'), ...(message ? [sentence(message)] : []), t('secretNext'));
    case 'too_large':
      return of(t('tooLargeTitle'), t('tooLargeDetail'));
    case 'invalid_input':
      return of(
        t('unreadableTitle'),
        `${message ? `${sentence(message)} ` : ''}${t('localDrive')}`,
      );
    default:
      return of(
        t('unreadableTitle'),
        errorText(err instanceof IpcError ? new IpcError(err.code, message) : err),
      );
  }
}

/** The apply error of an import preview: nothing was written. */
export function importApplyError(err: unknown): string {
  if (err instanceof IpcError && err.code === 'keychain_unavailable') {
    // A partial failure says how many values were already removed: keep the backend's words.
    return /already removed/i.test(err.message)
      ? `${sentence(err.message)} ${nextStep('keychain_unavailable')}`
      : uiText('common.error.import.keychainUnavailable');
  }
  return uiText('common.error.import.nothingImported', { reason: errorText(err) });
}
