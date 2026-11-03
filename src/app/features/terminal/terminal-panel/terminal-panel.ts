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
import type { ConnectionTarget } from '../../../core/ipc/connection';
import { SshService } from '../../../core/ipc/ssh';
import { Settings } from '../../../core/settings/settings';
import { ThemeService } from '../../../core/theme/theme';
import { HostConnector } from '../../host-connection/host-connector';
import { type TerminalTab, TerminalSessions } from '../terminal-sessions';

const ENDED_REASONS = {
  exited: 'The shell exited.',
  closed: 'The terminal was closed.',
  connectionLost: 'The connection was lost.',
} as const;

let panels = 0;

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
  private readonly settings = inject(Settings);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly target = input.required<ConnectionTarget>();

  private readonly view = viewChild<ElementRef<HTMLElement>>('view');
  private readonly uid = ++panels;
  protected readonly panelId = `terminal-panel-${this.uid}`;
  private attached: TerminalTab | null = null;

  protected readonly busy = signal(false);
  protected readonly tabs = computed(() => this.sessions.tabs(this.target().connectionId));
  protected readonly activeTab = computed(() => this.sessions.active(this.target().connectionId));
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
      this.sessions.applyAppearance(
        this.host.nativeElement,
        this.theme.effective(),
        this.settings.terminalFontSize(),
      );
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

  protected tabId(tab: TerminalTab): string {
    return `terminal-tab-${this.uid}-${tab.key}`;
  }

  protected title(tab: TerminalTab): string {
    return `Terminal ${tab.n}`;
  }

  protected async newTerminal(): Promise<void> {
    const target = this.target();
    if (await this.ensureConnected(target)) {
      await this.sessions.open(target.connectionId);
    }
  }

  protected async reopen(tab: TerminalTab): Promise<void> {
    if (await this.ensureConnected(this.target())) {
      await this.sessions.reopen(tab);
    }
  }

  protected close(tab: TerminalTab): void {
    void this.sessions.close(tab);
  }

  private async ensureConnected(target: ConnectionTarget): Promise<boolean> {
    if (this.ssh.stateOf(target.connectionId) === 'connected') {
      return true;
    }
    this.busy.set(true);
    try {
      await this.connector.connect(target);
    } finally {
      this.busy.set(false);
    }
    return this.ssh.stateOf(target.connectionId) === 'connected';
  }
}
