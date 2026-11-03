import { Component, computed, inject, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiDialogService, TuiTitle } from '@taiga-ui/core';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import type { VariableScope } from '../../../core/ipc/config.models';
import { confirmDestructive } from '../../../shared/destructive-confirm/confirm-destructive';
import type { LeaveGuarded } from '../unsaved-changes-guard';
import { VariablesEditor } from '../variables-editor/variables-editor';

@Component({
  imports: [RouterLink, TuiBlockStatus, TuiButton, TuiHeader, TuiTitle, VariablesEditor],
  selector: 'app-variables-page',
  styleUrl: './variables-page.scss',
  templateUrl: './variables-page.html',
})
export class VariablesPage implements LeaveGuarded {
  private readonly config = inject(ConfigService);
  private readonly dialogs = inject(TuiDialogService);

  /** Absent on the global variables route. */
  readonly projectId = input<string>();
  /** A tab of the project dashboard, whose header already names the project and handles not-found. */
  readonly embedded = input(false);

  private readonly editor = viewChild(VariablesEditor);
  protected readonly example = '${name}';

  protected readonly project = computed(() => {
    const id = this.projectId();
    return id ? (this.config.projects().find((p) => p.id === id) ?? null) : null;
  });
  protected readonly notFound = computed(
    () => !this.embedded() && !!this.projectId() && !this.project() && !this.config.loading(),
  );

  protected readonly scope = computed<VariableScope | null>(() => {
    const project = this.project();
    if (!this.projectId()) {
      return { kind: 'global' };
    }
    return project ? { kind: 'project', projectId: project.id } : null;
  });

  protected readonly variables = computed(() =>
    this.projectId() ? (this.project()?.variables ?? []) : this.config.variables(),
  );

  async canLeave(): Promise<boolean> {
    if (!this.editor()?.dirty()) {
      return true;
    }
    return confirmDestructive(this.dialogs, 'Discard unsaved changes?', {
      content: 'Your changes to these variables are not saved.',
      yes: 'Discard',
      no: 'Keep editing',
    });
  }
}
