import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiCell, TuiIcon, TuiLoader, TuiTitle } from '@taiga-ui/core';
import { TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import type { Host } from '../../../core/ipc/config.models';
import { HostLauncher } from '../../host-connection/host-launcher';
import { tabTestSuffix } from '../../workspace/tab-strip/tab-strip';
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
  ],
  selector: 'app-host-tabs',
  templateUrl: './host-tabs.html',
  styleUrl: './host-tabs.scss',
})
export class HostTabs {
  private readonly workspace = inject(Workspace);
  private readonly launcher = inject(HostLauncher);

  readonly host = input.required<Host>();
  /** Connect stays the page's only primary action while the host is disconnected. */
  readonly connected = input(false);

  protected readonly tabs = computed(() => this.workspace.ofHost(this.host().id));
  protected readonly newAppearance = computed(() => (this.connected() ? 'primary' : 'secondary'));

  protected suffix(tab: WorkspaceTab): string {
    return tabTestSuffix(tab, this.host().name);
  }

  protected aria(tab: WorkspaceTab): string {
    const extra = `${tab.modified() ? ', modified' : ''}${tab.readOnly() ? ', read-only' : ''}`;
    return `${tab.label} — ${tab.status().word}${extra}`;
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
