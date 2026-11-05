import { inject, Service } from '@angular/core';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { hostTarget } from '../../core/ipc/connection';
import { IpcError } from '../../core/ipc/ipc-error';
import { KeyStore } from '../../core/ipc/key-store';
import type { DeployResult, KeyView } from '../../core/ipc/keys';
import { SshService } from '../../core/ipc/ssh';
import { HostConnector } from '../host-connection/host-connector';
import { NameDialog, type NameDialogData } from '../project-tree/name-dialog/name-dialog';
import { notifyError } from '../../shared/save-error';
import {
  KeyDeleteDialog,
  type KeyDeleteDecision,
  type KeyDeleteDialogData,
} from './key-delete-dialog/key-delete-dialog';
import {
  deployTargetLabel,
  KeyDeployDialog,
  type KeyDeployDialogData,
} from './key-deploy-dialog/key-deploy-dialog';
import { KeyImportDialog } from './key-import-dialog/key-import-dialog';
import { keyNameValidator } from './key-validators';
import { KeygenDialog } from './keygen-dialog/keygen-dialog';

@Service()
export class KeyActions {
  private readonly store = inject(KeyStore);
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);

  generate(): void {
    this.dialogs
      .open<KeyView>(new PolymorpheusComponent(KeygenDialog), { label: 'Generate key', size: 'm' })
      .subscribe();
  }

  import(): void {
    this.dialogs
      .open<KeyView>(new PolymorpheusComponent(KeyImportDialog), { label: 'Import key', size: 'm' })
      .subscribe();
  }

  rename(key: KeyView): void {
    const names = (): string[] => this.store.keys().map((k) => k.name);
    this.dialogs
      .open<void>(new PolymorpheusComponent(NameDialog), {
        label: 'Rename key',
        size: 's',
        data: {
          noun: 'key',
          initial: key.name,
          validator: keyNameValidator(names, key.name),
          conflictCode: 'already_exists',
          save: (name) => this.store.rename(key.id, name),
        } satisfies NameDialogData,
      })
      .subscribe();
  }

  async copyPublicKey(key: KeyView): Promise<void> {
    try {
      await navigator.clipboard.writeText(key.publicKey);
      this.alerts
        .open(key.name, { label: 'Public key copied', appearance: 'positive' })
        .subscribe();
    } catch {
      this.alerts
        .open('The clipboard is not available.', { label: 'Copy failed', appearance: 'negative' })
        .subscribe();
    }
  }

  async forgetPassphrase(key: KeyView): Promise<void> {
    try {
      await this.store.forgetPassphrase(key.id);
      this.alerts
        .open(`The passphrase of ${key.name} is no longer saved.`, {
          label: 'Passphrase forgotten',
          appearance: 'positive',
        })
        .subscribe();
    } catch (err) {
      notifyError(this.alerts, err, 'Passphrase not forgotten');
    }
  }

  /** Resolves true when the key was deleted. */
  async remove(key: KeyView): Promise<boolean> {
    const decision = await firstValueFrom(
      this.dialogs.open<KeyDeleteDecision>(new PolymorpheusComponent(KeyDeleteDialog), {
        label: `Delete key "${key.name}"?`,
        size: 's',
        data: { key } satisfies KeyDeleteDialogData,
      }),
      { defaultValue: null },
    );
    if (!decision) {
      return false;
    }
    try {
      await this.store.delete(key.id, key.origin === 'generated' && decision.deleteFiles);
      return true;
    } catch (err) {
      if (err instanceof IpcError && err.code === 'conflict') {
        this.alerts
          .open('The file at this path no longer holds this key. Nothing was deleted.', {
            label: 'Key not deleted',
            appearance: 'negative',
          })
          .subscribe();
        return false;
      }
      notifyError(this.alerts, err, 'Key not deleted');
      return false;
    }
  }

  deploy(key: KeyView): void {
    this.dialogs
      .open<void>(new PolymorpheusComponent(KeyDeployDialog), {
        label: 'Deploy public key',
        size: 's',
        data: {
          key,
          deploy: (hostId, useKey) => this.deployTo(key, hostId, useKey),
        } satisfies KeyDeployDialogData,
      })
      .subscribe();
  }

  /** Connects through the usual prompts when needed; resolves true once the key is on the host. */
  async deployTo(key: KeyView, hostId: string, useKey: boolean): Promise<boolean> {
    const location = this.config.findHost(hostId);
    if (!location) {
      this.alerts
        .open('The host no longer exists.', { label: 'Deploy failed', appearance: 'negative' })
        .subscribe();
      return false;
    }
    const { host } = location;
    const target = hostTarget(host);
    if (this.ssh.stateOf(target.connectionId) !== 'connected') {
      await this.connector.connect(target);
      if (this.ssh.stateOf(target.connectionId) !== 'connected') {
        return false;
      }
    }
    const label = deployTargetLabel(this.config.nodes(), host);
    let result: DeployResult;
    try {
      result = await this.store.deploy(target.connectionId, key.id);
    } catch (err) {
      notifyError(this.alerts, err, 'Deploy failed');
      return false;
    }
    if (result.restricted) {
      // Only lines with options (command=, restrict...) hold the key: it cannot log in normally.
      this.alerts
        .open(
          `Key present with restrictions (options) on ${label}; not changed. Edit authorized_keys by hand to allow normal logins.`,
          { label: 'Key restricted', appearance: 'warning' },
        )
        .subscribe();
      return true;
    }
    const added = result.added;
    this.alerts
      .open(
        added ? `Key added to authorized_keys on ${label}` : `Key already present on ${label}`,
        {
          label: added ? 'Key deployed' : 'Nothing to do',
          appearance: added ? 'positive' : 'info',
        },
      )
      .subscribe();
    if (useKey) {
      await this.useKeyFor(hostId, key);
    }
    return true;
  }

  private async useKeyFor(hostId: string, key: KeyView): Promise<void> {
    const host = this.config.findHost(hostId)?.host;
    if (!host) {
      return;
    }
    const { name, hostname, port, username } = host;
    try {
      await this.config.updateHost(hostId, {
        name,
        hostname,
        port,
        username,
        auth: { kind: 'key', keyPath: key.path, passphrase: null },
      });
    } catch (err) {
      notifyError(this.alerts, err, 'Host not updated');
    }
  }
}
