import { inject, Service } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { TransferConflict } from '../../core/ipc/transfers';
import {
  ConflictDialog,
  type ConflictAnswer,
  type ConflictDialogData,
} from './conflict-dialog/conflict-dialog';

/** Closing without a choice skips only this file: the job must get an answer to resume. */
const DISMISSED: ConflictAnswer = { decision: 'skip', applyToAll: false };

@Service()
export class ConflictPrompter {
  private readonly dialogs = inject(TuiDialogService);

  ask(name: string, conflict: TransferConflict): Promise<ConflictAnswer> {
    return firstValueFrom(
      this.dialogs.open<ConflictAnswer>(new PolymorpheusComponent(ConflictDialog), {
        label: 'File already exists',
        size: 's',
        data: { name, conflict } satisfies ConflictDialogData,
      }),
      { defaultValue: DISMISSED },
    );
  }
}
