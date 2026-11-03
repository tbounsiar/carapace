import { Component, inject } from '@angular/core';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  type TuiDialogContext,
  TuiLink,
  TuiNotificationService,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiList } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { Analytics } from '../../../core/ipc/analytics';
import { openPrivacyPage } from '../privacy-page';

@Component({
  imports: [TuiAutoFocus, TuiButton, TuiLink, TuiList, TuiTitle],
  selector: 'app-consent-dialog',
  styleUrl: './consent-dialog.scss',
  templateUrl: './consent-dialog.html',
  host: { 'data-testid': 'consent-dialog' },
})
export class ConsentDialog {
  private readonly analytics = inject(Analytics);
  private readonly alerts = inject(TuiNotificationService);
  protected readonly context = injectContext<TuiDialogContext<boolean>>();

  protected openPolicy(): void {
    openPrivacyPage(this.analytics, this.alerts);
  }
}
