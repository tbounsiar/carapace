import {
  afterNextRender,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus, TuiValidationError } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiCheckbox,
  TuiError,
  TuiHint,
  TuiIcon,
  TuiInput,
  TuiNotificationService,
  TuiTextfield,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiButtonLoading, TuiPassword, TuiTooltip } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyFilePicker } from '../../../core/ipc/key-file-picker';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyView } from '../../../core/ipc/keys';
import { notifyError } from '../../../shared/save-error';
import {
  baseName,
  keyFilePathValidator,
  keyNameValidator,
  passphraseValidator,
} from '../key-validators';
import { ErrorLink } from '../../../shared/error-link';

export interface KeyImportDialogData {
  /** Prefills the path (a file just browsed elsewhere). */
  readonly path?: string;
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
    TuiHint,
    TuiIcon,
    TuiInput,
    TuiPassword,
    TuiTextfield,
    TuiTooltip,
  ],
  selector: 'app-key-import-dialog',
  styleUrl: './key-import-dialog.scss',
  templateUrl: './key-import-dialog.html',
})
export class KeyImportDialog {
  private readonly store = inject(KeyStore);
  private readonly alerts = inject(TuiNotificationService);
  private readonly picker = inject(KeyFilePicker);
  private readonly injector = inject(Injector);
  protected readonly context =
    injectContext<TuiDialogContext<KeyView, KeyImportDialogData | undefined>>();
  private readonly initialPath = this.context.data?.path ?? '';
  protected readonly prefilled = !!this.initialPath;
  protected readonly picking = this.picker.picking;
  private readonly pathInput = viewChild('pathInput', { read: ElementRef });
  private readonly browseButton = viewChild('browseButton', { read: ElementRef });

  protected readonly saving = signal(false);
  private readonly names = (): string[] => this.store.keys().map((k) => k.name);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly form = this.fb.group({
    path: this.fb.control(this.initialPath, keyFilePathValidator),
    name: this.fb.control(baseName(this.initialPath), keyNameValidator(this.names)),
    passphrase: this.fb.control('', passphraseValidator),
    remember: this.fb.control({ value: false, disabled: true }),
  });

  constructor() {
    const c = this.form.controls;
    if (this.prefilled) {
      c.path.markAsTouched();
    }
    const destroyRef = inject(DestroyRef);
    c.path.valueChanges.pipe(takeUntilDestroyed(destroyRef)).subscribe((path) => {
      if (!c.name.dirty) {
        c.name.setValue(baseName(path));
      }
    });
    c.passphrase.valueChanges.pipe(takeUntilDestroyed(destroyRef)).subscribe((passphrase) => {
      if (passphrase) {
        c.remember.enable();
      } else {
        c.remember.setValue(false);
        c.remember.disable();
      }
    });
  }

  protected async browse(): Promise<void> {
    const path = this.form.controls.path;
    let picked: string | null;
    try {
      picked = await this.picker.pickFile(path.value.trim() || null);
    } catch (err) {
      notifyError(this.alerts, err, 'File picker not opened');
      return;
    }
    if (picked === null) {
      this.focusLater(this.browseButton());
      return;
    }
    path.setValue(picked);
    path.markAsDirty();
    path.markAsTouched();
    this.focusLater(this.pathInput());
  }

  private focusLater(ref: ElementRef | undefined): void {
    afterNextRender(() => (ref?.nativeElement as HTMLElement | undefined)?.focus(), {
      injector: this.injector,
    });
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    const v = this.form.getRawValue();
    // The passphrase only lives in this call: the fields are cleared before the backend answers.
    this.form.controls.passphrase.reset();
    this.form.controls.remember.reset();
    this.saving.set(true);
    try {
      const key = await this.store.import({
        name: v.name.trim(),
        path: v.path.trim(),
        passphrase: v.passphrase || null,
        rememberPassphrase: !!v.passphrase && v.remember,
      });
      this.context.completeWith(key);
    } catch (err) {
      this.handleError(err);
    } finally {
      this.saving.set(false);
    }
  }

  private handleError(err: unknown): void {
    const c = this.form.controls;
    if (!(err instanceof IpcError)) {
      notifyError(this.alerts, err, 'Key not imported');
      return;
    }
    const field =
      err.code === 'invalid_passphrase'
        ? c.passphrase
        : ['already_exists', 'invalid_input', 'not_found', 'too_large'].includes(err.code)
          ? c.path
          : null;
    if (!field) {
      notifyError(this.alerts, err, 'Key not imported');
      return;
    }
    const message = err.code === 'invalid_passphrase' ? 'Wrong passphrase' : err.message;
    field.setErrors({ invalid: new TuiValidationError(message) });
    field.markAsTouched();
  }
}
