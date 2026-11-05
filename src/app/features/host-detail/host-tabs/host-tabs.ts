import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TuiButton, TuiCell, TuiIcon, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import type { Host } from '../../../core/ipc/config.models';
import { HostLauncher } from '../../host-connection/host-launcher';
import { tabTestSuffix } from '../../workspace/tab-strip/tab-strip';
import { statusWord } from '../../workspace/tab-status';
import { tabLabel } from '../../workspace/tab-titles';
import { Workspace, type WorkspaceTab } from '../../workspace/workspace';

/** The host page's list of the host's workspace tabs, with New terminal and Files. */
@Component({
  imports: [
    NgTemplateOutlet,
    RouterLink,
    TuiBlockStatus,
    TuiButton,
    TuiCell,
    TuiHeader,
    TuiIcon,
    TuiLoader,
    TuiStatus,
    TuiTitle,
    TranslocoPipe,
  ],
  selector: 'app-host-tabs',
  templateUrl: './host-tabs.html',
  styleUrl: './host-tabs.scss',
})
export class HostTabs {
  private readonly workspace = inject(Workspace);
  private readonly launcher = inject(HostLauncher);
  private readonly transloco = inject(TranslocoService);

  readonly host = input.required<Host>();
  /** Connect stays the page's only primary action while the host is disconnected. */
  readonly connected = input(false);

  protected readonly tabs = computed(() => this.workspace.ofHost(this.host().id));
  protected readonly newAppearance = computed(() => (this.connected() ? 'primary' : 'secondary'));

  protected suffix(tab: WorkspaceTab): string {
    return tabTestSuffix(tab, this.host().name);
  }

  protected label(tab: WorkspaceTab): string {
    return tabLabel(tab);
  }

  protected aria(tab: WorkspaceTab): string {
    const modified = tab.modified();
    const readOnly = tab.readOnly();
    const variant =
      modified && readOnly
        ? 'modifiedReadOnly'
        : modified
          ? 'modified'
          : readOnly
            ? 'readOnly'
            : 'plain';
    return this.transloco.translate(`hostDetail.tabs.aria.${variant}`, {
      label: tabLabel(tab),
      status: statusWord(tab.status()),
    });
  }

  protected newTerminal(): void {
    void this.launcher.newTerminal(this.host());
  }

  protected openFiles(): void {
    void this.launcher.openFiles(this.host());
  }

  protected activate(event: Event, tab: WorkspaceTab): void {
    event.preventDefault();
    void this.workspace.activate(tab);
  }
}
