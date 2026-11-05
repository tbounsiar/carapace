import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiDataList,
  TuiError,
  TuiInput,
  TuiNotification,
  TuiTextfield,
  TuiTitle,
  type TuiDialogContext,
} from '@taiga-ui/core';
import { TuiButtonLoading } from '@taiga-ui/kit';
import { TuiForm } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConfigService } from '../../../core/ipc/config';
import type { ConfigNode } from '../../../core/ipc/config.models';
import { crossScopeWarning, moveTargets, type MoveTarget } from '../move-rules';
import { sameContainer, type Container } from '../node-tree';
import { uiText } from '../../../shared/ui-text';

export interface MoveDialogData {
  readonly node: ConfigNode;
  /** Resolves null once moved, else the message to show under the list. */
  readonly move: (target: Container) => Promise<string | null>;
}

@Component({
  imports: [
    ReactiveFormsModule,
    TuiAutoFocus,
    TuiButton,
    TuiButtonLoading,
    TuiDataList,
    TuiError,
    TuiForm,
    TuiInput,
    TuiNotification,
    TuiTextfield,
    TuiTitle,
    TranslocoPipe,
  ],
  selector: 'app-move-dialog',
  templateUrl: './move-dialog.html',
  styleUrl: './move-dialog.scss',
})
export class MoveDialog {
  private readonly config = inject(ConfigService);
  protected readonly context = injectContext<TuiDialogContext<void, MoveDialogData>>();
  private readonly node = this.context.data.node;

  protected readonly query = new FormControl('', { nonNullable: true });
  private readonly filter = toSignal(this.query.valueChanges, { initialValue: '' });
  protected readonly chosen = signal<Container | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly groups = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    return moveTargets(this.config.nodes(), this.config.projects(), this.node)
      .map((group) => ({
        ...group,
        targets: group.targets.filter((t) => t.text.toLowerCase().includes(needle)),
      }))
      .filter((group) => group.targets.length > 0);
  });

  protected readonly empty = computed(() =>
    uiText('projectTree.moveDialog.noMatch', { query: this.filter().trim() }),
  );

  protected readonly warning = computed(() => {
    const target = this.chosen();
    return target
      ? crossScopeWarning(
          this.config.nodes(),
          this.config.projects(),
          this.config.variables(),
          this.node,
          target,
        )
      : null;
  });

  protected testId(target: MoveTarget): string {
    return `move-target-${target.path.join('/')}`;
  }

  protected isChosen(target: MoveTarget): boolean {
    const chosen = this.chosen();
    return !!chosen && sameContainer(chosen, target.container);
  }

  protected choose(target: MoveTarget): void {
    if (!target.current) {
      this.chosen.set(target.container);
      this.error.set(null);
    }
  }

  protected async submit(): Promise<void> {
    const target = this.chosen();
    if (!target || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      const error = await this.context.data.move(target);
      if (error === null) {
        this.context.completeWith();
      } else {
        this.error.set(error || null);
      }
    } finally {
      this.saving.set(false);
    }
  }
}
