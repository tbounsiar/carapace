import { inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
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
import { notifyError } from '../../shared/save-error';
import { blockedTypeText, hostName, nameList } from './edited-view';

/** Why "Open in built-in editor" is unavailable for a file, or null when it is available. */
export function builtInBlocker(file: EditedFile): string | null {
  if (file.notUploaded) {
    return 'Upload or discard your changes first';
  }
  return file.size > MAX_EDIT_BYTES ? 'Too large to edit (max 5 MiB)' : null;
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
  private resolving = new Set<string>();

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
      notifyError(this.alerts, err, `${file.name} not uploaded`);
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
          .open(text, { label: `${file.name} not updated`, appearance: 'negative' })
          .subscribe();
        return;
      }
      if (!(err instanceof IpcError && err.code === 'large_file')) {
        notifyError(this.alerts, err, `${file.name} not updated`);
        return;
      }
      const { confirmLargeDownload } = await import('./external-opener');
      if (!(await confirmLargeDownload(this.dialogs, file.size))) {
        return;
      }
      try {
        this.store.upsert(await this.ipc.resolveConflict(file.id, choice, true));
      } catch (again) {
        notifyError(this.alerts, again, `${file.name} not updated`);
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
        notifyError(this.alerts, err, 'Editing not stopped');
        return false;
      }
      if (!(await this.confirmStop(file))) {
        return false;
      }
      try {
        await this.ipc.stop(file.id, true);
      } catch (again) {
        notifyError(this.alerts, again, 'Editing not stopped');
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
    const count = files.length === 1 ? '1 file' : `${files.length} files`;
    const content = pending.length
      ? `Their local copies are deleted. Not uploaded: ${nameList(pending)}.`
      : 'Their local copies are deleted.';
    const confirmed = await confirmDestructive(this.dialogs, `Stop editing ${count}?`, {
      content,
      yes: 'Stop all',
      no: 'Cancel',
    });
    if (!confirmed) {
      return;
    }
    try {
      await this.ipc.stopAll(true);
    } catch (err) {
      notifyError(this.alerts, err, 'Editing not stopped');
    }
    this.store.reset(await this.ipc.list().catch(() => []));
  }

  async discard(file: EditedFile): Promise<boolean> {
    const confirmed = await confirmDestructive(
      this.dialogs,
      `Discard your changes to ${file.name}?`,
      {
        content: `They were never uploaded to ${this.hostName(file)}.`,
        yes: 'Discard',
        no: 'Cancel',
      },
    );
    if (!confirmed) {
      return false;
    }
    try {
      await this.ipc.discardRecovered(file.id);
    } catch (err) {
      notifyError(this.alerts, err, 'Changes not discarded');
      return false;
    }
    this.store.remove([file.id]);
    return true;
  }

  async reveal(file: EditedFile): Promise<void> {
    try {
      await this.ipc.reveal(file.id);
    } catch (err) {
      notifyError(this.alerts, err, 'Folder not opened');
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
    return confirmDestructive(this.dialogs, `Stop editing ${file.name}?`, {
      content: `Your changes were not uploaded to ${this.hostName(file)} and will be deleted.`,
      yes: 'Stop and delete changes',
      no: 'Cancel',
    });
  }
}
