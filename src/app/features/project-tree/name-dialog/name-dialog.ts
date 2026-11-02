import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
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
import { handleSaveError } from '../save-error';
import { nameValidator } from '../validators';

export interface NameDialogData {
  readonly noun: string;
  readonly initial: string;
  readonly save: (name: string) => Promise<unknown>;
}

@Component({
  imports: [
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
    name: [this.context.data.initial, nameValidator('Name', 100)],
  });

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    const nameControl = this.form.controls.name;
    this.saving.set(true);
    try {
      await this.context.data.save(nameControl.value.trim());
      this.context.completeWith();
    } catch (err) {
      handleSaveError(this.alerts, err, nameControl, this.context.data.noun);
    } finally {
      this.saving.set(false);
    }
  }
}
