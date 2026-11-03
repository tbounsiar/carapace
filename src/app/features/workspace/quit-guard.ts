import { computed, effect, inject, Service } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { AppEvents } from '../../core/ipc/app-events';
import { ConfigService } from '../../core/ipc/config';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { unsavedNames } from './tab-titles';
import { Workspace } from './workspace';

/** Holds the window open while an editor has unsaved changes, and asks before quitting. */
@Service()
export class QuitGuard {
  private readonly workspace = inject(Workspace);
  private readonly events = inject(AppEvents);
  private readonly dialogs = inject(TuiDialogService);
  private readonly config = inject(ConfigService);
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
    const modified = this.modified();
    if (!modified.length) {
      await this.events.quit();
      return;
    }
    this.asking = true;
    try {
      const hostName = (id: string) => this.config.findHost(id)?.host.name ?? 'Unknown host';
      const quit = await confirmDestructive(this.dialogs, 'Quit with unsaved changes?', {
        content: `Unsaved changes in ${unsavedNames(modified, hostName)}.`,
        yes: 'Quit without saving',
        no: 'Cancel',
      });
      if (quit) {
        await this.events.quit();
      } else {
        // Re-arming clears the pending request, so the next close asks here again, not natively.
        await this.events.setQuitGuard(true).catch(() => undefined);
        await this.workspace.activate(modified[0]);
      }
    } finally {
      this.asking = false;
    }
  }
}
