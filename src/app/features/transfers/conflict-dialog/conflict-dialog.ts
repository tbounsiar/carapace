import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, TuiCheckbox, TuiNotification, type TuiDialogContext } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import { LanguageService } from '../../../core/i18n/language';
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

/** Stands for the file name, so the translated sentence can wrap the name in its own element. */
const NAME_MARK = '';

@Component({
  imports: [
    ReactiveFormsModule,
    TranslocoPipe,
    TuiAutoFocus,
    TuiButton,
    TuiCheckbox,
    TuiNotification,
  ],
  selector: 'app-conflict-dialog',
  styleUrl: './conflict-dialog.scss',
  templateUrl: './conflict-dialog.html',
})
export class ConflictDialog {
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly translation = toSignal(this.transloco.selectTranslation());

  protected readonly context =
    injectContext<TuiDialogContext<ConflictAnswer, ConflictDialogData>>();
  protected readonly conflict = this.context.data.conflict;
  protected readonly name = this.context.data.name;
  protected readonly applyToAll = new FormControl(false, { nonNullable: true });
  protected readonly existsParts = computed(() => {
    this.translation();
    const text = this.transloco.translate('transfers.conflict.exists', { name: NAME_MARK });
    const [before, ...after] = text.split(NAME_MARK);
    return [before, after.join('')];
  });
  protected readonly existing = computed(() =>
    this.describe(this.conflict.existingSize, this.conflict.existingModified),
  );
  protected readonly incoming = computed(() =>
    this.describe(this.conflict.incomingSize, this.conflict.incomingModified),
  );

  protected answer(decision: ConflictDecision): void {
    this.context.completeWith({ decision, applyToAll: this.applyToAll.value });
  }

  private describe(size: number | null, modified: number | null): string {
    this.translation();
    const locale = this.language.locale();
    return (
      [formatSize(size, locale), formatModified(modified, locale)].filter(Boolean).join(' · ') ||
      this.transloco.translate('transfers.conflict.unknown')
    );
  }
}
