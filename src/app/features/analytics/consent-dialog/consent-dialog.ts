import { Component, computed, inject, type WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  type TuiDialogContext,
  TuiGroup,
  TuiLink,
  TuiNotificationService,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiBadge, TuiBlock, TuiSwitch } from '@taiga-ui/kit';
import { injectContext } from '@taiga-ui/polymorpheus';
import {
  ANALYTICS_CATEGORIES,
  Analytics,
  type AnalyticsCategory,
  type AnalyticsChoices,
} from '../../../core/ipc/analytics';
import {
  CATEGORY_COPY,
  COMMON_LEAD,
  COMMON_TEXT,
  NEVER_LEAD,
  NEVER_TEXT,
  openPrivacyPage,
} from '../privacy-page';

export interface ConsentDialogData {
  /** The switches write here, so a dismiss can save what is shown. */
  readonly choices: WritableSignal<AnalyticsChoices>;
  readonly pending: readonly AnalyticsCategory[];
}

@Component({
  imports: [
    FormsModule,
    TuiAutoFocus,
    TuiBadge,
    TuiBlock,
    TuiButton,
    TuiGroup,
    TuiLink,
    TuiSwitch,
    TuiTitle,
    TranslocoPipe,
  ],
  selector: 'app-consent-dialog',
  styleUrl: './consent-dialog.scss',
  templateUrl: './consent-dialog.html',
  host: { 'data-testid': 'consent-dialog' },
})
export class ConsentDialog {
  private readonly analytics = inject(Analytics);
  private readonly alerts = inject(TuiNotificationService);
  private readonly transloco = inject(TranslocoService);
  protected readonly context =
    injectContext<TuiDialogContext<AnalyticsChoices, ConsentDialogData>>();

  protected readonly categories = CATEGORY_COPY;
  protected readonly commonLead = COMMON_LEAD;
  protected readonly commonText = COMMON_TEXT;
  protected readonly neverLead = NEVER_LEAD;
  protected readonly neverText = NEVER_TEXT;
  protected readonly choices = this.context.data.choices;

  /** Asked again after a catalogue change rather than for the first time. */
  protected readonly reAsk = computed(() => {
    const pending = this.context.data.pending.length;
    return pending > 0 && pending < ANALYTICS_CATEGORIES.length;
  });

  protected isNew(category: AnalyticsCategory): boolean {
    return this.reAsk() && this.context.data.pending.includes(category);
  }

  protected set(category: AnalyticsCategory, granted: boolean): void {
    this.choices.update((choices) => ({ ...choices, [category]: granted }));
  }

  protected save(): void {
    this.context.completeWith(this.choices());
  }

  protected openPolicy(): void {
    openPrivacyPage(this.analytics, this.alerts, this.transloco);
  }
}
