import { Component, computed, effect, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiButton, TuiHint, TuiLabel, TuiLink, TuiNotification, TuiTitle } from '@taiga-ui/core';
import { TuiButtonLoading, TuiProgress, TuiSwitch } from '@taiga-ui/kit';
import { LanguageService } from '../../../core/i18n/language';
import { uiText } from '../../../shared/ui-text';
import { UpdateFlow } from '../../updates/update-flow';
import { UpdateStore } from '../../updates/update-store';
import { failureView, impactLines, progressText } from '../../updates/update-text';

/** "14:03" today, "Nov 3, 14:03" another day, in the UI language. */
export function lastCheckedText(iso: string, locale: string, now = new Date()): string {
  const when = new Date(iso);
  const today = when.toDateString() === now.toDateString();
  const format = new Intl.DateTimeFormat(
    locale,
    today
      ? { timeStyle: 'short' }
      : { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
  );
  return format.format(when);
}

/** Settings > Updates: every action of the notice, so the flow works without the portal. */
@Component({
  imports: [
    ReactiveFormsModule,
    TranslocoPipe,
    TuiButton,
    TuiButtonLoading,
    TuiHint,
    TuiLabel,
    TuiLink,
    TuiNotification,
    TuiProgress,
    TuiSwitch,
    TuiTitle,
  ],
  selector: 'app-update-settings',
  styleUrl: './update-settings.scss',
  templateUrl: './update-settings.html',
})
export class UpdateSettings {
  protected readonly store = inject(UpdateStore);
  protected readonly flow = inject(UpdateFlow);
  private readonly language = inject(LanguageService);

  protected readonly autoControl = new FormControl(
    { value: false, disabled: true },
    { nonNullable: true },
  );
  protected readonly checking = computed(() => this.store.check() === 'checking');
  /** Why Check now does nothing; null when it can run. */
  protected readonly checkBlocker = computed(() => {
    if (this.store.unsupported()) {
      return uiText('settings.updates.unavailable');
    }
    return this.store.busy() ? uiText('settings.updates.busy') : null;
  });
  protected readonly statusState = computed(() => {
    const check = this.store.check();
    return check === 'upToDate' && this.store.offer() ? 'idle' : check;
  });
  protected readonly lastChecked = computed(() => {
    const iso = this.store.state()?.lastCheck;
    return iso ? lastCheckedText(iso, this.language.locale()) : null;
  });
  protected readonly failure = computed(() => {
    const failure = this.store.failure();
    return failure ? { kind: failure.kind, ...failureView(failure) } : null;
  });
  /** A signature refusal replaces the offer; a download error keeps it below (its Update retries). */
  protected readonly showOffer = computed(
    () => this.store.offer() !== null && this.store.failure()?.kind !== 'signature',
  );
  protected readonly progressText = computed(() =>
    progressText(this.store.progress(), this.language.locale()),
  );
  protected readonly impact = computed(() => impactLines(this.flow.impact()));
  protected readonly installingText = this.flow.windows
    ? 'updates.notice.installingWindows'
    : 'updates.notice.installingOther';

  constructor() {
    void this.flow.start();
    effect(() => {
      const state = this.store.state();
      if (state) {
        this.autoControl.enable({ emitEvent: false });
        this.autoControl.setValue(state.autoCheck, { emitEvent: false });
      }
    });
    this.autoControl.valueChanges.pipe(takeUntilDestroyed()).subscribe((enabled) => {
      void this.flow.setAutoCheck(enabled).then((saved) => {
        if (!saved) {
          this.autoControl.setValue(this.store.state()?.autoCheck ?? !enabled, {
            emitEvent: false,
          });
        }
      });
    });
  }

  protected checkNow(): void {
    if (!this.checkBlocker()) {
      void this.flow.check();
    }
  }
}
