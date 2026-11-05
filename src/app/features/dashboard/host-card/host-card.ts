import {
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiLink,
  TuiLoader,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiButtonLoading, TuiStatus } from '@taiga-ui/kit';
import { TuiCardLarge, TuiHeader } from '@taiga-ui/layout';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConfigService } from '../../../core/ipc/config';
import type { Host } from '../../../core/ipc/config.models';
import { hostTarget } from '../../../core/ipc/connection';
import { SshService } from '../../../core/ipc/ssh';
import { AUTH_LABELS } from '../../../shared/auth-method';
import { connectionStatus } from '../../../shared/connection-status';
import { previewHost, variableLayers } from '../../../shared/template';
import { uiText } from '../../../shared/ui-text';
import { HostConnector } from '../../host-connection/host-connector';
import { HostLauncher } from '../../host-connection/host-launcher';
import { MoveLauncher } from '../../project-tree/move-launcher';
import { ProjectActions } from '../../project-tree/project-actions';

interface CardMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly separated?: boolean;
  readonly run: () => void;
}

let cards = 0;

/** A host on a dashboard: address, status, auth, and the actions that fit its connection state. */
@Component({
  imports: [
    RouterLink,
    TuiButton,
    TuiButtonLoading,
    TuiCardLarge,
    TuiDataList,
    TuiDropdown,
    TuiHeader,
    TuiHint,
    TuiLink,
    TuiLoader,
    TuiStatus,
    TuiTitle,
    TranslocoPipe,
  ],
  selector: 'app-host-card',
  styleUrl: './host-card.scss',
  templateUrl: './host-card.html',
  host: { '(keydown)': 'onKeydown($event)' },
})
export class HostCard {
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly launcher = inject(HostLauncher);
  private readonly actions = inject(ProjectActions);
  private readonly moves = inject(MoveLauncher);

  readonly host = input.required<Host>();
  /** Emitted once the host is deleted from this card's menu. */
  readonly deleted = output<Host>();

  private readonly menuButton = viewChild.required<ElementRef<HTMLElement>>('menuButton');
  private readonly nameLink = viewChild.required<ElementRef<HTMLElement>>('nameLink');

  protected readonly nameId = `host-card-${++cards}`;
  protected readonly menuOpen = signal(false);

  private readonly target = computed(() => hostTarget(this.host()));
  private readonly state = computed(() => this.ssh.states()[this.target().connectionId] ?? 'idle');
  protected readonly status = computed(() => connectionStatus(this.state()));
  protected readonly connected = computed(() => this.state() === 'connected');
  protected readonly authLabel = computed(() => AUTH_LABELS[this.host().auth.kind]);

  /** Resolved in the UI like the host dialog preview, so a board of cards needs no IPC per host. */
  protected readonly preview = computed(() => {
    const host = this.host();
    const project = host.projectId ? this.config.findProject(host.projectId) : null;
    const preview = previewHost(host, variableLayers(this.config.variables(), project));
    return preview.missing.length
      ? { ok: false, text: uiText('dashboard.card.missing', { names: preview.missing.join(', ') }) }
      : { ok: true, text: preview.address };
  });

  protected readonly menuEntries = computed<CardMenuEntry[]>(() => {
    const host = this.host();
    const entries: CardMenuEntry[] = [
      {
        id: 'menu-edit',
        label: uiText('common.edit'),
        icon: '@tui.pencil',
        run: () => this.actions.editHost(host, { sidebarFocus: false }),
      },
      {
        id: 'menu-move',
        label: uiText('dashboard.card.move'),
        icon: '@tui.folder-input',
        run: () => void this.moves.openDialog(host),
      },
    ];
    if (this.connected()) {
      entries.push({
        id: 'menu-disconnect',
        label: uiText('dashboard.card.disconnect'),
        icon: '@tui.unplug',
        run: () => void this.connector.disconnect(this.target().connectionId),
      });
    }
    entries.push({
      id: 'menu-delete',
      label: uiText('common.delete'),
      icon: '@tui.trash',
      separated: true,
      run: () => void this.remove(host),
    });
    return entries;
  });

  focus(): void {
    this.nameLink().nativeElement.focus();
  }

  protected connect(): void {
    void this.connector.connect(this.target());
  }

  protected openTerminal(): void {
    void this.launcher.openTerminal(this.host());
  }

  protected openFiles(): void {
    void this.launcher.openFiles(this.host());
  }

  protected run(entry: CardMenuEntry): void {
    this.menuOpen.set(false);
    this.menuButton().nativeElement.focus();
    entry.run();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
    if (
      plain &&
      ((event.key === 'F10' && event.shiftKey) || (event.key === 'ContextMenu' && !event.shiftKey))
    ) {
      event.preventDefault();
      this.menuOpen.set(true);
    }
  }

  private async remove(host: Host): Promise<void> {
    if (await this.actions.deleteHost(host, { sidebarFocus: false })) {
      this.deleted.emit(host);
    }
  }
}
