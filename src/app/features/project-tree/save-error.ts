import type { AbstractControl } from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import type { TuiNotificationService } from '@taiga-ui/core';
import type { IpcErrorCode } from '../../core/ipc/config.models';
import { IpcError } from '../../core/ipc/ipc-error';

export function notifyError(alerts: TuiNotificationService, err: unknown): void {
  const message = err instanceof IpcError ? err.message : 'Unexpected error';
  alerts.open(message, { label: 'Operation failed', appearance: 'negative' }).subscribe();
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
  notifyError(alerts, err);
}
