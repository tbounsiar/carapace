import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus, TuiValidationError } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiCheckbox,
  TuiError,
  TuiIcon,
  TuiInput,
  TuiLoader,
  TuiNotificationService,
  TuiTextfield,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiButtonLoading, TuiPassword, TuiSegmented, TuiTooltip } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyType, KeyView } from '../../../core/ipc/keys';
import { Settings } from '../../../core/settings/settings';
import { notifyError } from '../../project-tree/save-error';
import {
  commentValidator,
  DEFAULT_KEY_NAMES,
  fileNameFor,
  fileNameValidator,
  keyNameValidator,
  matchValidator,
  passphraseValidator,
} from '../key-validators';
import { ErrorLink } from '../../../shared/error-link';

/** Shown until the backend tells the real directory. */
export const KEYS_DIR_FALLBACK = '~/.carapace/keys/';

export function keyFilePreview(dir: string | null, fileName: string): string {
  if (!dir) {
    return `${KEYS_DIR_FALLBACK}${fileName}`;
  }
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${fileName}` : `${dir}${sep}${fileName}`;
}

@Component({
  imports: [
    ErrorLink,
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiButtonLoading,
    TuiCheckbox,
    TuiError,
    TuiForm,
    TuiIcon,
    TuiInput,
    TuiLoader,
    TuiPassword,
    TuiSegmented,
    TuiTextfield,
    TuiTooltip,
  ],
  selector: 'app-keygen-dialog',
  styleUrl: './keygen-dialog.scss',
  templateUrl: './keygen-dialog.html',
})
export class KeygenDialog {
  private readonly store = inject(KeyStore);
  private readonly alerts = inject(TuiNotificationService);
  protected readonly context = injectContext<TuiDialogContext<KeyView, void>>();

  protected readonly saving = signal(false);
  private readonly names = (): string[] => this.store.keys().map((k) => k.name);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly passphrase = this.fb.control('', passphraseValidator);
  private readonly initialType = inject(Settings).defaultKeyType();
  protected readonly form = this.fb.group({
    algorithm: this.fb.control<KeyType>(this.initialType),
    name: this.fb.control(DEFAULT_KEY_NAMES[this.initialType], keyNameValidator(this.names)),
    fileName: this.fb.control(fileNameFor(DEFAULT_KEY_NAMES[this.initialType]), fileNameValidator),
    comment: this.fb.control('carapace', commentValidator),
    passphrase: this.passphrase,
    confirm: this.fb.control(
      '',
      matchValidator(() => this.passphrase.value),
    ),
    remember: this.fb.control({ value: false, disabled: true }),
  });

  private readonly fileName = toSignal(this.form.controls.fileName.valueChanges, {
    initialValue: this.form.controls.fileName.value,
  });
  private readonly algorithm = toSignal(this.form.controls.algorithm.valueChanges, {
    initialValue: this.form.controls.algorithm.value,
  });
  protected readonly isRsa = computed(() => this.algorithm() === 'rsa4096');
  protected readonly pathPreview = computed(() =>
    keyFilePreview(this.store.keysDir(), this.fileName()),
  );

  constructor() {
    this.store.loadKeysDir().catch(() => undefined);
    const c = this.form.controls;
    const destroyRef = inject(DestroyRef);
    c.algorithm.valueChanges.pipe(takeUntilDestroyed(destroyRef)).subscribe((algorithm) => {
      if (!c.name.dirty) {
        c.name.setValue(DEFAULT_KEY_NAMES[algorithm]);
      }
    });
    c.name.valueChanges.pipe(takeUntilDestroyed(destroyRef)).subscribe((name) => {
      if (!c.fileName.dirty) {
        c.fileName.setValue(fileNameFor(name));
      }
    });
    c.passphrase.valueChanges.pipe(takeUntilDestroyed(destroyRef)).subscribe((passphrase) => {
      c.confirm.updateValueAndValidity();
      if (passphrase) {
        c.remember.enable();
      } else {
        c.remember.setValue(false);
        c.remember.disable();
      }
    });
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    const v = this.form.getRawValue();
    // The passphrase only lives in this call: the fields are cleared before the backend answers.
    this.clearPassphrase();
    this.saving.set(true);
    try {
      const key = await this.store.generate({
        name: v.name.trim(),
        fileName: v.fileName,
        algorithm: v.algorithm,
        comment: v.comment,
        passphrase: v.passphrase || null,
        rememberPassphrase: !!v.passphrase && v.remember,
      });
      this.context.completeWith(key);
    } catch (err) {
      if (err instanceof IpcError && err.code === 'already_exists') {
        const fileName = this.form.controls.fileName;
        fileName.setErrors({ invalid: new TuiValidationError(err.message) });
        fileName.markAsTouched();
      } else {
        notifyError(this.alerts, err, 'Key not generated');
      }
    } finally {
      this.saving.set(false);
    }
  }

  private clearPassphrase(): void {
    const c = this.form.controls;
    c.passphrase.reset();
    c.confirm.reset();
    c.remember.reset();
  }
}
