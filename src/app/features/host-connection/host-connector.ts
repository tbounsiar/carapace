import { inject, Service } from '@angular/core';
import { TuiNotificationService } from '@taiga-ui/core';
import { IpcError } from '../../core/ipc/ipc-error';
import { SshService } from '../../core/ipc/ssh';
import type { HostKeyChanged } from '../../core/ipc/ssh.models';
import { HostKeyPrompter } from '../host-key-dialog/host-key-prompter';
import { notifyError } from '../project-tree/save-error';

/** Connect/disconnect wired to the host key dialogs and error notifications, shared by the tree and the detail view. */
@Service()
export class HostConnector {
  private readonly ssh = inject(SshService);
  private readonly prompter = inject(HostKeyPrompter);
  private readonly alerts = inject(TuiNotificationService);

  async connect(hostId: string): Promise<void> {
    try {
      await this.ssh.connect(hostId, {
        decide: (prompt) => this.prompter.ask(prompt),
        changed: (event) => void this.handleChangedKey(hostId, event),
      });
    } catch (err) {
      if (!(err instanceof IpcError && err.code === 'host_key_changed')) {
        notifyError(this.alerts, err);
      }
    }
  }

  async disconnect(hostId: string): Promise<void> {
    try {
      await this.ssh.disconnect(hostId);
    } catch (err) {
      notifyError(this.alerts, err);
    }
  }

  private async handleChangedKey(hostId: string, event: HostKeyChanged): Promise<void> {
    try {
      if (await this.prompter.confirmReplace(event)) {
        await this.ssh.replaceHostKey(hostId, event.fingerprint);
        this.alerts
          .open('The stored key was replaced. Connect again to continue.', {
            label: 'Host key replaced',
            appearance: 'warning',
          })
          .subscribe();
      }
    } catch (err) {
      notifyError(this.alerts, err);
    }
  }
}
