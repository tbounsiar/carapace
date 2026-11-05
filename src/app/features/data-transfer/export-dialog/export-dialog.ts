import { Component, computed, inject, signal, type WritableSignal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus, type TuiStringHandler } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiCheckbox,
  TuiDataList,
  type TuiDialogContext,
  TuiDropdown,
  TuiGroup,
  TuiLabel,
  TuiNotification,
  TuiNotificationService,
  TuiRadio,
  TuiTextfield,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiBlock, TuiButtonLoading, TuiChevron, TuiSelect } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../../core/ipc/config';
import {
  type DataScope,
  DataTransferIpc,
  type ExportResult,
} from '../../../core/ipc/data-transfer';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyStore } from '../../../core/ipc/key-store';
import { errorText } from '../../../shared/save-error';
import { byName, plural } from '../../project-tree/node-tree';
import { PICKER_BUSY } from '../import-view';

export interface ExportDialogData {
  readonly preset: DataScope;
  /** True while the save dialog is open or the file is written; the dialog cannot close then. */
  readonly busy: WritableSignal<boolean>;
}

type ScopeKind = DataScope['kind'];

function parts(list: readonly [number, string][]): string {
  return list
    .filter(([n]) => n > 0)
    .map(([n, noun]) => plural(n, noun))
    .join(', ');
}

@Component({
  imports: [
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiBlock,
    TuiButton,
    TuiButtonLoading,
    TuiCheckbox,
    TuiChevron,
    TuiDataList,
    TuiDropdown,
    TuiForm,
    TuiGroup,
    TuiLabel,
    TuiNotification,
    TuiRadio,
    TuiSelect,
    TuiTextfield,
    TuiTitle,
  ],
  selector: 'app-export-dialog',
  templateUrl: './export-dialog.html',
  styleUrl: './export-dialog.scss',
})
export class ExportDialog {
  private readonly ipc = inject(DataTransferIpc);
  private readonly config = inject(ConfigService);
  private readonly keys = inject(KeyStore);
  private readonly alerts = inject(TuiNotificationService);
  protected readonly context =
    injectContext<TuiDialogContext<ExportResult | undefined, ExportDialogData>>();
  protected readonly busy = this.context.data.busy;
  protected readonly error = signal<string | null>(null);

  protected readonly projects = computed(() => [...this.config.projects()].sort(byName));
  private readonly preset = this.context.data.preset;
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly form = this.fb.group({
    scope: this.fb.control<ScopeKind>(this.preset.kind),
    projectId: this.fb.control<string | null>(
      this.preset.kind === 'project' ? this.preset.projectId : null,
    ),
    includeShared: [true],
  });
  private readonly value = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });
  protected readonly scope = computed(() => this.value().scope ?? 'all');
  protected readonly canSubmit = computed(
    () => this.scope() !== 'project' || !!this.value().projectId,
  );

  protected readonly allNote = computed(() => {
    const projects = this.config.projects();
    const variables =
      this.config.variables().length + projects.reduce((n, p) => n + p.variables.length, 0);
    return (
      parts([
        [projects.length, 'project'],
        [this.config.hosts().length, 'host'],
        [variables, 'variable'],
        [this.keys.keys().length, 'SSH key'],
      ]) || 'Projects, Home, global variables, SSH keys'
    );
  });
  protected readonly homeNote = computed(
    () =>
      parts([
        [this.config.hosts().filter((h) => h.projectId === null).length, 'host'],
        [this.config.variables().length, 'global variable'],
        [this.keys.keys().length, 'SSH key'],
      ]) || 'Hosts outside projects, global variables, SSH keys',
  );

  protected readonly stringify: TuiStringHandler<string | null> = (id) =>
    (id && this.config.findProject(id)?.name) || '';

  constructor() {
    this.keys.ensureLoaded().catch(() => undefined);
    if (!this.projects().length) {
      this.form.controls.scope.setValue(this.preset.kind === 'project' ? 'all' : this.preset.kind);
    }
  }

  protected selectFirstProject(): void {
    const first = this.projects()[0];
    if (first && !this.form.controls.projectId.value) {
      this.form.controls.projectId.setValue(first.id);
    }
  }

  protected async submit(): Promise<void> {
    if (this.busy() || !this.canSubmit()) {
      return;
    }
    const { scope, projectId, includeShared } = this.form.getRawValue();
    const target: DataScope =
      scope === 'project' && projectId ? { kind: 'project', projectId } : { kind: scope as 'all' };
    this.error.set(null);
    this.busy.set(true);
    this.form.disable({ emitEvent: false });
    try {
      const result = await this.ipc.exportData(target, scope === 'project' && includeShared);
      if (result) {
        this.busy.set(false);
        this.context.completeWith(result);
        return;
      }
    } catch (err) {
      if (err instanceof IpcError && err.code === 'busy') {
        this.alerts.open(PICKER_BUSY, { appearance: 'warning' }).subscribe();
      } else {
        this.error.set(errorText(err));
      }
    }
    this.busy.set(false);
    this.form.enable({ emitEvent: false });
  }

  protected cancel(): void {
    if (!this.busy()) {
      this.context.$implicit.complete();
    }
  }
}
