import { inject, Service } from '@angular/core';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { TUI_CONFIRM } from '@taiga-ui/kit';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import type { Environment, Host, HostInput, Project } from '../../core/ipc/config.models';
import type { HostDialogData } from './host-dialog/host-dialog';
import type { NameDialogData } from './name-dialog/name-dialog';
import { notifyError } from './save-error';
import type { TreeNode } from './tree-node';

/** Create, edit and delete flows for projects, environments and hosts; dialogs handle their own save errors. */
@Service()
export class ProjectActions {
  private readonly config = inject(ConfigService);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);

  createProject(): void {
    void this.openNameDialog('New project', 'project', '', (name) =>
      this.config.createProject(name),
    );
  }

  addHost(project: Project): void {
    void this.openHostDialog('New host', project.id, null, (host) =>
      this.config.createHost(project.id, host),
    );
  }

  addEnvironment(project: Project): void {
    void this.openNameDialog('New environment', 'environment', '', (name) =>
      this.config.createEnvironment(project.id, name),
    );
  }

  renameEnvironment(project: Project, env: Environment): void {
    void this.openNameDialog('Rename environment', 'environment', env.name, (name) =>
      this.config.renameEnvironment(project.id, env.id, name),
    );
  }

  /** Resolves true when the environment was deleted. */
  removeEnvironment(project: Project, env: Environment): Promise<boolean> {
    return this.confirmDelete(
      `Delete environment "${env.name}"?`,
      'Its variables and the secrets saved for it are removed. Hosts stay in the project.',
      'Environment not deleted',
      () => this.config.deleteEnvironment(project.id, env.id),
    );
  }

  edit(node: TreeNode): void {
    if (node.kind === 'project') {
      void this.openNameDialog('Rename project', 'project', node.project.name, (name) =>
        this.config.renameProject(node.project.id, name),
      );
    } else {
      this.editHost(node.project, node.host);
    }
  }

  editHost(project: Project, host: Host): void {
    const { name, hostname, port, username, auth } = host;
    void this.openHostDialog(
      'Edit host',
      project.id,
      { name, hostname, port, username, auth },
      (input) => this.config.updateHost(project.id, host.id, input),
    );
  }

  /** Resolves true when the node was deleted. */
  remove(node: TreeNode): Promise<boolean> {
    if (node.kind === 'project') {
      return this.confirmDelete(
        `Delete project "${node.project.name}"?`,
        'It will be removed together with its environments, variables and hosts.',
        'Project not deleted',
        () => this.config.deleteProject(node.project.id),
      );
    }
    return this.confirmDelete(
      `Delete host "${node.host.name}"?`,
      'This host will be removed.',
      'Host not deleted',
      () => this.config.deleteHost(node.project.id, node.host.id),
    );
  }

  private async confirmDelete(
    label: string,
    content: string,
    failure: string,
    run: () => Promise<void>,
  ): Promise<boolean> {
    const confirmed = await firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, {
        label,
        size: 's',
        data: {
          content,
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
      await run();
      return true;
    } catch (err) {
      notifyError(this.alerts, err, failure);
      return false;
    }
  }

  private async openNameDialog(
    label: string,
    noun: string,
    initial: string,
    save: NameDialogData['save'],
  ): Promise<void> {
    const { NameDialog } = await import('./name-dialog/name-dialog');
    this.dialogs
      .open<void>(new PolymorpheusComponent(NameDialog), {
        label,
        size: 's',
        data: { noun, initial, save } satisfies NameDialogData,
      })
      .subscribe();
  }

  private async openHostDialog(
    label: string,
    projectId: string,
    initial: HostInput | null,
    save: HostDialogData['save'],
  ): Promise<void> {
    const { HostDialog } = await import('./host-dialog/host-dialog');
    this.dialogs
      .open<void>(new PolymorpheusComponent(HostDialog), {
        label,
        size: 'm',
        data: { projectId, initial, save } satisfies HostDialogData,
      })
      .subscribe();
  }
}
