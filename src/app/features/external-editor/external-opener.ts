import { inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Host } from '../../core/ipc/config.models';
import { hostTarget } from '../../core/ipc/connection';
import { EditedFiles } from '../../core/ipc/edited-files';
import { ExternalEditsIpc, MAX_EXTERNAL_BYTES } from '../../core/ipc/external-edits';
import { IpcError } from '../../core/ipc/ipc-error';
import { AlertAction, type AlertActionData } from '../../shared/alert-action/alert-action';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { formatSize } from '../files/file-list';
import { errorText, notifyError } from '../project-tree/save-error';
import { tabKey, Workspace } from '../workspace/workspace';
import { blockedTypeText } from './edited-view';
import type { ExternalNoticeAnswer } from './external-notice-dialog/external-notice-dialog';

const FAILED = 'File not opened';

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** The size in a `large_file` message, when the listing had none. */
function sizeOf(err: IpcError, listed: number | null): number | null {
  if (listed !== null) {
    return listed;
  }
  const match = /(\d+) bytes/.exec(err.message);
  return match ? Number(match[1]) : null;
}

/** "Download 120 MiB to edit it?", before a copy over 20 MiB is downloaded. */
export function confirmLargeDownload(
  dialogs: TuiDialogService,
  size: number | null,
): Promise<boolean> {
  const what = size === null ? 'this file' : formatSize(size);
  return confirmDestructive(dialogs, `Download ${what} to edit it?`, {
    content: 'Each save in your editor uploads the whole file again.',
    yes: 'Download',
    no: 'Cancel',
    appearance: 'primary',
    yesTestId: 'ext-large-download',
    focusYes: true,
  });
}

/** Opens a remote file in the external editor (spec X1): notice, confirms, refusals. */
@Service()
export class ExternalOpener {
  private readonly ipc = inject(ExternalEditsIpc);
  private readonly store = inject(EditedFiles);
  private readonly workspace = inject(Workspace);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly router = inject(Router);

  /** Resolves true when the editor was launched; `size` comes from the listing. */
  async open(host: Host, path: string, size: number | null): Promise<boolean> {
    const name = baseName(path);
    if (size !== null && size > MAX_EXTERNAL_BYTES) {
      this.fail(`${name} is too large to edit (${formatSize(size)}, max 1 GiB).`);
      return false;
    }
    if (this.workspace.byKey(tabKey('edit', host.id, path))?.modified()) {
      this.fail(`Save or close ${name} in Carapace first.`);
      return false;
    }
    if (!this.store.findByPath(host.id, path) && !(await this.noticeAccepted())) {
      return false;
    }
    let confirmLarge = false;
    let confirmSensitive = false;
    for (;;) {
      try {
        const file = await this.ipc.open({
          connectionId: hostTarget(host).connectionId,
          path,
          size,
          confirmLarge,
          confirmSensitive,
        });
        this.store.upsert(file);
        return true;
      } catch (err) {
        if (err instanceof IpcError && err.code === 'sensitive' && !confirmSensitive) {
          if (!(await this.confirmSensitive(name))) {
            return false;
          }
          confirmSensitive = true;
        } else if (err instanceof IpcError && err.code === 'large_file' && !confirmLarge) {
          if (!(await this.confirmLarge(sizeOf(err, size)))) {
            return false;
          }
          confirmLarge = true;
        } else {
          this.refused(err, name, host.name, size);
          return false;
        }
      }
    }
  }

  private async noticeAccepted(): Promise<boolean> {
    const setting = await this.ipc.getEditor().catch(() => null);
    if (setting?.noticeSeen) {
      return true;
    }
    const { ExternalNoticeDialog } =
      await import('./external-notice-dialog/external-notice-dialog');
    const answer = await firstValueFrom(
      this.dialogs.open<ExternalNoticeAnswer>(new PolymorpheusComponent(ExternalNoticeDialog), {
        label: 'Before you edit outside Carapace',
        size: 's',
      }),
      { defaultValue: null },
    );
    if (!answer) {
      return false;
    }
    if (answer.dontShow && setting) {
      await this.ipc
        .setEditor({ ...setting, noticeSeen: true })
        .catch((err: unknown) => notifyError(this.alerts, err, 'Setting not saved'));
    }
    return true;
  }

  private confirmSensitive(name: string): Promise<boolean> {
    return confirmDestructive(this.dialogs, 'Copy a file that may hold secrets?', {
      content: `${name} may hold keys, passwords or tokens. While you edit it, a copy is stored in clear text on this computer (only your account can read it).`,
      yes: 'Open anyway',
      no: 'Cancel',
      appearance: 'primary',
      yesTestId: 'ext-sensitive-confirm',
      warning: true,
    });
  }

  private confirmLarge(size: number | null): Promise<boolean> {
    return confirmLargeDownload(this.dialogs, size);
  }

  private refused(err: unknown, name: string, host: string, size: number | null): void {
    if (!(err instanceof IpcError)) {
      this.fail(errorText(err));
      return;
    }
    switch (err.code) {
      case 'too_large':
        this.fail(
          size === null
            ? `${name} is too large to edit (max 1 GiB).`
            : `${name} is too large to edit (${formatSize(size)}, max 1 GiB).`,
        );
        return;
      case 'permission_denied':
        this.fail(`You don't have permission to read ${name} on ${host}.`);
        return;
      case 'blocked_type':
        this.failWithSettings(blockedTypeText(name));
        return;
      case 'app_not_found': {
        const app = err.message.split(': ').slice(1).join(': ').trim();
        this.failWithSettings(
          `The editor app was not found${app ? `: ${app}` : ''}. Choose it again in Settings.`,
        );
        return;
      }
      case 'app_not_editor':
        this.failWithSettings(
          'The editor app runs files instead of editing them. Choose an editor in Settings.',
        );
        return;
      case 'app_failed':
        this.fail('The editor app could not be started.');
        return;
      default:
        this.fail(errorText(err));
    }
  }

  private fail(message: string): void {
    this.alerts.open(message, { label: FAILED, appearance: 'negative' }).subscribe();
  }

  private failWithSettings(text: string): void {
    this.alerts
      .open(new PolymorpheusComponent(AlertAction), {
        label: FAILED,
        appearance: 'negative',
        data: {
          text,
          action: 'Settings',
          testId: 'ext-open-settings',
          run: () => void this.router.navigate(['/settings']),
        } satisfies AlertActionData,
      })
      .subscribe();
  }
}
