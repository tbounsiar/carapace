import { inject, Service } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import type { FileEntry, FileSide } from '../../core/ipc/files';
import { NameDialog, type NameDialogData } from '../project-tree/name-dialog/name-dialog';
import { fileNameValidator } from './file-path';

@Service()
export class FileDialogs {
  private readonly dialogs = inject(TuiDialogService);

  /** Opens the name dialog; `save` runs inside it, so name conflicts show on the field. */
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
          noun: 'file or folder',
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
    return confirmDestructive(this.dialogs, `Delete ${dir ? 'folder' : 'file'} "${entry.name}"?`, {
      content: dir
        ? 'The folder and everything inside it will be deleted. This cannot be undone.'
        : 'The file will be deleted. This cannot be undone.',
      yes: 'Delete',
      no: 'Cancel',
    });
  }
}
