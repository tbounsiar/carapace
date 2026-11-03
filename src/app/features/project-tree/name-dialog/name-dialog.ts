import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, type ValidatorFn } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiError,
  TuiInput,
  TuiNotificationService,
  TuiTextfield,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiButtonLoading } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { IpcErrorCode } from '../../../core/ipc/config.models';
import { handleSaveError } from '../save-error';
import { nameValidator } from '../validators';
import { ErrorLink } from '../../../shared/error-link';

export interface NameDialogData {
  readonly noun: string;
  readonly initial: string;
  readonly save: (name: string) => Promise<unknown>;
  /** Defaults to a required name of at most 100 characters. */
  readonly validator?: ValidatorFn;
  /** The error code meaning the name is taken; defaults to `conflict`. */
  readonly conflictCode?: IpcErrorCode;
  /** Defaults to true; file names keep surrounding spaces. */
  readonly trim?: boolean;
}

@Component({
  imports: [
    ErrorLink,
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiButtonLoading,
    TuiError,
    TuiForm,
    TuiInput,
    TuiTextfield,
  ],
  selector: 'app-name-dialog',
  templateUrl: './name-dialog.html',
})
export class NameDialog {
  private readonly alerts = inject(TuiNotificationService);
  protected readonly context = injectContext<TuiDialogContext<void, NameDialogData>>();

  protected readonly saving = signal(false);
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: [this.context.data.initial, this.context.data.validator ?? nameValidator('Name', 100)],
  });

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    const { save, trim, noun, conflictCode } = this.context.data;
    const nameControl = this.form.controls.name;
    this.saving.set(true);
    try {
      await save(trim === false ? nameControl.value : nameControl.value.trim());
      this.context.completeWith();
    } catch (err) {
      handleSaveError(this.alerts, err, nameControl, noun, conflictCode);
    } finally {
      this.saving.set(false);
    }
  }
}
