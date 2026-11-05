import type { AbstractControl } from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import type { TuiNotificationService } from '@taiga-ui/core';
import type { IpcErrorCode } from '../core/ipc/config.models';
import { IpcError } from '../core/ipc/ipc-error';

/** What the user can do next, by error code; the backend message says what happened. */
const NEXT_STEP: Readonly<Record<IpcErrorCode, string>> = {
  not_found: 'It may have been deleted or moved. Refresh and try again.',
  invalid_input: 'Check the values and try again.',
  conflict: 'Choose another name.',
  already_exists: 'Choose another name.',
  io: 'Check that the disk is available and not full, then try again.',
  corrupt_config:
    'Move data.json or settings.toml out of the data folder to start fresh, or restore it from a backup.',
  host_key_rejected: 'Connect again and accept the key if you trust this host.',
  auth_failed: 'Check the username and the key or password of the host.',
  unsupported: 'The server does not support this operation.',
  timeout: 'Check that the host is reachable, then try again.',
  network: 'Check the hostname, the port and your network, then connect again.',
  host_key_changed: 'Confirm the new key with the server administrator before replacing it.',
  host_key_revoked: 'Contact the server administrator.',
  secret_required: 'Enter the password or passphrase when asked, or set its secret variable.',
  invalid_passphrase: 'Type the passphrase again.',
  keychain_unavailable: 'Unlock or enable the system keychain, then try again.',
  not_connected: 'Connect to the host, then try again.',
  busy: 'Wait a moment and try again.',
  permission_denied: 'Check the permissions of the file or folder.',
  not_empty: 'Empty the folder first.',
  too_large: 'Choose a smaller file.',
  missing_variables: 'Define them in the global or project variables.',
  cancelled: 'Start it again when ready.',
  not_text: 'Only UTF-8 text files can be edited here.',
  partial_write: 'The remote file may be damaged: save again to write it whole.',
  large_file: 'Confirm the download to edit it.',
  sensitive: 'Confirm to copy it to this computer.',
  blocked_type: 'Choose an editor app in Settings to edit this type of file.',
  app_not_found: 'Choose the editor app again in Settings.',
  app_not_editor: 'Choose an editor app in Settings.',
  host_changed: 'Stop editing it, then open it again from the current server.',
  app_failed: 'Check the editor app chosen in Settings.',
  not_regular_file: 'Only regular files can be opened in an editor.',
  not_uploaded: 'Upload the changes first, or stop editing and delete them.',
  import_format: 'Choose a file made with Export in Carapace.',
  import_version: 'Update Carapace, then import it again.',
  import_malformed: 'Export it again.',
  import_invalid: 'Fix the file or export it again.',
  import_secret_value: 'Remove the value from the file and set it in Variables instead.',
  unknown: 'Try again. Restart the app if it keeps happening.',
};

const UNEXPECTED = 'Something unexpected went wrong.';

function isCode(code: unknown): code is IpcErrorCode {
  return typeof code === 'string' && Object.hasOwn(NEXT_STEP, code);
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
    return `${UNEXPECTED} ${NEXT_STEP.unknown}`;
  }
  return `${sentence(message)} ${NEXT_STEP[code]}`;
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

export function handleSaveError(
  alerts: TuiNotificationService,
  err: unknown,
  nameControl: AbstractControl,
  noun: string,
  conflictCode: IpcErrorCode = 'conflict',
  conflictMessage = `A ${noun} with this name already exists`,
): void {
  if (err instanceof IpcError && err.code === conflictCode) {
    nameControl.setErrors({ invalid: new TuiValidationError(conflictMessage) });
    nameControl.markAsTouched();
    return;
  }
  notifyError(alerts, err, `${noun.charAt(0).toUpperCase()}${noun.slice(1)} not saved`);
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
  switch (code) {
    case 'import_format':
      return of('This is not a Carapace data file', 'Choose a file made with Export in Carapace.');
    case 'import_version': {
      const version = /version (\d+)/i.exec(message)?.[1];
      return of(
        'This file needs a newer Carapace',
        version
          ? `It was exported in data format ${version}. Update Carapace, then import it again.`
          : 'It was exported in a newer data format. Update Carapace, then import it again.',
      );
    }
    case 'import_malformed': {
      const at = /line (\d+)\D+?column (\d+)/i.exec(message);
      const what = at
        ? `It is not valid JSON (line ${at[1]}, column ${at[2]}).`
        : /utf-?8/i.test(message)
          ? 'It is not UTF-8 text.'
          : 'It is not valid JSON.';
      return of('This file is damaged', `${what} Export it again.`);
    }
    case 'import_invalid': {
      const lines = message
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 5)
        .map(sentence);
      return of('This file has invalid data', ...(lines.length ? lines : ['Export it again.']));
    }
    case 'import_secret_value':
      return of(
        'This file contains a secret value',
        ...(message ? [sentence(message)] : []),
        'Remove it from the file and set it in Variables instead.',
      );
    case 'too_large':
      return of('This file is too large', 'Carapace data files are at most 8 MB.');
    case 'invalid_input':
      return of(
        'The file could not be read',
        `${message ? `${sentence(message)} ` : ''}Choose a file on a drive of this computer.`,
      );
    default:
      return of(
        'The file could not be read',
        errorText(err instanceof IpcError ? new IpcError(err.code, message) : err),
      );
  }
}

/** The apply error of an import preview: nothing was written. */
export function importApplyError(err: unknown): string {
  if (err instanceof IpcError && err.code === 'keychain_unavailable') {
    // A partial failure says how many values were already removed: keep the backend's words.
    return /already removed/i.test(err.message)
      ? `${sentence(err.message)} ${NEXT_STEP.keychain_unavailable}`
      : 'The system keychain is not available. Nothing was imported.';
  }
  return `Nothing was imported. ${errorText(err)}`;
}
