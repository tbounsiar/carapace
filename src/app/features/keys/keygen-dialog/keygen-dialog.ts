import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  type ValidationErrors,
} from '@angular/forms';
import { TranslocoPipe, TranslocoService, translate } from '@jsverse/transloco';
import { TuiAutoFocus, TuiValidationError } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiCheckbox,
  TuiError,
  TuiHint,
  TuiIcon,
  TuiInput,
  TuiLoader,
  TuiNotification,
  TuiNotificationService,
  TuiTextfield,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiButtonLoading, TuiPassword, TuiSegmented, TuiTooltip } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { map, merge } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyFilePicker } from '../../../core/ipc/key-file-picker';
import { KeyStore } from '../../../core/ipc/key-store';
import type { KeyLocation, KeyType, KeyView } from '../../../core/ipc/keys';
import { Settings } from '../../../core/settings/settings';
import { notifyError, sentence } from '../../../shared/save-error';
import {
  commentValidator,
  DEFAULT_KEY_NAMES,
  fileNameFor,
  fileNameValidator,
  keyFolderValidator,
  keyNameValidator,
  matchValidator,
  passphraseValidator,
} from '../key-validators';
import { ErrorLink } from '../../../shared/error-link';
import { mono, type Part, translateParts } from '../../host-test/host-test-view';

export const FOLDER_FALLBACK = '~/.carapace/keys';
export const CHECK_DELAY_MS = 400;

export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.trim().replace(/[\\/]+$/, '');
  const windows = a.includes('\\') || b.includes('\\');
  return windows ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export interface LocationProblem {
  readonly field: 'folder' | 'fileName';
  readonly message: string;
}

/** Spec copy per error code; null for errors that are not about the location. */
export function locationProblem(err: unknown, fileName: string): LocationProblem | null {
  if (!(err instanceof IpcError)) {
    return null;
  }
  switch (err.code) {
    case 'not_found':
      return {
        field: 'folder',
        message: translate('keys.keygen.folderMissing'),
      };
    case 'permission_denied':
      return {
        field: 'folder',
        message: translate('keys.keygen.folderDenied'),
      };
    case 'already_exists':
      return {
        field: 'fileName',
        message: translate('keys.keygen.fileExists', { file: fileName }),
      };
    case 'invalid_input':
      // One code covers several folder problems (link, file, relative path); the backend
      // message names the one found.
      return { field: 'folder', message: sentence(err.message) };
    default:
      return null;
  }
}

interface LocationCheck {
  readonly folder: string;
  readonly fileName: string;
  readonly result: KeyLocation | null;
  readonly problem: LocationProblem | null;
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
    TuiLoader,
    TuiNotification,
    TuiPassword,
    TuiSegmented,
    TuiTextfield,
    TuiTooltip,
    TranslocoPipe,
  ],
  selector: 'app-keygen-dialog',
  styleUrl: './keygen-dialog.scss',
  templateUrl: './keygen-dialog.html',
})
export class KeygenDialog {
  private readonly store = inject(KeyStore);
  private readonly settings = inject(Settings);
  private readonly picker = inject(KeyFilePicker);
  private readonly alerts = inject(TuiNotificationService);
  private readonly injector = inject(Injector);
  private readonly transloco = inject(TranslocoService);
  protected readonly context = injectContext<TuiDialogContext<KeyView, void>>();

  protected readonly saving = signal(false);
  protected readonly picking = this.picker.picking;
  private readonly folderInput = viewChild('folderInput', { read: ElementRef });
  private readonly folderBrowse = viewChild('folderBrowse', { read: ElementRef });

  private readonly check = signal<LocationCheck | null>(null);
  private checkedKey: string | null = null;
  private checkSeq = 0;
  private keysDirPending = true;

  private readonly names = (): string[] => this.store.keys().map((k) => k.name);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly passphrase = this.fb.control('', passphraseValidator);
  private readonly initialType = this.settings.defaultKeyType();
  private readonly folderControl = this.fb.control(
    this.settings.keyFolder() ?? this.store.keysDir() ?? FOLDER_FALLBACK,
    [keyFolderValidator, (c) => this.checkedProblem('folder', c)],
  );
  protected readonly form = this.fb.group({
    algorithm: this.fb.control<KeyType>(this.initialType),
    name: this.fb.control(DEFAULT_KEY_NAMES[this.initialType], keyNameValidator(this.names)),
    folder: this.folderControl,
    fileName: this.fb.control(fileNameFor(DEFAULT_KEY_NAMES[this.initialType]), [
      fileNameValidator,
      (c) => this.checkedProblem('fileName', c),
    ]),
    comment: this.fb.control('carapace', commentValidator),
    passphrase: this.passphrase,
    confirm: this.fb.control(
      '',
      matchValidator(() => this.passphrase.value),
    ),
    remember: this.fb.control({ value: false, disabled: true }),
  });

  protected readonly fileName = toSignal(this.form.controls.fileName.valueChanges, {
    initialValue: this.form.controls.fileName.value,
  });
  private readonly folder = toSignal(this.folderControl.valueChanges, {
    initialValue: this.folderControl.value,
  });
  private readonly algorithm = toSignal(this.form.controls.algorithm.valueChanges, {
    initialValue: this.form.controls.algorithm.value,
  });
  protected readonly isRsa = computed(() => this.algorithm() === 'rsa4096');
  protected readonly folderInvalid = toSignal(
    this.folderControl.statusChanges.pipe(map((status) => status === 'INVALID')),
    { initialValue: this.folderControl.invalid },
  );
  protected readonly showReset = computed(() => !this.isDefaultFolder(this.folder().trim()));
  protected readonly warning = computed(() => {
    const check = this.check();
    const folder = this.folder().trim();
    return (
      !!check?.result?.warning &&
      check.folder === folder &&
      check.fileName === this.fileName() &&
      !this.isDefaultFolder(folder)
    );
  });

