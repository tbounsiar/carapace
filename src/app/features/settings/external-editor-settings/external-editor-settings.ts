import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import {
  TuiButton,
  TuiError,
  TuiHint,
  TuiInput,
  TuiLabel,
  TuiNotificationService,
  TuiTextfield,
} from '@taiga-ui/core';
import { TuiSegmented, TuiSwitch } from '@taiga-ui/kit';
import { type ExternalEditorSetting, ExternalEditsIpc } from '../../../core/ipc/external-edits';
import { IpcError } from '../../../core/ipc/ipc-error';
import { notifyError } from '../../../shared/save-error';

type Mode = ExternalEditorSetting['mode'];

const NOT_AN_EDITOR =
  "This program runs scripts or commands; it is not an editor. Pick your editor's program file.";

/** Settings > External editor (spec X10, R6): which app opens edited files, and the notice. */
@Component({
  imports: [
    ReactiveFormsModule,
    TuiButton,
    TuiError,
    TuiHint,
    TuiInput,
    TuiLabel,
    TuiSegmented,
    TuiSwitch,
    TuiTextfield,
  ],
  selector: 'app-external-editor-settings',
  styleUrl: './external-editor-settings.scss',
  templateUrl: './external-editor-settings.html',
})
export class ExternalEditorSettings {
  private readonly ipc = inject(ExternalEditsIpc);
  private readonly alerts = inject(TuiNotificationService);

  protected readonly setting = signal<ExternalEditorSetting | null>(null);
  protected readonly picking = signal(false);
  /** A picked app refused by the backend, shown under the path field. */
  protected readonly appError = signal<string | null>(null);
  protected readonly mode = new FormControl<Mode>(
    { value: 'system', disabled: true },
    { nonNullable: true },
  );
  /** Checked = the notice shows (the inverse of `noticeSeen`). */
  protected readonly notice = new FormControl(
    { value: true, disabled: true },
    { nonNullable: true },
  );

  constructor() {
    this.ipc
      .getEditor()
      .then((setting) => this.show(setting))
      .catch((err: unknown) => notifyError(this.alerts, err, 'Setting not read'));
    this.mode.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((mode) => void this.update({ mode }));
    this.notice.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((show) => void this.update({ noticeSeen: !show }));
  }

  protected async browse(): Promise<void> {
    const current = this.setting();
    if (!current || this.picking()) {
      return;
    }
    this.picking.set(true);
    try {
      const path = await this.ipc.pickEditor(current.appPath);
      if (path) {
        await this.update({ mode: 'custom', appPath: path });
      }
    } catch (err) {
      notifyError(this.alerts, err, 'File picker not opened');
    } finally {
      this.picking.set(false);
    }
  }

  protected clear(): Promise<void> {
    return this.update({ mode: 'system', appPath: null });
  }

  private async update(change: Partial<ExternalEditorSetting>): Promise<void> {
    const current = this.setting();
    if (!current) {
      return;
    }
    this.appError.set(null);
    try {
      this.show(await this.ipc.setEditor({ ...current, ...change }));
    } catch (err) {
      if (err instanceof IpcError && err.code === 'app_not_editor') {
        this.appError.set(NOT_AN_EDITOR);
      } else {
        notifyError(this.alerts, err, 'Setting not saved');
      }
      this.show(current);
    }
  }

  private show(setting: ExternalEditorSetting): void {
    this.setting.set(setting);
    this.mode.enable({ emitEvent: false });
    this.notice.enable({ emitEvent: false });
    this.mode.setValue(setting.mode, { emitEvent: false });
    this.notice.setValue(!setting.noticeSeen, { emitEvent: false });
  }
}
