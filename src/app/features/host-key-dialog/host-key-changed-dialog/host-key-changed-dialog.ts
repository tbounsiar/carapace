import { Component } from '@angular/core';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, TuiNotification, type TuiDialogContext } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { HostKeyChanged } from '../../../core/ipc/ssh.models';

@Component({
  imports: [TuiAutoFocus, TuiButton, TuiNotification],
  selector: 'app-host-key-changed-dialog',
  styleUrl: '../host-key-dialog.scss',
  templateUrl: './host-key-changed-dialog.html',
})
export class HostKeyChangedDialog {
  protected readonly context = injectContext<TuiDialogContext<boolean, HostKeyChanged>>();
  protected readonly event = this.context.data;
}
