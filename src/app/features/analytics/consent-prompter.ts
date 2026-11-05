import { computed, inject, Injector, Service, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { defer, filter, firstValueFrom, of } from 'rxjs';
import { Analytics, type AnalyticsChoices, type AnalyticsState } from '../../core/ipc/analytics';
import { ConfigService } from '../../core/ipc/config';
import { ThemeService } from '../../core/theme/theme';
import { OpenDialogs } from '../../shared/open-dialogs';
import { notifyError } from '../../shared/save-error';
import { initialChoices, UNSAVED_DENIAL, unsavedDenial } from './privacy-page';

/** Asks for the analytics choices once per launch while a category is undecided. */
@Service()
export class ConsentPrompter {
  private readonly analytics = inject(Analytics);
  private readonly config = inject(ConfigService);
  private readonly dialogs = inject(OpenDialogs);
  private readonly alerts = inject(TuiNotificationService);
  private readonly theme = inject(ThemeService);
  private readonly injector = inject(Injector);
  private started = false;

  private readonly ready = computed(() => this.config.loaded() && this.dialogs.none());

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.analytics.appStarted(this.theme.mode()).catch(() => undefined);

    let state: AnalyticsState;
    try {
      state = await this.analytics.state();
    } catch {
      return;
    }
    if (!state.askNeeded) {
      return;
    }

    const { ConsentDialog } = await import('./consent-dialog/consent-dialog');
    // Never stacks on another dialog: re-checked right before opening, since one can open
    // between the signal turning true and this continuation running.
    while (!this.ready()) {
      await firstValueFrom(
        toObservable(this.ready, { injector: this.injector }).pipe(filter(Boolean)),
      );
    }
    const choices = signal<AnalyticsChoices>(initialChoices(state));
    let dismissed = false;
    // Taiga completes without a value both for a user dismissal (Escape, backdrop, close request)
    // and for programmatic closes (TUI_DIALOGS_CLOSE fires on every router ActivationStart).
    // Only the first kind goes through `dismissible`, so that is where the user action is
    // recorded; any other close saves nothing and the categories stay pending.
    const dismiss = defer(() => {
      dismissed = true;
      return of(true);
    });
    const chosen = await firstValueFrom(
      this.dialogs.open<AnalyticsChoices>(new PolymorpheusComponent(ConsentDialog), {
        label: 'Anonymous usage data',
        size: 'm',
        closable: false,
        dismissible: dismiss,
        data: { choices, pending: state.pending },
      }),
      { defaultValue: undefined },
    );
    const saving = chosen ?? (dismissed ? choices() : null);
    if (!saving) {
      return;
    }
    try {
      await this.analytics.setChoices(saving);
    } catch (err) {
      if (!unsavedDenial(this.analytics.current())) {
        notifyError(this.alerts, err, 'Setting not saved');
      }
    }
    if (unsavedDenial(this.analytics.current())) {
      this.alerts
        .open(UNSAVED_DENIAL, { label: 'Setting not saved', appearance: 'warning' })
        .subscribe();
    }
  }
}
