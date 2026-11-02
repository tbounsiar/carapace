import { Component, computed, ElementRef, inject, signal, type OnInit } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { type TuiHandler } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiIcon,
  TuiLoader,
  TuiNotificationService,
} from '@taiga-ui/core';
import { TuiBadge, TuiStatus, TuiTree } from '@taiga-ui/kit';
import { TuiBlockStatus } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { SshService } from '../../../core/ipc/ssh';
import { connectionStatus, type ConnectionStatus } from '../../../shared/connection-status';
import { environmentMarker, type EnvironmentMarker } from '../../../shared/environment-kind';
import { HostConnector } from '../../host-connection/host-connector';
import { ProjectActions } from '../project-actions';
import { notifyError } from '../save-error';
import { isTreeKey, treeKeyAction, type VisibleRow } from '../tree-keys';
import { nodeLabel, toNodes, type TreeNode } from '../tree-node';

export type { TreeNode } from '../tree-node';

const ICONS: Record<TreeNode['kind'], string> = {
  project: '@tui.folder',
  environment: '@tui.layers',
  host: '@tui.server',
};

const TEST_KINDS: Record<TreeNode['kind'], string> = {
  project: 'project',
  environment: 'env',
  host: 'host',
};

interface VisibleRowElement extends VisibleRow {
  readonly item: Element;
  readonly row: HTMLElement;
}

function focusTarget(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>('a.link') ?? row;
}

// Clicking Taiga's own chevron keeps the expanded state in its tree controller.
function toggle(row: HTMLElement): void {
  row.parentElement?.querySelector<HTMLElement>(':scope > button')?.click();
}

@Component({
  imports: [
    RouterLink,
    RouterLinkActive,
    TuiBadge,
    TuiBlockStatus,
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiHint,
    TuiIcon,
    TuiLoader,
    TuiStatus,
    TuiTree,
  ],
  selector: 'app-project-tree',
  host: { '(keydown)': 'onKeydown($event)' },
  styleUrl: './project-tree.scss',
  templateUrl: './project-tree.html',
})
export class ProjectTree implements OnInit {
  private readonly config = inject(ConfigService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly actions = inject(ProjectActions);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly loading = this.config.loading;
  protected readonly nodes = computed(() => toNodes(this.config.projects()));
  protected readonly openMenu = signal<string | null>(null);

  protected readonly childrenHandler: TuiHandler<TreeNode, readonly TreeNode[]> = (node) =>
    node.children;
  protected readonly trackBy = (_: number, node: TreeNode): string => this.key(node);

  ngOnInit(): void {
    this.config.load().catch((err: unknown) => notifyError(this.alerts, err));
    this.ssh.loadConnections().catch((err: unknown) => notifyError(this.alerts, err));
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (!isTreeKey(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const item = (event.target as Element | null)?.closest('tui-tree-item');
    const rows = this.visibleRows();
    const current = rows.findIndex((row) => row.item === item);
    if (current < 0) {
      return;
    }
    event.preventDefault();
    const action = treeKeyAction(event.key, rows, current);
    if (action.kind === 'focus') {
      focusTarget(rows[action.index].row).focus();
    } else if (action.kind === 'toggle') {
      toggle(rows[action.index].row);
    }
  }

  private visibleRows(): VisibleRowElement[] {
    const rows: VisibleRowElement[] = [];
    const indexOf = new Map<Element, number>();
    for (const item of this.host.querySelectorAll('tui-tree-item')) {
      const row = item.querySelector<HTMLElement>('.row');
      const parentItem = item.parentElement?.closest('tui-tree-item');
      const parent = parentItem ? indexOf.get(parentItem) : -1;
      if (!row || parent === undefined || (parent >= 0 && !rows[parent].expanded)) {
        continue;
      }
      indexOf.set(item, rows.length);
      const expanded = row.dataset['expanded'];
      rows.push({
        item,
        row,
        parent,
        expanded: expanded === undefined ? null : expanded === 'true',
      });
    }
    return rows;
  }

  protected key(node: TreeNode): string {
    return `${node.kind}:${node.id}`;
  }

  protected testId(prefix: string, node: TreeNode): string {
    return `${prefix}-${TEST_KINDS[node.kind]}-${nodeLabel(node)}`;
  }

  protected label(node: TreeNode): string {
    return nodeLabel(node);
  }

  protected addLabel(node: TreeNode): string {
    return node.kind === 'project' ? 'Add environment' : 'Add host';
  }

  protected icon(node: TreeNode): string {
    return ICONS[node.kind];
  }

  protected marker(node: TreeNode): EnvironmentMarker | null {
    return node.kind === 'project' ? null : environmentMarker(node.environment.name);
  }

  protected status(node: TreeNode): ConnectionStatus {
    return connectionStatus(this.ssh.states()[node.id] ?? 'idle');
  }

  protected isConnected(node: TreeNode): boolean {
    return node.kind === 'host' && this.ssh.states()[node.id] === 'connected';
  }

  protected setMenu(node: TreeNode, open: boolean): void {
    const key = this.key(node);
    this.openMenu.update((current) => (open ? key : current === key ? null : current));
  }

  protected createProject(): void {
    this.actions.createProject();
  }

  protected addChild(node: TreeNode): void {
    this.actions.addChild(node);
  }

  protected edit(node: TreeNode): void {
    this.actions.edit(node);
  }

  protected remove(node: TreeNode): void {
    void this.actions.remove(node);
  }

  protected connect(node: TreeNode): void {
    if (node.kind === 'host') {
      void this.connector.connect(node.host.id);
    }
  }

  protected disconnect(node: TreeNode): void {
    if (node.kind === 'host') {
      void this.connector.disconnect(node.host.id);
    }
  }
}
