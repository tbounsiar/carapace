import { inject, Service } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { HostKeyChanged, HostKeyPrompt } from '../../core/ipc/ssh.models';

@Service()
export class HostKeyPrompter {
  private readonly dialogs = inject(TuiDialogService);

  /** True only on an explicit accept; any other way of closing the dialog is a reject. */
  async ask(prompt: HostKeyPrompt): Promise<boolean> {
    const { HostKeyDialog } = await import('./host-key-dialog');
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
