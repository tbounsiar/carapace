import { inject, Service, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { defer, firstValueFrom, of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import {
  type DataScope,
  DataTransferIpc,
  type ExportResult,
  type ImportPlan,
} from '../../core/ipc/data-transfer';
import { EditedFiles } from '../../core/ipc/edited-files';
import { IpcError } from '../../core/ipc/ipc-error';
import { KeyStore } from '../../core/ipc/key-store';
import { CurrentScope } from '../../shared/current-scope';
import { notifyError } from '../../shared/save-error';
import { deleteLines } from '../external-editor/edited-view';
import { Workspace } from '../workspace/workspace';
import type { ExportDialogData } from './export-dialog/export-dialog';
import type { ImportDialogData, ImportStart } from './import-dialog/import-dialog';
import { exportCountsText, PICKER_BUSY } from './import-view';

/** Export and import flows (spec `import-export.md`); every entry point goes through here. */
@Service()
export class DataTransferActions {
  private readonly ipc = inject(DataTransferIpc);
  private readonly config = inject(ConfigService);
  private readonly keys = inject(KeyStore);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly router = inject(Router);
  private readonly scope = inject(CurrentScope);
  private readonly workspace = inject(Workspace);
  private readonly edited = inject(EditedFiles);

  private readonly _importing = signal(false);
  /** The open picker or the file check started by an Import button. */
  readonly importing = this._importing.asReadonly();

  async exportData(preset: DataScope = { kind: 'all' }): Promise<void> {
    const { ExportDialog } = await import('./export-dialog/export-dialog');
    const busy = signal(false);
    const allowClose = defer(() => of(!busy()));
    const result = await firstValueFrom(
      this.dialogs.open<ExportResult | undefined>(new PolymorpheusComponent(ExportDialog), {
        label: 'Export data',
        size: 'm',
        closable: allowClose,
        dismissible: allowClose,
        data: { preset, busy } satisfies ExportDialogData,
      }),
      { defaultValue: undefined },
    );
    if (result) {
      this.alerts
        .open(exportCountsText(result.counts), {
          label: `Exported to ${result.fileName}`,
          appearance: 'positive',
        })
        .subscribe();
    }
  }

  async importData(): Promise<void> {
    if (this._importing()) {
      return;
    }
    this._importing.set(true);
    let start: ImportStart | null;
    try {
      start = await this.pick();
    } finally {
      this._importing.set(false);
    }
    if (start) {
      await this.openImport(start);
    }
  }

  /** Null when the picker was cancelled or another one is open (that one is notified). */
  private async pick(): Promise<ImportStart | null> {
    try {
      const preview = await this.ipc.previewImport();
      return preview ? { kind: 'preview', preview } : null;
    } catch (err) {
      if (err instanceof IpcError && err.code === 'busy') {
        this.alerts.open(PICKER_BUSY, { appearance: 'warning' }).subscribe();
        return null;
      }
      return { kind: 'error', error: err };
    }
  }

  private async openImport(start: ImportStart): Promise<void> {
    const { ImportDialog } = await import('./import-dialog/import-dialog');
    const busy = signal(false);
    const allowClose = defer(() => of(!busy()));
    const removed = new Set<string>();
    const data: ImportDialogData = {
      start,
      busy,
      pick: () => this.ipc.previewImport(),
      workspaceLines: (plan) => this.workspaceLines(plan),
      changed: async (plan) => {
        plan?.removedHostIds.forEach((id) => removed.add(id));
        await this.reload();
      },
    };
    const route = await firstValueFrom(
      this.dialogs.open<readonly string[] | undefined>(new PolymorpheusComponent(ImportDialog), {
        label: 'Import data',
        size: 'm',
        closable: allowClose,
        dismissible: allowClose,
        data,
      }),
      { defaultValue: undefined },
    );
    await this.leaveMissing(removed);
    if (route) {
      await this.router.navigate([...route]);
    }
  }

  /** " 2 open tabs will be closed. ..." for the hosts a plan removes, as for a delete. */
  private workspaceLines(plan: ImportPlan): string {
    const ids = new Set(plan.removedHostIds);
    if (!ids.size) {
      return '';
    }
    const tabs = this.workspace.tabs().filter((t) => ids.has(t.hostId));
    let text = '';
    if (tabs.length) {
      const count = tabs.length === 1 ? '1 open tab' : `${tabs.length} open tabs`;
      const modified = tabs.filter((t) => t.modified()).map((t) => t.label);
      const lost = modified.length
        ? ` Unsaved changes in ${modified.join(', ')} will be lost.`
        : '';
      text = ` ${count} will be closed.${lost}`;
    }
    return text + deleteLines(this.edited.files().filter((f) => ids.has(f.hostId)));
  }

  private async reload(): Promise<void> {
    try {
      await this.config.load();
    } catch (err) {
      notifyError(this.alerts, err, 'Data not reloaded');
    }
    if (this.keys.loaded()) {
      await this.keys.load().catch(() => undefined);
    }
  }

  /** After the dialog: the open page or tabs of hosts that are gone go away, as after a delete. */
  private async leaveMissing(removed: ReadonlySet<string>): Promise<void> {
    const gone = new Set([...removed].filter((id) => !this.config.findHost(id)));
    const hostId = this.scope.hostId();
    const route = this.scope.route();
    if (hostId && !this.config.findHost(hostId)) {
      const projectId = this.scope.projectId();
      await this.router.navigate(
        projectId && this.config.findProject(projectId) ? ['/projects', projectId] : ['/'],
      );
    } else if (route.kind === 'project' && !this.config.findProject(route.projectId)) {
      await this.router.navigate(['/']);
    }
    if (!gone.size) {
      return;
    }
    this.edited.remove(
      this.edited
        .files()
        .filter((f) => gone.has(f.hostId))
        .map((f) => f.id),
    );
    const tabs = this.workspace.tabs().filter((t) => gone.has(t.hostId));
    if (tabs.length) {
      this.workspace.drop(tabs.map((t) => t.id));
    }
  }
}
