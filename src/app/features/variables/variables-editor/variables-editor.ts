import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type FormControl,
  type FormGroup,
  NonNullableFormBuilder,
  ReactiveFormsModule,
} from '@angular/forms';
import { TuiTable } from '@taiga-ui/addon-table';
import { type TuiStringHandler, TuiValidationError } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiDataList,
  TuiHint,
  TuiIcon,
  TuiInput,
  TuiNotification,
  TuiNotificationService,
  TuiTextfield,
} from '@taiga-ui/core';
import { TuiButtonLoading, TuiChevron, TuiSelect } from '@taiga-ui/kit';
import { ConfigService } from '../../../core/ipc/config';
import type {
  VariableInput,
  VariableKind,
  VariableScope,
  VariableView,
} from '../../../core/ipc/config.models';
import { notifyError } from '../../project-tree/save-error';
import {
  MAX_VARIABLES,
  variableNameValidator,
  variableValueValidator,
} from '../variable-validators';

type Row = FormGroup<{
  name: FormControl<string>;
  kind: FormControl<VariableKind>;
  /** The plain value, or a newly typed secret value (empty keeps the stored one). */
  value: FormControl<string>;
}>;

const KIND_LABELS: Record<VariableKind, string> = { plain: 'Plain', secret: 'Secret' };

export function scopeKey(scope: VariableScope): string {
  return scope.kind === 'global' ? 'global' : `project:${scope.projectId}`;
}

@Component({
  imports: [
    ReactiveFormsModule,
    TuiButton,
    TuiButtonLoading,
    TuiChevron,
    TuiDataList,
    TuiHint,
    TuiIcon,
    TuiInput,
    TuiNotification,
    TuiSelect,
    TuiTable,
    TuiTextfield,
  ],
  selector: 'app-variables-editor',
  styleUrl: './variables-editor.scss',
  templateUrl: './variables-editor.html',
})
export class VariablesEditor {
  private readonly config = inject(ConfigService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly scope = input.required<VariableScope>();
  readonly variables = input.required<readonly VariableView[]>();

  protected readonly kinds: readonly VariableKind[] = ['plain', 'secret'];
  protected readonly maxVariables = MAX_VARIABLES;
  protected readonly example = '${name}';
  protected readonly kindLabel: TuiStringHandler<VariableKind> = (kind) => KIND_LABELS[kind];

  protected readonly rows = this.fb.array<Row>([]);
  protected readonly form = this.fb.group({ rows: this.rows });
  protected readonly saving = signal(false);
  /** What each row was when loaded; secrets never carry a value here. */
  private origins = new WeakMap<Row, VariableView>();

  private readonly tick = toSignal(this.form.events, { initialValue: null });
  readonly dirty = computed(() => {
    this.tick();
    return this.form.dirty;
  });

  protected readonly rowViews = computed(() => {
    this.tick();
    return this.rows.controls.map((group, index) => {
      const { name, kind, value } = group.getRawValue();
      const origin = this.origins.get(group);
      const storedSecret = origin?.kind === 'secret' && origin.hasValue;
      const hasValue = storedSecret && kind === 'secret' && name === origin.name;
      return {
        group,
        index,
        kind,
        hasValue,
        dropsValue: storedSecret && kind === 'secret' && name !== origin.name && !value,
      };
    });
  });

  /** Shown under the table so every cell keeps the height of a single textfield. */
  protected readonly errors = computed(() => {
    this.tick();
    return this.rows.controls.flatMap((group, index) =>
      (['name', 'value'] as const).flatMap((field) => {
        const control = group.controls[field];
        const error: unknown = control.errors?.['invalid'];
        if (!control.touched || !(error instanceof TuiValidationError)) {
          return [];
        }
        return [`Row ${index + 1}, ${field}: ${String(error.message)}`];
      }),
    );
  });

  protected readonly droppedNames = computed(() =>
    this.rowViews()
      .filter((row) => row.dropsValue)
      .map((row) => this.origins.get(row.group)?.name ?? ''),
  );

  constructor() {
    effect(() => {
      scopeKey(this.scope());
      this.reset(untracked(this.variables));
    });
  }

  add(): void {
    if (this.rows.length >= MAX_VARIABLES) {
      return;
    }
    this.rows.push(this.row({ name: '', kind: 'plain', value: '', hasValue: false }, false));
    this.rows.markAsDirty();
  }

  protected remove(index: number): void {
    this.rows.removeAt(index);
    this.rows.markAsDirty();
    this.revalidateNames();
  }

  protected revalidateNames(): void {
    for (const row of this.rows.controls) {
      row.controls.name.updateValueAndValidity({ emitEvent: false });
    }
    this.form.updateValueAndValidity();
  }

  protected cancel(): void {
    this.reset(this.variables());
  }

  protected async save(): Promise<void> {
    this.revalidateNames();
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    const inputs = this.rows.controls.map((row) => this.toInput(row));
    this.saving.set(true);
    try {
      const saved = await this.config.setVariables(this.scope(), inputs);
      this.reset(saved);
    } catch (err) {
      notifyError(this.alerts, err, 'Variables not saved');
      // The config may be stored even when a keychain write failed; show what was saved.
      await this.config.load().catch(() => undefined);
    } finally {
      this.saving.set(false);
    }
  }

  private toInput(row: Row): VariableInput {
    const { name, kind, value } = row.getRawValue();
    return kind === 'plain'
      ? { name, kind, value }
      : { name, kind, secretValue: value === '' ? null : value };
  }

  /** Rebuilds the rows from saved state, which also drops any typed secret value. */
  private reset(variables: readonly VariableView[]): void {
    this.origins = new WeakMap();
    this.rows.clear({ emitEvent: false });
    for (const variable of variables) {
      this.rows.push(this.row(variable, true), { emitEvent: false });
    }
    this.form.markAsPristine();
    this.form.markAsUntouched();
    this.form.updateValueAndValidity();
  }

  private row(variable: VariableView, saved: boolean): Row {
    const row: Row = this.fb.group({
      name: [variable.name, variableNameValidator],
      kind: [variable.kind],
      value: [variable.kind === 'plain' ? (variable.value ?? '') : '', variableValueValidator],
    });
    if (saved) {
      this.origins.set(row, variable);
    }
    // A value typed for one kind must never be sent as the other.
    row.controls.kind.valueChanges.subscribe(() => row.controls.value.setValue(''));
    return row;
  }
}
