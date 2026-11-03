import { inject, Service } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Credential } from '../../core/ipc/ssh.models';
import type { CredentialDialogData } from './credential-dialog';

@Service()
export class CredentialPrompter {
  private readonly dialogs = inject(TuiDialogService);

  /** Null when the dialog is closed without submitting. */
  async ask(label: string, data: CredentialDialogData): Promise<Credential | null> {
    const { CredentialDialog } = await import('./credential-dialog');
    return firstValueFrom(
      this.dialogs.open<Credential>(new PolymorpheusComponent(CredentialDialog), {
        label,
        size: 's',
        data,
      }),
      { defaultValue: null },
    );
  }
}
