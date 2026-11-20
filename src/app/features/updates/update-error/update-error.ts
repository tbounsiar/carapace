import { Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { type TuiPortalContext } from '@taiga-ui/cdk';
import { TuiButton, type TuiNotificationOptions } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { UpdateFailureKind } from '../update-store';

export interface UpdateErrorData {
  readonly kind: UpdateFailureKind;
  readonly text: string;
  /** Retry (download) or the release page (install); none for a refusal. */
  readonly action: 'retry' | 'releasePage' | null;
  readonly run: () => void;
}

/** Body of an update error notice; the title is the notification label. */
@Component({
  imports: [TranslocoPipe, TuiButton],
  selector: 'app-update-error',
  styleUrl: './update-error.scss',
  templateUrl: './update-error.html',
  host: { 'data-testid': 'update-error', '[attr.data-kind]': 'context.data.kind' },
})
export class UpdateError {
  protected readonly context =
    injectContext<TuiPortalContext<TuiNotificationOptions<UpdateErrorData>, void>>();
}
