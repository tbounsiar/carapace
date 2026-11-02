import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { TuiButton, TuiIcon, TuiNotification } from '@taiga-ui/core';
import { TuiAvatar, TuiButtonLoading, TuiTabs } from '@taiga-ui/kit';
import { TuiBlockStatus } from '@taiga-ui/layout';
import { SshService } from '../../../core/ipc/ssh';
import { ThemeService } from '../../../core/theme/theme';
import { HostConnector } from '../../host-connection/host-connector';
import { type TerminalTab, TerminalSessions } from '../terminal-sessions';

const ENDED_REASONS = {
  exited: 'The shell exited.',
  closed: 'The terminal was closed.',
  connectionLost: 'The connection was lost.',
} as const;

@Component({
  imports: [
    TuiAvatar,
    TuiBlockStatus,
    TuiButton,
    TuiButtonLoading,
    TuiIcon,
    TuiNotification,
    TuiTabs,
  ],
  selector: 'app-terminal-panel',
  styleUrl: './terminal-panel.scss',
  templateUrl: './terminal-panel.html',
  host: { 'data-testid': 'terminal-panel' },
})
export class TerminalPanel {
  private readonly sessions = inject(TerminalSessions);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly theme = inject(ThemeService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly hostId = input.required<string>();

  private readonly view = viewChild<ElementRef<HTMLElement>>('view');
  private attached: TerminalTab | null = null;

  protected readonly busy = signal(false);
  protected readonly tabs = computed(() => this.sessions.tabs(this.hostId()));
  protected readonly activeTab = computed(() => this.sessions.active(this.hostId()));
  protected readonly activeIndex = computed(() => {
    const active = this.activeTab();
    return active ? this.tabs().indexOf(active) : 0;
  });
  protected readonly endedReason = computed(() => {
    const reason = this.activeTab()?.reason();
    return reason ? ENDED_REASONS[reason] : '';
  });

  constructor() {
    afterRenderEffect(() => {
      this.sessions.applyTheme(this.host.nativeElement, this.theme.effective());
    });
    afterRenderEffect((onCleanup) => {
      const container = this.view()?.nativeElement;
      const tab = this.activeTab();
      if (!container || !tab) {
        return;
      }
      if (this.attached && this.attached !== tab) {
        this.sessions.detach(this.attached);
      }
      this.attached = tab;
      this.sessions.attach(tab, container);
      const observer = new ResizeObserver(() => this.sessions.fit(tab));
      observer.observe(container);
      onCleanup(() => observer.disconnect());
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.attached) {
        this.sessions.detach(this.attached);
      }
    });
  }

  protected select(index: number): void {
    const tab = this.tabs()[index];
    if (tab) {
      this.sessions.select(tab);
    }
  }

  protected async newTerminal(): Promise<void> {
    const hostId = this.hostId();
    if (await this.ensureConnected(hostId)) {
      await this.sessions.open(hostId);
    }
  }

  protected async reopen(tab: TerminalTab): Promise<void> {
    if (await this.ensureConnected(tab.hostId)) {
      await this.sessions.reopen(tab);
    }
  }

  protected close(tab: TerminalTab): void {
    void this.sessions.close(tab);
  }

  private async ensureConnected(hostId: string): Promise<boolean> {
    if (this.ssh.stateOf(hostId) === 'connected') {
      return true;
    }
    this.busy.set(true);
    try {
      await this.connector.connect(hostId);
    } finally {
      this.busy.set(false);
    }
    return this.ssh.stateOf(hostId) === 'connected';
  }
}