  constructor() {
    this.store
      .loadKeysDir()
      .catch(() => undefined)
      .finally(() => {
        this.keysDirPending = false;
        this.adoptKeysDir();
        void this.runCheck(true);
      });
    effect(() => {
      this.store.keysDir();
      untracked(() => this.adoptKeysDir());
    });
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
    // A taken file name belongs to one folder.
    c.folder.valueChanges
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => c.fileName.updateValueAndValidity());
    merge(c.folder.valueChanges, c.fileName.valueChanges)
      .pipe(debounceTime(CHECK_DELAY_MS), takeUntilDestroyed(destroyRef))
      .subscribe(() => void this.runCheck(false));
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

  protected savedAs(): Part[] {
    const file = this.fileName();
    return translateParts('keys.keygen.savedAs', { file: mono(file), pub: mono(`${file}.pub`) });
  }

  protected checkNow(): void {
    void this.runCheck(true);
  }

  protected async browseFolder(): Promise<void> {
    const folder = this.folderControl;
    let picked: string | null;
    try {
      picked = await this.picker.pickFolder(folder.value.trim() || null);
    } catch (err) {
      notifyError(this.alerts, err, this.transloco.translate('keys.keygen.pickerFailed'));
      return;
    }
    if (picked === null) {
      this.focusLater(this.folderBrowse());
      return;
    }
    folder.setValue(picked);
    folder.markAsDirty();
    folder.markAsTouched();
    this.focusLater(this.folderInput());
    void this.runCheck(true);
  }

  protected resetFolder(): void {
    const folder = this.folderControl;
    folder.setValue(this.store.keysDir() ?? FOLDER_FALLBACK);
    folder.markAsPristine();
    this.settings.setKeyFolder(null);
    this.focusLater(this.folderInput());
    void this.runCheck(true);
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    const v = this.form.getRawValue();
    const folder = v.folder.trim();
    const dir = this.dirArg(folder);
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
        dir,
      });
      this.settings.setKeyFolder(dir);
      this.context.completeWith(key);
    } catch (err) {
      const problem = locationProblem(err, v.fileName);
      // Without a custom folder, invalid_input is not about the folder.
      if (problem && !(dir === null && err instanceof IpcError && err.code === 'invalid_input')) {
        this.checkedKey = JSON.stringify([folder, v.fileName]);
        this.applyCheck({ folder, fileName: v.fileName, result: null, problem });
      } else {
        notifyError(this.alerts, err, this.transloco.translate('keys.keygen.notGenerated'));
      }
    } finally {
      this.saving.set(false);
    }
  }

  /** `force` re-checks values already checked (blur, pick): the folder may have changed on disk. */
  private async runCheck(force: boolean): Promise<void> {
    const c = this.form.controls;
    if (this.keysDirPending || keyFolderValidator(c.folder) || fileNameValidator(c.fileName)) {
      return;
    }
    const folder = c.folder.value.trim();
    const fileName = c.fileName.value;
    const key = JSON.stringify([folder, fileName]);
    if (!force && key === this.checkedKey) {
      return;
    }
    this.checkedKey = key;
    const seq = ++this.checkSeq;
    let next: LocationCheck;
    try {
      const result = await this.store.checkLocation(this.dirArg(folder), fileName);
      next = { folder, fileName, result, problem: null };
    } catch (err) {
      next = { folder, fileName, result: null, problem: locationProblem(err, fileName) };
    }
    if (seq === this.checkSeq) {
      this.applyCheck(next);
    }
  }

  private applyCheck(next: LocationCheck): void {
    this.check.set(next);
    const c = this.form.controls;
    c.folder.updateValueAndValidity();
    c.fileName.updateValueAndValidity();
    if (next.problem) {
      c[next.problem.field].markAsTouched();
    }
  }

  private checkedProblem(
    field: LocationProblem['field'],
    control: AbstractControl,
  ): ValidationErrors | null {
    const check = untracked(this.check);
    if (!check?.problem || check.problem.field !== field) {
      return null;
    }
    const value = String(control.value ?? '');
    const matches =
      field === 'folder'
        ? check.folder === value.trim()
        : check.fileName === value && check.folder === this.folderControl.value.trim();
    return matches ? { invalid: new TuiValidationError(check.problem.message) } : null;
  }

  private adoptKeysDir(): void {
    const dir = this.store.keysDir();
    const folder = this.folderControl;
    if (dir !== null && !folder.dirty && folder.value === FOLDER_FALLBACK) {
      folder.setValue(dir);
    }
  }

  private isDefaultFolder(folder: string): boolean {
    const check = this.check();
    if (check?.result?.isDefault && check.folder === folder) {
      return true;
    }
    const dir = this.store.keysDir();
    return dir === null ? folder === FOLDER_FALLBACK : samePath(folder, dir);
  }

  private dirArg(folder: string): string | null {
    return untracked(() => this.isDefaultFolder(folder)) ? null : folder;
  }

  private focusLater(ref: ElementRef | undefined): void {
    afterNextRender(() => (ref?.nativeElement as HTMLElement | undefined)?.focus(), {
      injector: this.injector,
    });
  }

  private clearPassphrase(): void {
    const c = this.form.controls;
    c.passphrase.reset();
    c.confirm.reset();
    c.remember.reset();
  }
}
