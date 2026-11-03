import { TuiActiveZone } from '@taiga-ui/cdk';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiError,
  TuiHint,
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
import { KeyStore } from '../../../core/ipc/key-store';
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
import { ErrorLink } from '../../../shared/error-link';

export interface HostDialogData {
  /** Scope of the host: null is Home (global variables only). */
  readonly projectId: string | null;
  /** "Home / Backend", shown read-only. */
  readonly location: string;
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
    ErrorLink,
    TuiActiveZone,
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiButtonLoading,
    TuiChevron,
    TuiDataList,
    TuiDropdown,
    TuiError,
    TuiHint,
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
  private readonly keyStore = inject(KeyStore);
  protected readonly context = injectContext<TuiDialogContext<void, HostDialogData>>();

  protected readonly authKinds: readonly AuthKind[] = ['password', 'key', 'agent'];
  protected readonly example = '${host}';

  protected readonly saving = signal(false);
  protected readonly keys = this.keyStore.keys;
  protected readonly keyMenuOpen = signal(false);
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

  private readonly project = computed(() => {
    const id = this.context.data.projectId;
    return id ? this.config.findProject(id) : null;
  });
  protected readonly askLabel: TuiStringHandler<string | null> = (value) =>
    value || 'Ask when connecting';

  /** Secret variables of both levels, plus the current references so a stale one stays visible. */
  protected readonly secretReferences = computed(() => {
    const project = this.project();
    const names = secretVariableNames(this.config.variables(), project);
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
    if (this.context.data.projectId && !project) {
      return null;
    }
    return previewHost(this.toHostInput(), variableLayers(this.config.variables(), project));
  });

  constructor() {
    // The picker is optional: without the key list the path is still typed by hand.
    this.keyStore.ensureLoaded().catch(() => undefined);
    effect(() => {
      const keyPath = this.form.controls.keyPath;
      keyPath.setValidators(this.isKey() ? templated('Key path', keyPathValidator) : []);
      keyPath.updateValueAndValidity();
    });
  }

  protected pickKey(path: string): void {
    const keyPath = this.form.controls.keyPath;
    keyPath.setValue(path);
    keyPath.markAsDirty();
    keyPath.markAsTouched();
    this.keyMenuOpen.set(false);
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
