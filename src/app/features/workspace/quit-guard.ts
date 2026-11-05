import { computed, effect, inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { TuiDialogService } from '@taiga-ui/core';
import { AppEvents } from '../../core/ipc/app-events';
import { ConfigService } from '../../core/ipc/config';
import { type EditedFile, ExternalEditsIpc } from '../../core/ipc/external-edits';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { uiText } from '../../shared/ui-text';
import { notUploadedNames } from '../external-editor/edited-view';
import { unsavedNames } from './tab-titles';
import { Workspace } from './workspace';

/**
 * Holds the window open while an editor has unsaved changes, and asks before quitting. The backend
 * also asks here whenever an externally edited file is not uploaded, guard or not.
 */
@Service()
export class QuitGuard {
  private readonly workspace = inject(Workspace);
  private readonly events = inject(AppEvents);
  private readonly dialogs = inject(TuiDialogService);
  private readonly config = inject(ConfigService);
  private readonly external = inject(ExternalEditsIpc);
  private readonly router = inject(Router);
  private readonly modified = computed(() => this.workspace.tabs().filter((t) => t.modified()));
  private readonly active = computed(() => this.modified().length > 0);
  private asking = false;
  private started = false;

  constructor() {
    let sent: boolean | null = null;
    effect(() => {
      const active = this.active();
      if (active !== sent && (sent !== null || active)) {
        sent = active;
        this.events.setQuitGuard(active).catch(() => {
          sent = null;
        });
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    try {
      await this.events.subscribe((event) => {
        if (event.kind === 'quitRequested') {
          void this.onQuitRequested();
        }
      });
    } catch {
      this.started = false;
    }
  }

  private async onQuitRequested(): Promise<void> {
    if (this.asking) {
      return;
    }
    this.asking = true;
    try {
      const modified = this.modified();
      const pending = await this.notUploaded();
      if (!modified.length && !pending.length) {
        await this.events.quit();
        return;
      }
      const hostName = (id: string) =>
        this.config.findHost(id)?.host.name ?? uiText('workspace.tab.unknownHost');
      const lines = [
        modified.length
          ? uiText('workspace.unsaved.quitUnsaved', { names: unsavedNames(modified, hostName) })
          : '',
        pending.length
          ? uiText('workspace.unsaved.quitNotUploaded', {
              names: notUploadedNames(pending, hostName),
            })
          : '',
      ].filter(Boolean);
      const quit = await confirmDestructive(
        this.dialogs,
        uiText('workspace.unsaved.quitTitle'),
        {
          content: lines.join(' '),
          lines,
          yes: uiText('workspace.unsaved.quitYes'),
          no: uiText('common.cancel'),
        },
        'm',
      );
      if (quit) {
        if (pending.length) {
          await this.external.stopAll(true).catch(() => undefined);
        }
        await this.events.quit();
        return;
      }
      // Re-arming clears the pending request, so the next close asks here again, not natively.
      await this.events.setQuitGuard(this.active()).catch(() => undefined);
      if (modified.length) {
        await this.workspace.activate(modified[0]);
      } else {
        await this.router.navigate(['/edited-files']);
      }
    } finally {
      this.asking = false;
    }
  }

  private async notUploaded(): Promise<EditedFile[]> {
    const files = await this.external.list().catch(() => []);
    return files.filter((f) => f.notUploaded);
  }
}
