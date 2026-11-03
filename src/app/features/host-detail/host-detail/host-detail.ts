import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiNotificationService, TuiTitle } from '@taiga-ui/core';
import { TuiBadge, TuiButtonLoading, TuiSegmented, TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiCardLarge, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { hostTarget } from '../../../core/ipc/connection';
import { SecretsService } from '../../../core/ipc/secrets';
import { SshService } from '../../../core/ipc/ssh';
import { AUTH_LABELS } from '../../../shared/auth-method';
import { connectionStatus } from '../../../shared/connection-status';
import { environmentMarker } from '../../../shared/environment-kind';
import { FilesPanel } from '../../files/files-panel/files-panel';
import { HostConnector } from '../../host-connection/host-connector';
import { ProjectActions } from '../../project-tree/project-actions';
import { notifyError } from '../../project-tree/save-error';
import { TerminalPanel } from '../../terminal/terminal-panel/terminal-panel';
import { type HostView, HostViews } from '../host-view';

const VIEW_OPTIONS: readonly { view: HostView; label: string; icon: string }[] = [
  { view: 'terminal', label: 'Terminal', icon: '@tui.square-terminal' },
  { view: 'files', label: 'Files', icon: '@tui.folder' },
];

@Component({
  imports: [
    RouterLink,
    TuiBadge,
    TuiBlockStatus,
    TuiButton,
    TuiButtonLoading,
    TuiCardLarge,
    FilesPanel,
    TuiHeader,
    TuiIcon,
    TerminalPanel,
    TuiSegmented,
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
  private readonly secrets = inject(SecretsService);
  private readonly connector = inject(HostConnector);
  private readonly actions = inject(ProjectActions);
  private readonly views = inject(HostViews);
  private readonly alerts = inject(TuiNotificationService);

  readonly hostId = input.required<string>();

  protected readonly located = computed(() => this.config.findHost(this.hostId()));

  protected readonly environment = computed(() => {
    const project = this.located()?.project;
    return project?.environments.find((e) => e.id === project.activeEnvironmentId) ?? null;
  });

  protected readonly target = computed(() => {
    const located = this.located();
    return located ? hostTarget(located.host, located.project) : null;
  });

  protected readonly marker = computed(() => {
    const env = this.environment();
    return env ? environmentMarker(env.name) : null;
  });

  /** Re-resolved whenever the config changes, since any variable may affect the result. */
  private readonly resolved = resource({
    params: () => {
      const target = this.target();
      return target
        ? {
            target,
            projects: this.config.projects(),
            nodes: this.config.nodes(),
            vars: this.config.variables(),
          }
        : undefined;
    },
    loader: ({ params }) =>
      this.config.resolveHost(params.target.hostId, params.target.environmentId),
  });

  protected readonly address = computed(() => {
    const r = this.resolved.hasValue() ? this.resolved.value() : null;
    if (!r) {
      return null;
    }
    if (r.missing.length) {
      return { ok: false, text: `Missing variables: ${r.missing.join(', ')}` };
    }
    if (r.errors.length) {
      return { ok: false, text: r.errors.join('; ') };
    }
    if (r.username === null || r.hostname === null || r.port === null) {
      return null;
    }
    return { ok: true, text: `${r.username}@${r.hostname}:${r.port}` };
  });

  protected readonly authLabel = computed(() => {
    const auth = this.located()?.host.auth;
    return auth ? AUTH_LABELS[auth.kind] : '';
  });

  protected readonly authDetail = computed(() => {
    const auth = this.located()?.host.auth;
    if (auth?.kind === 'key') {
      return auth.keyPath;
    }
    return auth?.kind === 'password' ? (auth.password ?? 'asked when connecting') : null;
  });

  protected readonly secretLabel = computed(() => {
    const kind = this.located()?.host.auth.kind;
    return kind === 'password' ? 'password' : kind === 'key' ? 'passphrase' : null;
  });

  private readonly state = computed(() => {
    const target = this.target();
    return target ? (this.ssh.states()[target.connectionId] ?? 'idle') : 'idle';
  });
  protected readonly status = computed(() => connectionStatus(this.state()));
  protected readonly connected = computed(() => this.state() === 'connected');
  protected readonly forgetting = signal(false);

  protected readonly viewOptions = VIEW_OPTIONS;
  protected readonly view = computed(() => this.views.of(this.hostId()));
  protected readonly viewIndex = computed(() =>
    VIEW_OPTIONS.findIndex((o) => o.view === this.view()),
  );

  protected readonly scopeText = computed(() => {
    const project = this.located()?.project;
    return project
      ? `${project.name} / ${this.environment()?.name ?? 'No environment'}`
      : 'Home · no environment';
  });

  protected selectView(index: number): void {
    const option = VIEW_OPTIONS[index];
    if (option) {
      this.views.set(this.hostId(), option.view);
    }
  }

  protected connect(): void {
    const target = this.target();
    if (target) {
      void this.connector.connect(target);
    }
  }

  protected disconnect(): void {
    const target = this.target();
    if (target) {
      void this.connector.disconnect(target.connectionId);
    }
  }

  protected edit(): void {
    const located = this.located();
    if (located) {
      this.actions.editHost(located.host);
    }
  }

  protected async forgetSecrets(): Promise<void> {
    const target = this.target();
    if (!target || this.forgetting()) {
      return;
    }
    this.forgetting.set(true);
    try {
      await this.secrets.forgetSaved(target.hostId, target.environmentId);
      this.alerts
        .open(`The ${this.secretLabel()} saved for this connection was removed.`, {
          label: 'Saved secret forgotten',
          appearance: 'positive',
        })
        .subscribe();
    } catch (err) {
      notifyError(this.alerts, err, 'Saved secret not forgotten');
    } finally {
      this.forgetting.set(false);
    }
  }
}
