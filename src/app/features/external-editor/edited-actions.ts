import { inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { translate, TranslocoService } from '@jsverse/transloco';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { LanguageService } from '../../core/i18n/language';
import { ConfigService } from '../../core/ipc/config';
import { hostTarget } from '../../core/ipc/connection';
import { EditedFiles } from '../../core/ipc/edited-files';
import { MAX_EDIT_BYTES } from '../../core/ipc/editor-files';
import {
  type ConflictChoice,
  type EditedFile,
  ExternalEditsIpc,
} from '../../core/ipc/external-edits';
import { IpcError } from '../../core/ipc/ipc-error';
import { SshService } from '../../core/ipc/ssh';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { askEditorChoice } from '../editor/editor-choice';
import { HostConnector } from '../host-connection/host-connector';
import { HostLauncher } from '../host-connection/host-launcher';
import { escapeHtml } from '../../shared/path-breaks';
import { notifyError } from '../../shared/save-error';
import { blockedTypeText, hostName, nameList } from './edited-view';

/** Why "Open in built-in editor" is unavailable for a file, or null when it is available. */
export function builtInBlocker(file: EditedFile): string | null {
  if (file.notUploaded) {
    return translate('externalEditor.actions.uploadOrDiscard');
  }
  return file.size > MAX_EDIT_BYTES ? translate('externalEditor.actions.tooLargeBuiltIn') : null;
}

/** Row and page actions of the Edited files page, also used by the alerts' Review. */
@Service()
export class EditedActions {
  private readonly ipc = inject(ExternalEditsIpc);
  private readonly store = inject(EditedFiles);
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly launcher = inject(HostLauncher);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private resolving = new Set<string>();

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(`externalEditor.actions.${key}`, params);
  }

  private host(file: EditedFile) {
    return this.config.findHost(file.hostId)?.host ?? null;
  }

  private hostName(file: EditedFile): string {
    return hostName(this.config, file.hostId);
  }

  /** Upload, Retry and Upload now: connects first when needed; a conflict opens its dialog. */
  async upload(file: EditedFile): Promise<void> {
    const host = this.host(file);
    if (!host) {
      return;
    }
    const target = hostTarget(host);
    if (this.ssh.stateOf(target.connectionId) !== 'connected') {
      await this.connector.connect(target);
      if (this.ssh.stateOf(target.connectionId) !== 'connected') {
        return;
      }
    }
    try {
      const updated = await this.ipc.uploadNow(file.id);
      this.store.upsert(updated);
      if (updated.state === 'conflict') {
        await this.resolve(updated);
      }
    } catch (err) {
      notifyError(this.alerts, err, this.t('notUploaded', { name: file.name }));
    }
  }

  async reconnect(file: EditedFile): Promise<void> {
    const host = this.host(file);
    if (host) {
      await this.connector.connect(hostTarget(host));
    }
  }

  /** The conflict dialog (spec X3); Keep my copy leaves the file held. */
  async resolve(file: EditedFile): Promise<void> {
    if (this.resolving.has(file.id)) {
      return;
    }
    this.resolving.add(file.id);
    try {
      const deleted = file.conflict === 'deleted';
      const choice = await askEditorChoice(this.dialogs, {
        kind: deleted ? 'externalDeleted' : 'externalChanged',
        name: file.name,
        host: this.hostName(file),
      });
      if (choice === 'stop') {
        await this.stop(file);
      } else if (choice === 'overwrite' || choice === 'useServer') {
        await this.applyChoice(file, choice);
      }
    } finally {
      this.resolving.delete(file.id);
    }
  }

  private async applyChoice(file: EditedFile, choice: ConflictChoice): Promise<void> {
    try {
      this.store.upsert(await this.ipc.resolveConflict(file.id, choice));
    } catch (err) {
      if (err instanceof IpcError && err.code === 'blocked_type') {
        const text = blockedTypeText(file.name);
        this.alerts
          .open(text, { label: this.t('notUpdated', { name: file.name }), appearance: 'negative' })
          .subscribe();
        return;
      }
      if (!(err instanceof IpcError && err.code === 'large_file')) {
        notifyError(this.alerts, err, this.t('notUpdated', { name: file.name }));
        return;
      }
      const { confirmLargeDownload } = await import('./external-opener');
      if (!(await confirmLargeDownload(this.dialogs, file.size, this.language.locale()))) {
        return;
      }
      try {
        this.store.upsert(await this.ipc.resolveConflict(file.id, choice, true));
      } catch (again) {
        notifyError(this.alerts, again, this.t('notUpdated', { name: file.name }));
      }
    }
  }

  /** Resolves true when the file stopped being edited. */
  async stop(file: EditedFile): Promise<boolean> {
    if (file.notUploaded && !(await this.confirmStop(file))) {
      return false;
    }
    try {
      await this.ipc.stop(file.id, file.notUploaded);
    } catch (err) {
      // A save landed after the list was drawn: ask, then force.
      if (!(err instanceof IpcError && err.code === 'not_uploaded')) {
        notifyError(this.alerts, err, this.t('notStopped'));
        return false;
      }
      if (!(await this.confirmStop(file))) {
        return false;
      }
      try {
        await this.ipc.stop(file.id, true);
      } catch (again) {
        notifyError(this.alerts, again, this.t('notStopped'));
        return false;
      }
    }
    this.store.remove([file.id]);
    return true;
  }

  async stopAll(): Promise<void> {
    const files = this.store.files();
    if (!files.length) {
      return;
    }
    const pending = files.filter((f) => f.notUploaded).map((f) => f.name);
    const content = pending.length
      ? this.t('stopAllPending', { names: nameList(pending) })
      : this.t('stopAllContent');
    const confirmed = await confirmDestructive(
      this.dialogs,
      this.t('stopAllTitle', { count: files.length }),
      {
        content,
        yes: this.t('stopAll'),
        no: this.transloco.translate('common.cancel'),
      },
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.ipc.stopAll(true);
    } catch (err) {
      notifyError(this.alerts, err, this.t('notStopped'));
    }
    this.store.reset(await this.ipc.list().catch(() => []));
  }

  async discard(file: EditedFile): Promise<boolean> {
    const confirmed = await confirmDestructive(
      this.dialogs,
      this.t('discardTitle', { name: escapeHtml(file.name) }),
      {
        content: this.t('discardContent', { host: this.hostName(file) }),
        yes: this.t('discard'),
        no: this.transloco.translate('common.cancel'),
      },
    );
    if (!confirmed) {
      return false;
    }
    try {
      await this.ipc.discardRecovered(file.id);
    } catch (err) {
      notifyError(this.alerts, err, this.t('notDiscarded'));
      return false;
    }
    this.store.remove([file.id]);
    return true;
  }

  async reveal(file: EditedFile): Promise<void> {
    try {
      await this.ipc.reveal(file.id);
    } catch (err) {
      notifyError(this.alerts, err, this.t('folderNotOpened'));
    }
  }

  async openBuiltIn(file: EditedFile): Promise<void> {
    const host = this.host(file);
    if (host && !builtInBlocker(file)) {
      await this.launcher.openFile(host, file.remotePath, file.size);
    }
  }

  async reopen(file: EditedFile): Promise<void> {
    const host = this.host(file);
    if (host) {
      await this.launcher.openExternal(host, file.remotePath, file.size);
    }
  }

  /** The alerts' Review: the page, the row's action focused, and a conflict's dialog. */
  async review(id: string | null): Promise<void> {
    await this.router.navigate(['/edited-files']);
    const file = id ? this.store.find(id) : null;
    if (!file) {
      return;
    }
    this.store.focusRequest.set({ id: file.id });
    if (file.state === 'conflict') {
      await this.resolve(file);
    }
  }

  private confirmStop(file: EditedFile): Promise<boolean> {
    return confirmDestructive(this.dialogs, this.t('stopTitle', { name: escapeHtml(file.name) }), {
      content: this.t('stopContent', { host: this.hostName(file) }),
      yes: this.t('stopAndDelete'),
      no: this.transloco.translate('common.cancel'),
    });
  }
}
