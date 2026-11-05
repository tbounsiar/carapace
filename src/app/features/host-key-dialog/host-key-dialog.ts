import { Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, TuiNotification, type TuiDialogContext } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import type { HostKeyPrompt } from '../../core/ipc/ssh.models';
import { mono, type Part, translateParts } from '../host-test/host-test-view';

export interface HostKeyDialogData extends HostKeyPrompt {
  readonly acceptLabel: string;
}

@Component({
  imports: [TranslocoPipe, TuiAutoFocus, TuiButton, TuiNotification],
  selector: 'app-host-key-dialog',
  styleUrl: './host-key-dialog.scss',
  templateUrl: './host-key-dialog.html',
})
export class HostKeyDialog {
  protected readonly context = injectContext<TuiDialogContext<boolean, HostKeyDialogData>>();
  protected readonly prompt = this.context.data;

  protected warning(): Part[] {
    const host = mono(`${this.prompt.hostname}:${this.prompt.port}`);
    return translateParts('hostKeyDialog.unknown.warning', { host });
  }
}
