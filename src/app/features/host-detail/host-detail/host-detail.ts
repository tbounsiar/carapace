import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  resource,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TuiButton, TuiNotificationService, TuiTitle } from '@taiga-ui/core';
import { TuiButtonLoading, TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiCardLarge, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { hostTarget } from '../../../core/ipc/connection';
import { SecretsService } from '../../../core/ipc/secrets';
import { SshService } from '../../../core/ipc/ssh';
import { AUTH_LABELS } from '../../../shared/auth-method';
import { connectionStatus } from '../../../shared/connection-status';
import { HostConnector } from '../../host-connection/host-connector';
import { ProjectActions } from '../../project-tree/project-actions';
import { textOf } from '../../../shared/backend-text';
import { notifyError } from '../../../shared/save-error';
import { Workspace } from '../../workspace/workspace';
import { HostTabs } from '../host-tabs/host-tabs';

@Component({
  imports: [
    RouterLink,
    TuiBlockStatus,
    TuiButton,
    TuiButtonLoading,
    TuiCardLarge,
    HostTabs,
    TuiHeader,
    TuiStatus,
    TuiTitle,
    TranslocoPipe,
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
  private readonly workspace = inject(Workspace);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly alerts = inject(TuiNotificationService);
  private readonly transloco = inject(TranslocoService);

  readonly hostId = input.required<string>();

  protected readonly located = computed(() => this.config.findHost(this.hostId()));

  protected readonly target = computed(() => {
    const located = this.located();
    return located ? hostTarget(located.host) : null;
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
    loader: ({ params }) => this.config.resolveHost(params.target.hostId),
  });

  protected readonly address = computed(() => {
    const r = this.resolved.hasValue() ? this.resolved.value() : null;
    if (!r) {
      return null;
    }
    if (r.missing.length) {
      return { ok: false, missing: r.missing.join(', '), text: '' };
    }
    if (r.errors.length) {
      return { ok: false, missing: null, text: r.errors.map(textOf).join('; ') };
    }
    if (r.username === null || r.hostname === null || r.port === null) {
      return null;
    }
    return { ok: true, missing: null, text: `${r.username}@${r.hostname}:${r.port}` };
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
    return auth?.kind === 'password' ? auth.password : null;
  });

  protected readonly askedWhenConnecting = computed(() => {
    const auth = this.located()?.host.auth;
    return auth?.kind === 'password' && !auth.password;
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

  constructor() {
    // Closing the last tab lands here; the focus goes to the heading, not the page top.
    afterRenderEffect(() => {
      const heading = this.heading()?.nativeElement;
      if (heading && this.workspace.headingFocus()) {
        untracked(() => this.workspace.headingFocus.set(false));
        heading.focus();
      }
    });
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
      await this.secrets.forgetSaved(target.hostId);
      this.alerts
        .open(this.transloco.translate(`hostDetail.forgotten.${this.secretLabel()}`), {
          label: this.transloco.translate('hostDetail.forgotten.title'),
          appearance: 'positive',
        })
        .subscribe();
    } catch (err) {
      notifyError(this.alerts, err, this.transloco.translate('hostDetail.notForgotten'));
    } finally {
      this.forgetting.set(false);
    }
  }
}
