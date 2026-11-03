import { inject, Service } from '@angular/core';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { TUI_CONFIRM } from '@taiga-ui/kit';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import type { ConfigNode } from '../../core/ipc/config.models';
import { IpcError } from '../../core/ipc/ipc-error';
import { SidebarState } from '../sidebar/sidebar-state';
import type { MoveDialogData } from './move-dialog/move-dialog';
import type { MoveUndoData } from './move-undo/move-undo';
import { crossScopeWarning, targetName } from './move-rules';
import { ancestors, canMoveInto, sameContainer, type Container } from './node-tree';
import { errorText, notifyError } from './save-error';

const UNDO_DELAY = 5000;

function failureLabel(node: ConfigNode): string {
  return node.kind === 'host' ? 'Host not moved' : 'Collection not moved';
}

/** "A host named "ui" already exists in Payments. Rename one of them first." */
export function conflictText(err: IpcError): string {
  const raw = err.message.trim().replace(/[.!]$/, '');
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1)}. Rename one of them first.`;
}

/** Moves of hosts and collections: the Move to… dialog, drops in the sidebar and Undo. */
@Service()
export class MoveActions {
  private readonly config = inject(ConfigService);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly sidebar = inject(SidebarState);

  async openDialog(node: ConfigNode): Promise<void> {
    const { MoveDialog } = await import('./move-dialog/move-dialog');
    this.dialogs
      .open<void>(new PolymorpheusComponent(MoveDialog), {
        label: `Move “${node.name}”`,
        size: 'm',
        data: {
          node,
          move: (target) => this.move(node, target, true),
        } satisfies MoveDialogData,
      })
      .subscribe();
  }

  /** Whether a drag of `node` may drop on `target` (not on itself, a descendant or its parent). */
  canDrop(node: ConfigNode, target: Container): boolean {
    return !sameContainer(node, target) && canMoveInto(this.config.nodes(), node, target);
  }

  /** A drop in the sidebar: confirmed first when it leaves the scope. */
  async drop(node: ConfigNode, target: Container): Promise<void> {
    if (!this.canDrop(node, target)) {
      return;
    }
    const warning = crossScopeWarning(
      this.config.nodes(),
      this.config.projects(),
      this.config.variables(),
      node,
      target,
    );
    if (warning) {
      const confirmed = await firstValueFrom(
        this.dialogs.open<boolean>(TUI_CONFIRM, {
          label: warning.question,
          size: 's',
          data: {
            content: [warning.body, warning.missing].filter(Boolean).join(' '),
            yes: 'Move',
            no: 'Cancel',
          },
        }),
        { defaultValue: false },
      );
      if (!confirmed) {
        return;
      }
    }
    await this.move(node, target, false);
  }

  /**
   * Resolves null once moved. A name conflict resolves to its message when `inline` (the dialog
   * shows it), else it is notified like any other failure, which resolves to ''.
   */
  async move(node: ConfigNode, target: Container, inline: boolean): Promise<string | null> {
    const from: Container = { projectId: node.projectId, parentId: node.parentId };
    try {
      const result = await this.config.moveNode(node.id, target.projectId, target.parentId);
      this.reveal(node.id);
      const text = `Moved “${node.name}” to ${targetName(this.config.nodes(), this.config.projects(), target)}`;
      if (result.scopeChanged) {
        this.alerts.open(text, { appearance: 'positive' }).subscribe();
      } else {
        void this.offerUndo(node, from, text);
      }
      return null;
    } catch (err) {
      if (err instanceof IpcError && err.code === 'conflict') {
        if (inline) {
          return conflictText(err);
        }
        this.alerts
          .open(conflictText(err), { label: failureLabel(node), appearance: 'negative' })
          .subscribe();
        return '';
      }
      notifyError(this.alerts, err, failureLabel(node));
      return inline ? errorText(err) : '';
    }
  }

  private async offerUndo(node: ConfigNode, from: Container, text: string): Promise<void> {
    const { MoveUndo } = await import('./move-undo/move-undo');
    this.alerts
      .open(new PolymorpheusComponent(MoveUndo), {
        appearance: 'positive',
        autoClose: UNDO_DELAY,
        data: { text, undo: () => void this.undo(node, from) } satisfies MoveUndoData,
      })
      .subscribe();
  }

  private async undo(node: ConfigNode, from: Container): Promise<void> {
    try {
      await this.config.moveNode(node.id, from.projectId, from.parentId);
      this.reveal(node.id);
      this.alerts.open('Move undone', { appearance: 'info' }).subscribe();
    } catch (err) {
      notifyError(this.alerts, err, failureLabel(node));
    }
  }

  private reveal(nodeId: string): void {
    this.sidebar.expand(ancestors(this.config.nodes(), nodeId).map((c) => c.id));
    this.sidebar.focus(nodeId);
  }
}
