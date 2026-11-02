import { Component } from '@angular/core';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, TuiNotification, type TuiDialogContext } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { HostKeyPrompt } from '../../core/ipc/ssh.models';

@Component({
  imports: [TuiAutoFocus, TuiButton, TuiNotification],
  selector: 'app-host-key-dialog',
  styleUrl: './host-key-dialog.scss',
  templateUrl: './host-key-dialog.html',
})
export class HostKeyDialog {
  protected readonly context = injectContext<TuiDialogContext<boolean, HostKeyPrompt>>();
  protected readonly prompt = this.context.data;
}
