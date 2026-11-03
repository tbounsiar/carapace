import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, TuiCheckbox, type TuiDialogContext } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { KeyView } from '../../../core/ipc/keys';

export interface KeyDeleteDialogData {
  readonly key: Pick<KeyView, 'name' | 'path' | 'managed'>;
}

export interface KeyDeleteDecision {
  readonly deleteFiles: boolean;
}

@Component({
  imports: [ReactiveFormsModule, TuiAutoFocus, TuiButton, TuiCheckbox],
  selector: 'app-key-delete-dialog',
  styleUrl: './key-delete-dialog.scss',
  templateUrl: './key-delete-dialog.html',
})
export class KeyDeleteDialog {
  protected readonly context =
    injectContext<TuiDialogContext<KeyDeleteDecision, KeyDeleteDialogData>>();
  protected readonly key = this.context.data.key;
  protected readonly deleteFiles = new FormControl(true, { nonNullable: true });

  protected confirm(): void {
    this.context.completeWith({ deleteFiles: this.key.managed && this.deleteFiles.value });
  }
}
