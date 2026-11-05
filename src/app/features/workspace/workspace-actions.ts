import { inject, Service } from '@angular/core';
import { Router } from '@angular/router';
import { TuiDialogService } from '@taiga-ui/core';
import { ConfigService } from '../../core/ipc/config';
import type { Host } from '../../core/ipc/config.models';
import { hostTarget } from '../../core/ipc/connection';
import { SshService } from '../../core/ipc/ssh';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { uiText } from '../../shared/ui-text';
import { askEditorChoice } from '../editor/editor-choice';
import { HostConnector } from '../host-connection/host-connector';
import { HostLauncher } from '../host-connection/host-launcher';
import { unsavedNames } from './tab-titles';
import { Workspace, type WorkspaceTab } from './workspace';

export interface TabMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly run: () => void;
  readonly separated?: boolean;
  /** Why the entry is disabled, shown under its label. */
  readonly disabledReason?: string;
}

/** Closing tabs (with the unsaved-changes questions) and the tab menu. */
@Service()
export class WorkspaceActions {
  private readonly workspace = inject(Workspace);
  private readonly dialogs = inject(TuiDialogService);
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly launcher = inject(HostLauncher);
  private readonly router = inject(Router);

  hostName = (hostId: string): string =>
    this.config.findHost(hostId)?.host.name ?? uiText('workspace.tab.unknownHost');

  /** Resolves true when the tab was closed; a modified editor asks Save / Don't save / Cancel. */
  async close(tab: WorkspaceTab): Promise<boolean> {
    if (tab.doc && tab.modified()) {
      const choice = await askEditorChoice(this.dialogs, {
        kind: 'unsaved',
        name: tab.label,
        host: this.hostName(tab.hostId),
      });
      if (choice === 'cancel' || (choice === 'save' && !(await tab.doc.save()))) {
        return false;
      }
    }
    await this.workspace.remove(tab);
    return true;
  }

  closeOthers(tab: WorkspaceTab): Promise<boolean> {
    return this.closeMany(this.workspace.tabs().filter((t) => t.id !== tab.id));
  }

  closeHost(hostId: string): Promise<boolean> {
    return this.closeMany(this.workspace.ofHost(hostId));
  }

  /** One question for all the modified editors among `tabs`. */
  async closeMany(tabs: readonly WorkspaceTab[]): Promise<boolean> {
    if (!tabs.length) {
      return true;
    }
    const modified = tabs.filter((t) => t.modified());
    if (modified.length) {
      const confirmed = await confirmDestructive(
        this.dialogs,
        uiText('workspace.unsaved.closeTitle'),
        {
          content: uiText('workspace.unsaved.closeContent', {
            names: unsavedNames(modified, this.hostName),
          }),
          yes: uiText('workspace.unsaved.closeYes'),
          no: uiText('common.cancel'),
        },
      );
      if (!confirmed) {
        return false;
      }
    }
    const closing = new Set(tabs.map((t) => t.id));
    const active = this.workspace.active();
    if (active && closing.has(active.id)) {
      const all = this.workspace.tabs();
      const index = all.indexOf(active);
      const next =
        all.slice(index + 1).find((t) => !closing.has(t.id)) ??
        all
          .slice(0, index)
          .reverse()
          .find((t) => !closing.has(t.id));
      if (next) {
        await this.workspace.activate(next);
      } else {
        this.workspace.headingFocus.set(true);
        await this.router.navigate(['/hosts', active.hostId]);
      }
    }
    this.workspace.drop([...closing]);
    return true;
  }

  menu(tab: WorkspaceTab): TabMenuEntry[] {
    const host = this.config.findHost(tab.hostId)?.host;
    if (!host) {
      return [
        {
          id: 'tab-menu-close',
          label: uiText('common.close'),
          icon: '@tui.x',
          run: () => void this.close(tab),
        },
      ];
    }
    const connected = this.ssh.stateOf(hostTarget(host).connectionId) === 'connected';
    return [
      {
        id: 'tab-menu-new-terminal',
        label: uiText('workspace.menu.newTerminal'),
        icon: '@tui.square-terminal',
        run: () => void this.launcher.newTerminal(host),
      },
      {
        id: 'tab-menu-files',
        label: uiText('workspace.menu.openFiles'),
        icon: '@tui.folder-open',
        run: () => void this.launcher.openFiles(host),
      },
      ...this.externalEntry(tab, host),
      {
        id: 'tab-menu-close',
        label: uiText('common.close'),
        icon: '@tui.x',
        separated: true,
        run: () => void this.close(tab),
      },
      {
        id: 'tab-menu-close-others',
        label: uiText('workspace.menu.closeOthers'),
        icon: '@tui.copy-x',
        run: () => void this.closeOthers(tab),
      },
      {
        id: 'tab-menu-close-host',
        label: uiText('workspace.menu.closeHost', { host: host.name }),
        icon: '@tui.square-x',
        run: () => void this.closeHost(host.id),
      },
      this.connectionEntry(host, connected),
      {
        id: 'tab-menu-host',
        label: uiText('workspace.menu.hostPage'),
        icon: '@tui.server',
        run: () => void this.launcher.open(host),
      },
    ];
  }

  /** An editor tab's file can move to the external editor once its buffer is saved. */
  private externalEntry(tab: WorkspaceTab, host: Host): TabMenuEntry[] {
    const path = tab.path;
    if (tab.kind !== 'edit' || path === null) {
      return [];
    }
    return [
      {
        id: 'tab-menu-external',
        label: uiText('workspace.menu.openExternal'),
        icon: '@tui.external-link',
        disabledReason: tab.modified() ? uiText('workspace.menu.saveFirst') : undefined,
        run: () => void this.launcher.openExternal(host, path, null),
      },
    ];
  }

  private connectionEntry(host: Host, connected: boolean): TabMenuEntry {
    const target = hostTarget(host);
    return connected
      ? {
          id: 'tab-menu-disconnect',
          label: uiText('workspace.menu.disconnect', { host: host.name }),
          icon: '@tui.unplug',
          separated: true,
          run: () => void this.connector.disconnect(target.connectionId),
        }
      : {
          id: 'tab-menu-connect',
          label: uiText('workspace.menu.connect', { host: host.name }),
          icon: '@tui.plug',
          separated: true,
          run: () => void this.connector.connect(target),
        };
  }
}
