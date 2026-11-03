import { Component, inject } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiCheckbox,
  TuiError,
  TuiIcon,
  TuiInput,
  TuiNotification,
  TuiTextfield,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiPassword } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { SecretKind } from '../../core/ipc/secrets';
import type { Credential } from '../../core/ipc/ssh.models';
import { secretValidator } from '../project-tree/validators';
import { ErrorLink } from '../../shared/error-link';

export interface CredentialDialogData {
  readonly kind: SecretKind;
  /** What the secret unlocks: `user@host:port` or the key path. */
  readonly subject: string;
  readonly error: string | null;
}

@Component({
  imports: [
    ErrorLink,
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiCheckbox,
    TuiError,
    TuiForm,
    TuiIcon,
    TuiInput,
    TuiNotification,
    TuiPassword,
    TuiTextfield,
  ],
  selector: 'app-credential-dialog',
  styleUrl: './credential-dialog.scss',
  templateUrl: './credential-dialog.html',
})
export class CredentialDialog {
  protected readonly context = injectContext<TuiDialogContext<Credential, CredentialDialogData>>();
  protected readonly data = this.context.data;
  protected readonly label = this.data.kind === 'password' ? 'Password' : 'Passphrase';
  protected readonly form = inject(NonNullableFormBuilder).group({
    secret: ['', secretValidator(this.label, true)],
    remember: [false],
  });

  protected submit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      return;
    }
    const credential: Credential = this.form.getRawValue();
    // The value must not outlive the submit in this component.
    this.form.reset();
    this.context.completeWith(credential);
  }
}
