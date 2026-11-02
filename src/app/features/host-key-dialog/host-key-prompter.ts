import { inject, Service } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { HostKeyChanged, HostKeyPrompt } from '../../core/ipc/ssh.models';
import { HostKeyChangedDialog } from './host-key-changed-dialog/host-key-changed-dialog';
import { HostKeyDialog } from './host-key-dialog';

@Service()
export class HostKeyPrompter {
  private readonly dialogs = inject(TuiDialogService);

  /** True only on an explicit accept; any other way of closing the dialog is a reject. */
  async ask(prompt: HostKeyPrompt): Promise<boolean> {
    const result = await firstValueFrom(
      this.dialogs.open<boolean>(new PolymorpheusComponent(HostKeyDialog), {
        label: 'Unknown host key',
        size: 'm',
        data: prompt,
      }),
      { defaultValue: false },
    );
    return result === true;
  }

  /** True only when the user explicitly chose to replace the stored key. */
  async confirmReplace(event: HostKeyChanged): Promise<boolean> {
    const result = await firstValueFrom(
      this.dialogs.open<boolean>(new PolymorpheusComponent(HostKeyChangedDialog), {
        label: 'Host key has changed',
        size: 'm',
        appearance: 'negative',
        data: event,
      }),
      { defaultValue: false },
    );
    return result === true;
  }
}
