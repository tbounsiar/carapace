import { Component } from '@angular/core';
import { type TuiPortalContext } from '@taiga-ui/cdk';
import { TuiLink, type TuiNotificationOptions } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';

export interface AlertActionData {
  readonly text: string;
  /** "Review", "Settings". */
  readonly action: string;
  readonly testId: string;
  readonly run: () => void;
}

/** Toast content with one action link; the action closes the toast. */
@Component({
  imports: [TuiLink],
  selector: 'app-alert-action',
  styleUrl: './alert-action.scss',
  templateUrl: './alert-action.html',
})
export class AlertAction {
  protected readonly context =
    injectContext<TuiPortalContext<TuiNotificationOptions<AlertActionData>, void>>();

  protected run(): void {
    this.context.data.run();
    this.context.$implicit.complete();
  }
}
