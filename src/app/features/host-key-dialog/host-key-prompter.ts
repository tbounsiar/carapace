import { inject, Service } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { HostKeyChanged, HostKeyPrompt } from '../../core/ipc/ssh.models';
import type { HostKeyDialogData } from './host-key-dialog';

export interface HostKeyAskOptions {
  /** "Accept and test" during a connection test. */
  readonly acceptLabel?: string;
}

@Service()
export class HostKeyPrompter {
  private readonly dialogs = inject(TuiDialogService);

  /** True only on an explicit accept; any other way of closing the dialog is a reject. */
  async ask(prompt: HostKeyPrompt, options: HostKeyAskOptions = {}): Promise<boolean> {
    const { HostKeyDialog } = await import('./host-key-dialog');
    const result = await firstValueFrom(
      this.dialogs.open<boolean>(new PolymorpheusComponent(HostKeyDialog), {
        label: 'Unknown host key',
        size: 'm',
        data: {
          ...prompt,
          acceptLabel: options.acceptLabel ?? 'Accept and connect',
        } satisfies HostKeyDialogData,
      }),
      { defaultValue: false },
    );
    return result === true;
  }

  /** True only when the user explicitly chose to replace the stored key. */
  async confirmReplace(event: HostKeyChanged): Promise<boolean> {
    const { HostKeyChangedDialog } =
      await import('./host-key-changed-dialog/host-key-changed-dialog');
    const result = await firstValueFrom(
      this.dialogs.open<boolean>(new PolymorpheusComponent(HostKeyChangedDialog), {
        label: 'Host key has changed',
        size: 'm',
        data: event,
      }),
      { defaultValue: false },
    );
    return result === true;
  }
}
