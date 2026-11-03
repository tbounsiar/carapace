import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, TuiCheckbox, TuiNotification, type TuiDialogContext } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { ConflictDecision, TransferConflict } from '../../../core/ipc/transfers';
import { formatModified, formatSize } from '../../files/file-list';

export interface ConflictAnswer {
  readonly decision: ConflictDecision;
  readonly applyToAll: boolean;
}

export interface ConflictDialogData {
  readonly name: string;
  readonly conflict: TransferConflict;
}

function describeFile(size: number | null, modified: number | null): string {
  return [formatSize(size), formatModified(modified)].filter(Boolean).join(' · ') || 'Unknown';
}

@Component({
  imports: [ReactiveFormsModule, TuiAutoFocus, TuiButton, TuiCheckbox, TuiNotification],
  selector: 'app-conflict-dialog',
  styleUrl: './conflict-dialog.scss',
  templateUrl: './conflict-dialog.html',
})
export class ConflictDialog {
  protected readonly context =
    injectContext<TuiDialogContext<ConflictAnswer, ConflictDialogData>>();
  protected readonly conflict = this.context.data.conflict;
  protected readonly name = this.context.data.name;
  protected readonly applyToAll = new FormControl(false, { nonNullable: true });
  protected readonly existing = describeFile(
    this.conflict.existingSize,
    this.conflict.existingModified,
  );
  protected readonly incoming = describeFile(
    this.conflict.incomingSize,
    this.conflict.incomingModified,
  );

  protected answer(decision: ConflictDecision): void {
    this.context.completeWith({ decision, applyToAll: this.applyToAll.value });
  }
}
