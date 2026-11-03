import { inject, Service } from '@angular/core';
import { TuiNotificationService } from '@taiga-ui/core';
import { ConfigService } from '../../core/ipc/config';
import type { Host } from '../../core/ipc/config.models';
import type { ConnectionTarget } from '../../core/ipc/connection';
import { IpcError } from '../../core/ipc/ipc-error';
import { type ConnectHandlers, SshService } from '../../core/ipc/ssh';
import type { Credential, HostKeyChanged } from '../../core/ipc/ssh.models';
import type { CredentialDialogData } from '../credential-dialog/credential-dialog';
import { CredentialPrompter } from '../credential-dialog/credential-prompter';
import { HostKeyPrompter } from '../host-key-dialog/host-key-prompter';
import { notifyError } from '../project-tree/save-error';

interface Subjects {
  readonly address: string;
  readonly keyPath: string;
}

/** Connect/disconnect wired to the host key dialogs and error notifications, shared by the tree and the host page. */
@Service()
export class HostConnector {
  private readonly ssh = inject(SshService);
  private readonly prompter = inject(HostKeyPrompter);
  private readonly credentials = inject(CredentialPrompter);
  private readonly config = inject(ConfigService);
  private readonly alerts = inject(TuiNotificationService);

  async connect(target: ConnectionTarget): Promise<void> {
    const handlers: ConnectHandlers = {
      decide: (prompt) => this.prompter.ask(prompt),
      changed: (event) => void this.handleChangedKey(target.connectionId, event),
    };
    let credential: Credential | null = null;
    for (;;) {
      try {
        await (credential
          ? this.ssh.connect(target, handlers, credential)
          : this.ssh.connect(target, handlers));
        return;
      } catch (err) {
        const prompt = await this.credentialPrompt(target, err);
        if (!prompt) {
          if (!(err instanceof IpcError && err.code === 'host_key_changed')) {
            const missing = err instanceof IpcError && err.code === 'missing_variables';
            notifyError(this.alerts, err, missing ? 'Missing variables' : 'Connection failed');
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

  async disconnect(connectionId: string): Promise<void> {
    try {
      await this.ssh.disconnect(connectionId);
    } catch (err) {
      notifyError(this.alerts, err, 'Disconnect failed');
    }
  }

  private async credentialPrompt(
    target: ConnectionTarget,
    err: unknown,
  ): Promise<{ label: string; data: CredentialDialogData } | null> {
    const host = this.config.findHost(target.hostId)?.host;
    if (!host || !(err instanceof IpcError) || host.auth.kind === 'agent') {
      return null;
    }
    if (host.auth.kind === 'password') {
      if (err.code !== 'secret_required' && err.code !== 'auth_failed') {
        return null;
      }
      const { address } = await this.subjects(target, host);
      const error =
        err.code === 'auth_failed' ? 'The server rejected the password. Try again.' : null;
      return { label: 'Password', data: { kind: 'password', subject: address, error } };
    }
    if (err.code !== 'secret_required' && err.code !== 'invalid_passphrase') {
      return null;
    }
    const { keyPath } = await this.subjects(target, host);
    const error = err.code === 'invalid_passphrase' ? 'Wrong passphrase. Try again.' : null;
    return { label: 'Key passphrase', data: { kind: 'passphrase', subject: keyPath, error } };
  }

  /** What the secret unlocks, resolved in the connection's environment; the templates if that fails. */
  private async subjects(target: ConnectionTarget, host: Host): Promise<Subjects> {
    const keyPath = host.auth.kind === 'key' ? host.auth.keyPath : '';
    try {
      const r = await this.config.resolveHost(
        target.projectId,
        target.hostId,
        target.environmentId,
      );
      const address = `${r.username ?? host.username}@${r.hostname ?? host.hostname}:${r.port ?? host.port}`;
      return { address, keyPath: r.keyPath ?? keyPath };
    } catch {
      return { address: `${host.username}@${host.hostname}:${host.port}`, keyPath };
    }
  }

  private async handleChangedKey(connectionId: string, event: HostKeyChanged): Promise<void> {
    try {
      if (await this.prompter.confirmReplace(event)) {
        await this.ssh.replaceHostKey(connectionId, event.fingerprint);
        this.alerts
          .open('The stored key was replaced. Connect again to continue.', {
            label: 'Host key replaced',
            appearance: 'warning',
          })
          .subscribe();
      }
    } catch (err) {
      notifyError(this.alerts, err, 'Host key not replaced');
    }
  }
}
