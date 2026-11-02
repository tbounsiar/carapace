import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiError,
  TuiIcon,
  TuiInput,
  TuiNotificationService,
  TuiTextfield,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiButtonLoading, TuiInputNumber, TuiPassword, TuiRadioList } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { AuthMethod, Host, HostInput } from '../../../core/ipc/config.models';
import { type SecretKind, SecretsService } from '../../../core/ipc/secrets';
import { AUTH_LABELS } from '../../../shared/auth-method';
import { handleSaveError, notifyError } from '../save-error';
import {
  hostnameValidator,
  keyPathValidator,
  nameValidator,
  noWhitespaceValidator,
  portValidator,
  secretValidator,
} from '../validators';

export interface HostDialogData {
  readonly initial: HostInput | null;
  /** Set when editing, to look up and forget the stored secret. */
  readonly hostId: string | null;
  readonly save: (host: HostInput) => Promise<Host>;
}

export type AuthKind = AuthMethod['kind'];

function secretKindOf(auth: AuthKind): SecretKind | null {
  return auth === 'password' ? 'password' : auth === 'key' ? 'passphrase' : null;
}

@Component({
  imports: [
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiButtonLoading,
    TuiError,
    TuiForm,
    TuiIcon,
    TuiInput,
    TuiInputNumber,
    TuiPassword,
    TuiRadioList,
    TuiTextfield,
  ],
  selector: 'app-host-dialog',
  styleUrl: './host-dialog.scss',
  templateUrl: './host-dialog.html',
})
export class HostDialog {
  private readonly alerts = inject(TuiNotificationService);
  private readonly secrets = inject(SecretsService);
  protected readonly context = injectContext<TuiDialogContext<void, HostDialogData>>();

  protected readonly authKinds: readonly AuthKind[] = ['password', 'key', 'agent'];

  protected readonly saving = signal(false);
  protected readonly forgetting = signal(false);
  private readonly initial = this.context.data.initial;
  private readonly hostId = this.context.data.hostId;
  private readonly initialSecretKind = this.initial ? secretKindOf(this.initial.auth.kind) : null;
  private readonly initialKeyPath =
    this.initial?.auth.kind === 'key' ? this.initial.auth.keyPath : '';
  private readonly hasStored = signal(false);
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: [this.initial?.name ?? '', nameValidator('Name', 100)],
    hostname: [this.initial?.hostname ?? '', hostnameValidator(253)],
    port: [this.initial?.port ?? 22, portValidator],
    username: [this.initial?.username ?? '', noWhitespaceValidator('Username', 64)],
    authKind: [(this.initial?.auth.kind ?? 'password') as AuthKind],
    keyPath: [this.initialKeyPath],
    secret: [''],
  });

  private readonly authKind = toSignal(this.form.controls.authKind.valueChanges, {
    initialValue: this.form.controls.authKind.value,
  });
  private readonly keyPath = toSignal(this.form.controls.keyPath.valueChanges, {
    initialValue: this.form.controls.keyPath.value,
  });
  protected readonly isKey = computed(() => this.authKind() === 'key');
  protected readonly secretKind = computed(() => secretKindOf(this.authKind()));
  protected readonly secretLabel = computed(() =>
    this.secretKind() === 'password' ? 'Password' : 'Passphrase',
  );
  private readonly target = toSignal(this.form.valueChanges, { initialValue: this.form.value });
  /**
   * The backend drops a stored password when the server (hostname, port, username) changes, and a
   * stored passphrase when the auth kind or the key path changes.
   */
  protected readonly stored = computed(() => {
    const { hostname, port, username } = this.target();
    const sameServer =
      hostname?.trim() === this.initial?.hostname &&
      Number(port) === this.initial?.port &&
      username?.trim() === this.initial?.username;
    return (
      this.hasStored() &&
      this.secretKind() === this.initialSecretKind &&
      (this.isKey() ? this.keyPath().trim() === this.initialKeyPath : sameServer)
    );
  });

  constructor() {
    effect(() => {
      const keyPath = this.form.controls.keyPath;
      keyPath.setValidators(this.isKey() ? keyPathValidator : []);
      keyPath.updateValueAndValidity();
    });
    effect(() => {
      // A value typed for one kind must never be saved as the other.
      const secret = this.form.controls.secret;
      secret.setValidators(secretValidator(this.secretLabel(), false));
      secret.reset();
    });
    if (this.hostId && this.initialSecretKind) {
      this.secrets
        .has(this.hostId, this.initialSecretKind)
        .then((has) => this.hasStored.set(has))
        .catch(() => this.hasStored.set(false));
    }
  }

  protected label(kind: AuthKind): string {
    return AUTH_LABELS[kind];
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    this.saving.set(true);
    let host: Host;
    try {
      host = await this.context.data.save(this.toHostInput());
    } catch (err) {
      handleSaveError(this.alerts, err, this.form.controls.name, 'host');
      this.saving.set(false);
      return;
    }
    const kind = this.secretKind();
    const secret = this.form.controls.secret.value;
    this.form.controls.secret.reset();
    if (kind && secret) {
      try {
        await this.secrets.set(host.id, kind, secret);
      } catch (err) {
        notifyError(this.alerts, err);
      }
    }
    this.saving.set(false);
    this.context.completeWith();
  }

  protected async forget(): Promise<void> {
    if (!this.hostId || !this.initialSecretKind || this.forgetting()) {
      return;
    }
    this.forgetting.set(true);
    try {
      await this.secrets.delete(this.hostId, this.initialSecretKind);
      this.hasStored.set(false);
    } catch (err) {
      notifyError(this.alerts, err);
    } finally {
      this.forgetting.set(false);
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
