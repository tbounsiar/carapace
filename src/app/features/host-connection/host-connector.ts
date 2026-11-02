import { inject, Service } from '@angular/core';
import { TuiNotificationService } from '@taiga-ui/core';
import { ConfigService } from '../../core/ipc/config';
import type { Host } from '../../core/ipc/config.models';
import { IpcError } from '../../core/ipc/ipc-error';
import { type ConnectHandlers, SshService } from '../../core/ipc/ssh';
import type { Credential, HostKeyChanged } from '../../core/ipc/ssh.models';
import type { CredentialDialogData } from '../credential-dialog/credential-dialog';
import { CredentialPrompter } from '../credential-dialog/credential-prompter';
import { HostKeyPrompter } from '../host-key-dialog/host-key-prompter';
import { notifyError } from '../project-tree/save-error';

/** Connect/disconnect wired to the host key dialogs and error notifications, shared by the tree and the detail view. */
@Service()
export class HostConnector {
  private readonly ssh = inject(SshService);
  private readonly prompter = inject(HostKeyPrompter);
  private readonly credentials = inject(CredentialPrompter);
  private readonly config = inject(ConfigService);
  private readonly alerts = inject(TuiNotificationService);

  async connect(hostId: string): Promise<void> {
    const handlers: ConnectHandlers = {
      decide: (prompt) => this.prompter.ask(prompt),
      changed: (event) => void this.handleChangedKey(hostId, event),
    };
    let credential: Credential | null = null;
    for (;;) {
      try {
        await (credential
          ? this.ssh.connect(hostId, handlers, credential)
          : this.ssh.connect(hostId, handlers));
        return;
      } catch (err) {
        const prompt = this.credentialPrompt(hostId, err);
        if (!prompt) {
          if (!(err instanceof IpcError && err.code === 'host_key_changed')) {
            notifyError(this.alerts, err);
          }
          return;
        }
        credential = await this.credentials.ask(prompt.label, prompt.data);
        if (!credential) {
          return;
        }
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

  private credentialPrompt(
    hostId: string,
    err: unknown,
  ): { label: string; data: CredentialDialogData } | null {
    const host = this.findHost(hostId);
    if (!host || !(err instanceof IpcError)) {
      return null;
    }
    const { auth } = host;
    if (auth.kind === 'password') {
      const label = 'Password';
      const subject = `${host.username}@${host.hostname}:${host.port}`;
      if (err.code === 'secret_required') {
        return { label, data: { kind: 'password', subject, error: null } };
      }
      if (err.code === 'auth_failed') {
        return {
          label,
          data: {
            kind: 'password',
            subject,
            error: 'The server rejected the password. Try again.',
          },
        };
      }
    } else if (auth.kind === 'key') {
      const label = 'Key passphrase';
      const subject = auth.keyPath;
      if (err.code === 'secret_required') {
        return { label, data: { kind: 'passphrase', subject, error: null } };
      }
      if (err.code === 'invalid_passphrase') {
        return {
          label,
          data: { kind: 'passphrase', subject, error: 'Wrong passphrase. Try again.' },
        };
      }
    }
    return null;
  }

  private findHost(hostId: string): Host | null {
    for (const project of this.config.projects()) {
      for (const environment of project.environments) {
        const host = environment.hosts.find((h) => h.id === hostId);
        if (host) {
          return host;
        }
      }
    }
    return null;
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
