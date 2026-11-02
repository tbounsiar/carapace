import { inject, Service } from '@angular/core';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { TUI_CONFIRM } from '@taiga-ui/kit';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import type { HostInput } from '../../core/ipc/config.models';
import { HostDialog, type HostDialogData } from './host-dialog/host-dialog';
import { NameDialog, type NameDialogData } from './name-dialog/name-dialog';
import { notifyError } from './save-error';
import { nodeLabel, type TreeNode } from './tree-node';

/** Create, edit and delete flows for tree nodes; dialogs handle their own save errors. */
@Service()
export class ProjectActions {
  private readonly config = inject(ConfigService);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);

  createProject(): void {
    this.openNameDialog('New project', 'project', '', (name) => this.config.createProject(name));
  }

  addChild(node: TreeNode): void {
    if (node.kind === 'project') {
      this.openNameDialog('New environment', 'environment', '', (name) =>
        this.config.createEnvironment(node.project.id, name),
      );
    } else if (node.kind === 'environment') {
      this.openHostDialog('New host', null, (host) =>
        this.config.createHost(node.project.id, node.environment.id, host),
      );
    }
  }

  edit(node: TreeNode): void {
    switch (node.kind) {
      case 'project':
        this.openNameDialog('Rename project', 'project', node.project.name, (name) =>
          this.config.renameProject(node.project.id, name),
        );
        break;
      case 'environment':
        this.openNameDialog('Rename environment', 'environment', node.environment.name, (name) =>
          this.config.renameEnvironment(node.project.id, node.environment.id, name),
        );
        break;
      case 'host': {
        const { name, hostname, port, username, auth } = node.host;
        this.openHostDialog('Edit host', { name, hostname, port, username, auth }, (host) =>
          this.config.updateHost(node.project.id, node.environment.id, node.host.id, host),
        );
        break;
      }
    }
  }

  /** Resolves true when the node was deleted. */
  async remove(node: TreeNode): Promise<boolean> {
    const confirmed = await firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, {
        label: `Delete ${node.kind} "${nodeLabel(node)}"?`,
        size: 's',
        data: {
          content:
            node.kind === 'host'
              ? 'This host will be removed.'
              : 'It will be removed together with everything it contains.',
          yes: 'Delete',
          no: 'Cancel',
          appearance: ['primary-destructive', 'secondary'],
        },
      }),
      { defaultValue: false },
    );
    if (!confirmed) {
      return false;
    }
    try {
      switch (node.kind) {
        case 'project':
          await this.config.deleteProject(node.project.id);
          break;
        case 'environment':
          await this.config.deleteEnvironment(node.project.id, node.environment.id);
          break;
        case 'host':
          await this.config.deleteHost(node.project.id, node.environment.id, node.host.id);
          break;
      }
      return true;
    } catch (err) {
      notifyError(this.alerts, err);
      return false;
    }
  }

  private openNameDialog(
    label: string,
    noun: string,
    initial: string,
    save: NameDialogData['save'],
  ): void {
    this.dialogs
      .open<void>(new PolymorpheusComponent(NameDialog), {
        label,
        size: 's',
        data: { noun, initial, save } satisfies NameDialogData,
      })
      .subscribe();
  }

  private openHostDialog(
    label: string,
    initial: HostInput | null,
    save: HostDialogData['save'],
  ): void {
    this.dialogs
      .open<void>(new PolymorpheusComponent(HostDialog), {
        label,
        size: 'm',
        data: { initial, save } satisfies HostDialogData,
      })
      .subscribe();
  }
}
