import { inject, Service } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { TuiDialogService } from '@taiga-ui/core';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import type { FileEntry, FileSide } from '../../core/ipc/files';
import { NameDialog, type NameDialogData } from '../project-tree/name-dialog/name-dialog';
import { escapeHtml } from '../../shared/path-breaks';
import { fileNameValidator } from './file-path';

@Service()
export class FileDialogs {
  private readonly dialogs = inject(TuiDialogService);
  private readonly transloco = inject(TranslocoService);

  /** Opens the name dialog (Taiga renders `label` as HTML); `save` runs inside it, so name conflicts show on the field. */
  askName(
    label: string,
    side: FileSide,
    initial: string,
    save: (name: string) => Promise<unknown>,
  ): void {
    this.dialogs
      .open<void>(new PolymorpheusComponent(NameDialog), {
        label,
        size: 's',
        data: {
          noun: this.transloco.translate('files.dialogs.noun'),
          conflictMessage: this.transloco.translate('files.dialogs.nameConflict'),
          initial,
          save,
          validator: fileNameValidator(side),
          conflictCode: 'already_exists',
          trim: false,
        } satisfies NameDialogData,
      })
      .subscribe();
  }

  confirmDelete(entry: FileEntry): Promise<boolean> {
    const dir = entry.kind === 'dir';
    const t = (key: string, params?: Record<string, unknown>) =>
      this.transloco.translate(`files.dialogs.${key}`, params);
    return confirmDestructive(
      this.dialogs,
      t(dir ? 'deleteFolderTitle' : 'deleteFileTitle', { name: escapeHtml(entry.name) }),
      {
        content: t(dir ? 'deleteFolderContent' : 'deleteFileContent'),
        yes: this.transloco.translate('common.delete'),
        no: this.transloco.translate('common.cancel'),
      },
    );
  }
}
