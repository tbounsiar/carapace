import { inject, Service } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { TransferConflict } from '../../core/ipc/transfers';
import type { ConflictAnswer, ConflictDialogData } from './conflict-dialog/conflict-dialog';

/** Closing without a choice skips only this file: the job must get an answer to resume. */
const DISMISSED: ConflictAnswer = { decision: 'skip', applyToAll: false };

@Service()
export class ConflictPrompter {
  private readonly dialogs = inject(TuiDialogService);
  private readonly transloco = inject(TranslocoService);

  async ask(name: string, conflict: TransferConflict): Promise<ConflictAnswer> {
    const { ConflictDialog } = await import('./conflict-dialog/conflict-dialog');
    return firstValueFrom(
      this.dialogs.open<ConflictAnswer>(new PolymorpheusComponent(ConflictDialog), {
        label: this.transloco.translate('transfers.conflict.title'),
        size: 's',
        data: { name, conflict } satisfies ConflictDialogData,
      }),
      { defaultValue: DISMISSED },
    );
  }
}
