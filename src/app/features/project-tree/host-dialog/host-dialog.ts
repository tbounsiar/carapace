import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiDataList,
  TuiError,
  TuiIcon,
  TuiInput,
  TuiNotificationService,
  TuiTextfield,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiButtonLoading, TuiChevron, TuiRadioList, TuiSelect, TuiTooltip } from '@taiga-ui/kit';
import { type TuiStringHandler } from '@taiga-ui/cdk';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../../core/ipc/config';
import type { AuthMethod, Host, HostInput } from '../../../core/ipc/config.models';
import { AUTH_LABELS } from '../../../shared/auth-method';
import { previewHost, secretVariableNames, variableLayers } from '../../../shared/template';
import { handleSaveError } from '../save-error';
import {
  hostnameValidator,
  keyPathValidator,
  nameValidator,
  noWhitespaceValidator,
  portTemplateValidator,
  secretReferenceValidator,
  templated,
} from '../validators';

export interface HostDialogData {
  readonly projectId: string;
  readonly initial: HostInput | null;
  readonly save: (host: HostInput) => Promise<Host>;
}

export type AuthKind = AuthMethod['kind'];

function reference(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

@Component({
  imports: [
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiButtonLoading,
    TuiChevron,
    TuiDataList,
    TuiError,
    TuiForm,
    TuiIcon,
    TuiInput,
    TuiRadioList,
    TuiSelect,
    TuiTextfield,
    TuiTooltip,
  ],
  selector: 'app-host-dialog',
  styleUrl: './host-dialog.scss',
  templateUrl: './host-dialog.html',
})
export class HostDialog {
  private readonly alerts = inject(TuiNotificationService);
  private readonly config = inject(ConfigService);
  protected readonly context = injectContext<TuiDialogContext<void, HostDialogData>>();

  protected readonly authKinds: readonly AuthKind[] = ['password', 'key', 'agent'];
  protected readonly example = '${host}';

  protected readonly saving = signal(false);
  private readonly initial = this.context.data.initial;
  private readonly initialAuth = this.initial?.auth;
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly form = this.fb.group({
    name: [this.initial?.name ?? '', nameValidator('Name', 100)],
    hostname: [this.initial?.hostname ?? '', templated('Hostname', hostnameValidator(253))],
    port: [this.initial?.port ?? '22', portTemplateValidator],
    username: [
      this.initial?.username ?? '',
      templated('Username', noWhitespaceValidator('Username', 64)),
    ],
    authKind: [(this.initialAuth?.kind ?? 'password') as AuthKind],
    keyPath: [this.initialAuth?.kind === 'key' ? this.initialAuth.keyPath : ''],
    password: this.fb.control<string | null>(
      this.initialAuth?.kind === 'password' ? this.initialAuth.password : null,
      secretReferenceValidator('Password'),
    ),
    passphrase: this.fb.control<string | null>(
      this.initialAuth?.kind === 'key' ? this.initialAuth.passphrase : null,
      secretReferenceValidator('Passphrase'),
    ),
  });

  private readonly authKind = toSignal(this.form.controls.authKind.valueChanges, {
    initialValue: this.form.controls.authKind.value,
  });
  private readonly value = toSignal(this.form.valueChanges, { initialValue: this.form.value });
  protected readonly isKey = computed(() => this.authKind() === 'key');
  protected readonly isPassword = computed(() => this.authKind() === 'password');

  private readonly project = computed(
    () => this.config.projects().find((p) => p.id === this.context.data.projectId) ?? null,
  );
  protected readonly askLabel: TuiStringHandler<string | null> = (value) =>
    value || 'Ask when connecting';

  /** Secret variables of every level, plus the current references so a stale one stays visible. */
  protected readonly secretReferences = computed(() => {
    const project = this.project();
    const names = project ? secretVariableNames(this.config.variables(), project) : [];
    const refs = names.map((name) => `\${${name}}`);
    const { password, passphrase } = this.value();
    for (const current of [password, passphrase]) {
      if (current && !refs.includes(current)) {
        refs.push(current);
      }
    }
    return refs;
  });

  protected readonly preview = computed(() => {
    this.value();
    const project = this.project();
    if (!project) {
      return null;
    }
    const envId = project.activeEnvironmentId;
    const env = project.environments.find((e) => e.id === envId);
    const result = previewHost(
      this.toHostInput(),
      variableLayers(this.config.variables(), project, envId),
    );
    return { ...result, env: env ? `in ${env.name}` : 'with no environment' };
  });

  constructor() {
    effect(() => {
      const keyPath = this.form.controls.keyPath;
      keyPath.setValidators(this.isKey() ? templated('Key path', keyPathValidator) : []);
      keyPath.updateValueAndValidity();
    });
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
    let auth: AuthMethod;
    if (v.authKind === 'key') {
      auth = { kind: 'key', keyPath: v.keyPath.trim(), passphrase: reference(v.passphrase) };
    } else if (v.authKind === 'password') {
      auth = { kind: 'password', password: reference(v.password) };
    } else {
      auth = { kind: 'agent' };
    }
    return {
      name: v.name.trim(),
      hostname: v.hostname.trim(),
      port: v.port.trim(),
      username: v.username.trim(),
      auth,
    };
  }
}
