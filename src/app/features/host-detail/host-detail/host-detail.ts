import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiTitle } from '@taiga-ui/core';
import { TuiBadge, TuiButtonLoading, TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiCardLarge, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { SshService } from '../../../core/ipc/ssh';
import { AUTH_LABELS } from '../../../shared/auth-method';
import { connectionStatus } from '../../../shared/connection-status';
import { environmentMarker } from '../../../shared/environment-kind';
import { HostConnector } from '../../host-connection/host-connector';
import { ProjectActions } from '../../project-tree/project-actions';
import { TerminalPanel } from '../../terminal/terminal-panel/terminal-panel';
import type { TreeNode } from '../../project-tree/tree-node';

type HostNode = Extract<TreeNode, { kind: 'host' }>;

@Component({
  imports: [
    RouterLink,
    TuiBadge,
    TuiBlockStatus,
    TuiButton,
    TuiButtonLoading,
    TuiCardLarge,
    TuiHeader,
    TerminalPanel,
    TuiStatus,
    TuiTitle,
  ],
  selector: 'app-host-detail',
  styleUrl: './host-detail.scss',
  templateUrl: './host-detail.html',
})
export class HostDetail {
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly actions = inject(ProjectActions);

  readonly hostId = input.required<string>();

  protected readonly node = computed<HostNode | null>(() => {
    const id = this.hostId();
    for (const project of this.config.projects()) {
      for (const environment of project.environments) {
        const host = environment.hosts.find((h) => h.id === id);
        if (host) {
          return { kind: 'host', id, project, environment, host, children: [] };
        }
      }
    }
    return null;
  });

  protected readonly address = computed(() => {
    const host = this.node()?.host;
    return host ? `${host.username}@${host.hostname}:${host.port}` : '';
  });

  protected readonly marker = computed(() => {
    const node = this.node();
    return node ? environmentMarker(node.environment.name) : null;
  });

  protected readonly authLabel = computed(() => {
    const auth = this.node()?.host.auth;
    return auth ? AUTH_LABELS[auth.kind] : '';
  });

  protected readonly keyPath = computed(() => {
    const auth = this.node()?.host.auth;
    return auth?.kind === 'key' ? auth.keyPath : null;
  });

  private readonly state = computed(() => this.ssh.states()[this.hostId()] ?? 'idle');
  protected readonly status = computed(() => connectionStatus(this.state()));
  protected readonly connected = computed(() => this.state() === 'connected');

  protected connect(): void {
    void this.connector.connect(this.hostId());
  }

  protected disconnect(): void {
    void this.connector.disconnect(this.hostId());
  }

  protected edit(): void {
    const node = this.node();
    if (node) {
      this.actions.edit(node);
    }
  }
}
