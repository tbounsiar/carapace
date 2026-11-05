import { inject, Service } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
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
import { escapeHtml } from '../../shared/path-breaks';
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
  private readonly transloco = inject(TranslocoService);

  private t(key: string, params?: Record<string, string>): string {
    return this.transloco.translate(`keys.${key}`, params);
  }

  generate(): void {
    this.dialogs
      .open<KeyView>(new PolymorpheusComponent(KeygenDialog), {
        label: this.t('page.generate'),
        size: 'm',
      })
      .subscribe();
  }

  import(): void {
    this.dialogs
      .open<KeyView>(new PolymorpheusComponent(KeyImportDialog), {
        label: this.t('page.import'),
        size: 'm',
      })
      .subscribe();
  }

  rename(key: KeyView): void {
    const names = (): string[] => this.store.keys().map((k) => k.name);
    this.dialogs
      .open<void>(new PolymorpheusComponent(NameDialog), {
        label: this.t('actions.renameTitle'),
        size: 's',
        data: {
          noun: 'key',
          initial: key.name,
          validator: keyNameValidator(names, key.name),
          conflictCode: 'already_exists',
          conflictMessage: this.t('validation.nameTaken'),
          save: (name) => this.store.rename(key.id, name),
        } satisfies NameDialogData,
      })
      .subscribe();
  }

  async copyPublicKey(key: KeyView): Promise<void> {
    try {
      await navigator.clipboard.writeText(key.publicKey);
      this.alerts
        .open(key.name, { label: this.t('actions.copied'), appearance: 'positive' })
        .subscribe();
    } catch {
      this.alerts
        .open(this.t('actions.noClipboard'), {
          label: this.t('actions.copyFailed'),
          appearance: 'negative',
        })
        .subscribe();
    }
  }

  async forgetPassphrase(key: KeyView): Promise<void> {
    try {
      await this.store.forgetPassphrase(key.id);
      this.alerts
        .open(this.t('actions.forgottenText', { name: key.name }), {
          label: this.t('actions.forgotten'),
          appearance: 'positive',
        })
        .subscribe();
    } catch (err) {
      notifyError(this.alerts, err, this.t('actions.notForgotten'));
    }
  }

  /** Resolves true when the key was deleted. */
  async remove(key: KeyView): Promise<boolean> {
    const decision = await firstValueFrom(
      this.dialogs.open<KeyDeleteDecision>(new PolymorpheusComponent(KeyDeleteDialog), {
        // Taiga renders a dialog label as HTML.
        label: this.t('actions.deleteTitle', { name: escapeHtml(key.name) }),
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
          .open(this.t('actions.deleteConflict'), {
            label: this.t('actions.notDeleted'),
            appearance: 'negative',
          })
          .subscribe();
        return false;
      }
      notifyError(this.alerts, err, this.t('actions.notDeleted'));
      return false;
    }
  }

  deploy(key: KeyView): void {
    this.dialogs
      .open<void>(new PolymorpheusComponent(KeyDeployDialog), {
        label: this.t('actions.deployTitle'),
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
        .open(this.t('actions.hostGone'), {
          label: this.t('actions.deployFailed'),
          appearance: 'negative',
        })
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
      notifyError(this.alerts, err, this.t('actions.deployFailed'));
      return false;
    }
    if (result.restricted) {
      // Only lines with options (command=, restrict...) hold the key: it cannot log in normally.
      this.alerts
        .open(this.t('actions.restrictedText', { host: label }), {
          label: this.t('actions.restricted'),
          appearance: 'warning',
        })
        .subscribe();
      return true;
    }
    const added = result.added;
    this.alerts
      .open(this.t(added ? 'actions.deployedText' : 'actions.presentText', { host: label }), {
        label: this.t(added ? 'actions.deployed' : 'actions.nothingToDo'),
        appearance: added ? 'positive' : 'info',
      })
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
      notifyError(this.alerts, err, this.t('actions.hostNotUpdated'));
    }
  }
}
