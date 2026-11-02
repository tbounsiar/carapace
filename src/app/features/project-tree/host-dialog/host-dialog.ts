import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
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
import { TuiInputNumber, TuiRadioList } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { AuthMethod, HostInput } from '../../../core/ipc/config.models';
import { handleSaveError } from '../save-error';
import {
  hostnameValidator,
  keyPathValidator,
  nameValidator,
  noWhitespaceValidator,
  portValidator,
} from '../validators';

export interface HostDialogData {
  readonly initial: HostInput | null;
  readonly save: (host: HostInput) => Promise<unknown>;
}

export type AuthKind = AuthMethod['kind'];

@Component({
  imports: [
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiError,
    TuiForm,
    TuiInput,
    TuiInputNumber,
    TuiRadioList,
    TuiTextfield,
  ],
  selector: 'app-host-dialog',
  templateUrl: './host-dialog.html',
})
export class HostDialog {
  private readonly alerts = inject(TuiNotificationService);
  protected readonly context = injectContext<TuiDialogContext<void, HostDialogData>>();

  protected readonly authKinds: readonly AuthKind[] = ['password', 'key', 'agent'];
  protected readonly authLabels: Record<AuthKind, string> = {
    password: 'Password',
    key: 'Private key file',
    agent: 'SSH agent',
  };

  protected readonly saving = signal(false);
  private readonly initial = this.context.data.initial;
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: [this.initial?.name ?? '', nameValidator('Name', 100)],
    hostname: [this.initial?.hostname ?? '', hostnameValidator(253)],
    port: [this.initial?.port ?? 22, portValidator],
    username: [this.initial?.username ?? '', noWhitespaceValidator('Username', 64)],
    authKind: [(this.initial?.auth.kind ?? 'password') as AuthKind],
    keyPath: [this.initial?.auth.kind === 'key' ? this.initial.auth.keyPath : ''],
  });

  private readonly authKind = toSignal(this.form.controls.authKind.valueChanges, {
    initialValue: this.form.controls.authKind.value,
  });
  protected readonly isKey = computed(() => this.authKind() === 'key');

  constructor() {
    effect(() => {
      const keyPath = this.form.controls.keyPath;
      keyPath.setValidators(this.isKey() ? keyPathValidator : []);
      keyPath.updateValueAndValidity();
    });
  }

  protected label(kind: AuthKind): string {
    return this.authLabels[kind];
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      await this.context.data.save(this.toHostInput());
      this.context.completeWith();
    } catch (err) {
      handleSaveError(this.alerts, err, this.form.controls.name, 'host');
    } finally {
      this.saving.set(false);
    }
  }

  private toHostInput(): HostInput {
    const v = this.form.getRawValue();
    const auth: AuthMethod =
      v.authKind === 'key' ? { kind: 'key', keyPath: v.keyPath.trim() } : { kind: v.authKind };
    return {
      name: v.name.trim(),
      hostname: v.hostname,
      port: v.port,
      username: v.username,
      auth,
    };
  }
}
