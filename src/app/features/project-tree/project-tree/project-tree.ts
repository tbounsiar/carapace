import { Component, computed, inject, type OnInit } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { type TuiHandler } from '@taiga-ui/cdk';
import {
  TuiButton,
  TuiDataList,
  TuiDialogService,
  TuiDropdown,
  TuiIcon,
  TuiLoader,
  TuiNotificationService,
} from '@taiga-ui/core';
import { TUI_CONFIRM, TuiBadge, TuiStatus, TuiTree } from '@taiga-ui/kit';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../../core/ipc/config';
import { SshService } from '../../../core/ipc/ssh';
import { IpcError } from '../../../core/ipc/ipc-error';
import type { ConnectionState, HostKeyChanged } from '../../../core/ipc/ssh.models';
import { HostKeyPrompter } from '../../host-key-dialog/host-key-prompter';
import type { Environment, Host, HostInput, Project } from '../../../core/ipc/config.models';
import { HostDialog, type HostDialogData } from '../host-dialog/host-dialog';
import { NameDialog, type NameDialogData } from '../name-dialog/name-dialog';
import { notifyError } from '../save-error';

export type TreeNode =
  | {
      readonly kind: 'project';
      readonly id: string;
      readonly project: Project;
      readonly children: readonly TreeNode[];
    }
  | {
      readonly kind: 'environment';
      readonly id: string;
      readonly project: Project;
      readonly environment: Environment;
      readonly children: readonly TreeNode[];
    }
  | {
      readonly kind: 'host';
      readonly id: string;
      readonly project: Project;
      readonly environment: Environment;
      readonly host: Host;
      readonly children: readonly TreeNode[];
    };

const ICONS: Record<TreeNode['kind'], string> = {
  project: '@tui.folder',
  environment: '@tui.layers',
  host: '@tui.server',
};

const STATE_LABELS: Record<ConnectionState, string> = {
  idle: '',
  connecting: 'Connecting',
  authenticating: 'Authenticating',
  awaitingHostKey: 'Verify host key',
  connected: 'Connected',
  error: 'Failed',
};

const STATE_APPEARANCES: Record<ConnectionState, string> = {
  idle: 'neutral',
  connecting: 'info',
  authenticating: 'info',
  awaitingHostKey: 'warning',
  connected: 'positive',
  error: 'negative',
};

function toNodes(projects: readonly Project[]): TreeNode[] {
  return projects.map((project) => ({
    kind: 'project',
    id: project.id,
    project,
    children: project.environments.map((environment) => ({
      kind: 'environment',
      id: environment.id,
      project,
      environment,
      children: environment.hosts.map((host) => ({
        kind: 'host',
        id: host.id,
        project,
        environment,
        host,
        children: [],
      })),
    })),
  }));
}

@Component({
  imports: [TuiBadge, TuiButton, TuiDataList, TuiDropdown, TuiIcon, TuiLoader, TuiStatus, TuiTree],
  selector: 'app-project-tree',
  styleUrl: './project-tree.scss',
  templateUrl: './project-tree.html',
})
export class ProjectTree implements OnInit {
  private readonly config = inject(ConfigService);
  private readonly dialogs = inject(TuiDialogService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly ssh = inject(SshService);
  private readonly prompter = inject(HostKeyPrompter);

  protected readonly loading = this.config.loading;
  protected readonly nodes = computed(() => toNodes(this.config.projects()));

  protected readonly childrenHandler: TuiHandler<TreeNode, readonly TreeNode[]> = (node) =>
    node.children;
  protected readonly trackBy = (_: number, node: TreeNode): string => `${node.kind}:${node.id}`;

  ngOnInit(): void {
    this.config.load().catch((err: unknown) => notifyError(this.alerts, err));
    this.ssh.loadConnections().catch((err: unknown) => notifyError(this.alerts, err));
  }

  protected stateOf(node: TreeNode): ConnectionState {
    return node.kind === 'host' ? (this.ssh.states()[node.id] ?? 'idle') : 'idle';
  }

  protected stateLabel(node: TreeNode): string {
    return STATE_LABELS[this.stateOf(node)];
  }

  protected stateAppearance(node: TreeNode): string {
    return STATE_APPEARANCES[this.stateOf(node)];
  }

  protected isBusy(node: TreeNode): boolean {
    const state = this.stateOf(node);
    return state === 'connecting' || state === 'authenticating' || state === 'awaitingHostKey';
  }

  protected async connect(node: TreeNode): Promise<void> {
    if (node.kind !== 'host') {
      return;
    }
    try {
      await this.ssh.connect(node.host.id, {
        decide: (prompt) => this.prompter.ask(prompt),
        changed: (event) => void this.handleChangedKey(node.host.id, event),
      });
    } catch (err) {
      if (!(err instanceof IpcError && err.code === 'host_key_changed')) {
        notifyError(this.alerts, err);
      }
    }
  }

  private async handleChangedKey(hostId: string, event: HostKeyChanged): Promise<void> {
    try {
      if (await this.prompter.confirmReplace(event)) {
        await this.ssh.replaceHostKey(hostId, event.fingerprint);
        this.alerts
          .open('The stored key was replaced. Connect again to continue.', {
            label: 'Host key replaced',
            appearance: 'warning',
          })
          .subscribe();
      }
    } catch (err) {
      notifyError(this.alerts, err);
    }
  }

  protected async disconnect(node: TreeNode): Promise<void> {
    if (node.kind !== 'host') {
      return;
    }
    try {
      await this.ssh.disconnect(node.host.id);
    } catch (err) {
      notifyError(this.alerts, err);
    }
  }

  protected icon(node: TreeNode): string {
    return ICONS[node.kind];
  }

  protected label(node: TreeNode): string {
    switch (node.kind) {
      case 'project':
        return node.project.name;
      case 'environment':
        return node.environment.name;
      case 'host':
        return node.host.name;
    }
  }

  protected createProject(): void {
    this.openNameDialog('New project', 'project', '', (name) => this.config.createProject(name));
  }

  protected addChild(node: TreeNode): void {
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

  protected edit(node: TreeNode): void {
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

  protected async remove(node: TreeNode): Promise<void> {
    const confirmed = await firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, {
        label: `Delete ${node.kind} "${this.label(node)}"?`,
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
      return;
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
    } catch (err) {
      notifyError(this.alerts, err);
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
