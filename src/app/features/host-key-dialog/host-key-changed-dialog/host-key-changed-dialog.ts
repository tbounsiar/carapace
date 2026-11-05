import { Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, TuiNotification, type TuiDialogContext } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { HostKeyChanged } from '../../../core/ipc/ssh.models';
import { mono, type Part, translateParts } from '../../host-test/host-test-view';

@Component({
  imports: [TranslocoPipe, TuiAutoFocus, TuiButton, TuiNotification],
  selector: 'app-host-key-changed-dialog',
  styleUrl: '../host-key-dialog.scss',
  templateUrl: './host-key-changed-dialog.html',
})
export class HostKeyChangedDialog {
  protected readonly context = injectContext<TuiDialogContext<boolean, HostKeyChanged>>();
  protected readonly event = this.context.data;

  protected warning(): Part[] {
    const host = mono(`${this.event.hostname}:${this.event.port}`);
    return translateParts('hostKeyDialog.changed.warning', { host });
  }
}
