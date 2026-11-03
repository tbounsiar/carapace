import { computed, inject, Injector, Service } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { filter, firstValueFrom } from 'rxjs';
import { Analytics } from '../../core/ipc/analytics';
import { ConfigService } from '../../core/ipc/config';
import { ThemeService } from '../../core/theme/theme';
import { OpenDialogs } from '../../shared/open-dialogs';
import { notifyError } from '../project-tree/save-error';
import { UNSAVED_DENIAL, unsavedDenial } from './privacy-page';

/** Asks for analytics consent once per launch while it is undecided. */
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

    try {
      const state = await this.analytics.state();
      if (!state.askNeeded) {
        return;
      }
    } catch {
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
    const choice = await firstValueFrom(
      this.dialogs.open<boolean>(new PolymorpheusComponent(ConsentDialog), {
        label: 'Share anonymous usage data?',
        size: 's',
        closable: false,
        dismissible: true,
      }),
      { defaultValue: false },
    );
    try {
      await this.analytics.setConsent(choice === true);
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
