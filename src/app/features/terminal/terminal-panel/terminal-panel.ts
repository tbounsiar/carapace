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
import { TuiButton, TuiNotification } from '@taiga-ui/core';
import { TuiButtonLoading } from '@taiga-ui/kit';
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

/** One terminal of the workspace: its ended banner and the xterm view. */
@Component({
  imports: [TuiButton, TuiButtonLoading, TuiNotification],
  selector: 'app-terminal-panel',
  styleUrl: './terminal-panel.scss',
  templateUrl: './terminal-panel.html',
})
export class TerminalPanel {
  private readonly sessions = inject(TerminalSessions);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly theme = inject(ThemeService);
  private readonly settings = inject(Settings);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly tab = input.required<TerminalTab>();
  readonly target = input.required<ConnectionTarget>();

  private readonly view = viewChild<ElementRef<HTMLElement>>('view');
  private attached: TerminalTab | null = null;

  protected readonly busy = signal(false);
  protected readonly ended = computed(() => this.tab().state() === 'ended');
  protected readonly lost = computed(
    () =>
      this.tab().reason() === 'connectionLost' ||
      this.ssh.endReasons()[this.target().connectionId] === 'lost',
  );
  protected readonly endedReason = computed(() => {
    const reason = this.tab().reason();
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
      const tab = this.tab();
      if (!container) {
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

  focus(): void {
    this.sessions.focus(this.tab());
  }

  protected async reopen(): Promise<void> {
    const target = this.target();
    if (this.ssh.stateOf(target.connectionId) !== 'connected') {
      this.busy.set(true);
      try {
        await this.connector.connect(target);
      } finally {
        this.busy.set(false);
      }
      if (this.ssh.stateOf(target.connectionId) !== 'connected') {
        return;
      }
    }
    await this.sessions.reopen(this.tab());
  }
}
