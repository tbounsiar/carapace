import type { AbstractControl } from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import type { TuiNotificationService } from '@taiga-ui/core';
import type { IpcErrorCode } from '../../core/ipc/config.models';
import { IpcError } from '../../core/ipc/ipc-error';

/** What the user can do next, by error code; the backend message says what happened. */
const NEXT_STEP: Readonly<Record<IpcErrorCode, string>> = {
  not_found: 'It may have been deleted or moved. Refresh and try again.',
  invalid_input: 'Check the values and try again.',
  conflict: 'Choose another name.',
  already_exists: 'Choose another name.',
  io: 'Check that the disk is available and not full, then try again.',
  corrupt_config:
    'Move config.json out of the app folder to start fresh, or restore it from a backup.',
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
  missing_variables: 'Define them in the global, project or environment variables.',
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
  const raw = message.trim();
  const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1);
  const sentence = /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
  return `${sentence} ${NEXT_STEP[code]}`;
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
): void {
  if (err instanceof IpcError && err.code === conflictCode) {
    nameControl.setErrors({
      invalid: new TuiValidationError(`A ${noun} with this name already exists`),
    });
    nameControl.markAsTouched();
    return;
  }
  notifyError(alerts, err, `${noun.charAt(0).toUpperCase()}${noun.slice(1)} not saved`);
}
