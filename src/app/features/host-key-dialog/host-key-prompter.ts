import { inject, Service } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
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
  private readonly transloco = inject(TranslocoService);

  /** True only on an explicit accept; any other way of closing the dialog is a reject. */
  async ask(prompt: HostKeyPrompt, options: HostKeyAskOptions = {}): Promise<boolean> {
    const { HostKeyDialog } = await import('./host-key-dialog');
    const result = await firstValueFrom(
      this.dialogs.open<boolean>(new PolymorpheusComponent(HostKeyDialog), {
        label: this.transloco.translate('hostKeyDialog.unknown.title'),
        size: 'm',
        data: {
          ...prompt,
          acceptLabel:
            options.acceptLabel ?? this.transloco.translate('hostKeyDialog.unknown.acceptConnect'),
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
        label: this.transloco.translate('hostKeyDialog.changed.title'),
        size: 'm',
        data: event,
      }),
      { defaultValue: false },
    );
    return result === true;
  }
}
