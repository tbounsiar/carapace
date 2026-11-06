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
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiDropdownDirective,
  TuiNotification,
  TuiNotificationService,
} from '@taiga-ui/core';
import { TuiButtonLoading } from '@taiga-ui/kit';
import { ClipboardText } from '../../../core/clipboard/clipboard-text';
import type { ConnectionTarget } from '../../../core/ipc/connection';
import { SshService } from '../../../core/ipc/ssh';
import { Settings } from '../../../core/settings/settings';
import { ThemeService } from '../../../core/theme/theme';
import { OptionLabel } from '../../../shared/option-reason/option-label';
import { OptionReason } from '../../../shared/option-reason/option-reason';
import { ContextMenuTarget } from '../../../shared/context-menu/context-menu-target';
import { HostConnector } from '../../host-connection/host-connector';
import {
  inTerminal,
  isMenuKey,
  onApple,
  terminalKey,
  type TerminalKey,
} from '../../workspace/workspace-keys';
import { type TerminalTab, TerminalSessions } from '../terminal-sessions';

const SHORTCUTS: Readonly<Record<TerminalKey, { text: string; aria: string }>> = onApple()
  ? {
      copy: { text: '⌘C', aria: 'Meta+C' },
      paste: { text: '⌘V', aria: 'Meta+V' },
      selectAll: { text: '⌘A', aria: 'Meta+A' },
    }
  : {
      copy: { text: 'Ctrl+Shift+C', aria: 'Control+Shift+C' },
      paste: { text: 'Ctrl+Shift+V', aria: 'Control+Shift+V' },
      selectAll: { text: 'Ctrl+Shift+A', aria: 'Control+Shift+A' },
    };

/** One terminal of the workspace: its ended banner, the xterm view and its context menu. */
@Component({
  imports: [
    ContextMenuTarget,
    OptionLabel,
    OptionReason,
    TranslocoPipe,
    TuiButton,
    TuiButtonLoading,
    TuiDataList,
    TuiDropdown,
    TuiNotification,
  ],
  selector: 'app-terminal-panel',
  styleUrl: './terminal-panel.scss',
  templateUrl: './terminal-panel.html',
  host: { '(keydown)': 'onKeydown($event)' },
})
export class TerminalPanel {
  private readonly sessions = inject(TerminalSessions);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly theme = inject(ThemeService);
  private readonly settings = inject(Settings);
  private readonly clipboard = inject(ClipboardText);
  private readonly alerts = inject(TuiNotificationService);
  private readonly transloco = inject(TranslocoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly tab = input.required<TerminalTab>();
  readonly target = input.required<ConnectionTarget>();

  private readonly view = viewChild<ElementRef<HTMLElement>>('view');
  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  private readonly dropdown = viewChild(TuiDropdownDirective);
  private attached: TerminalTab | null = null;

  protected readonly shortcuts = SHORTCUTS;
  protected readonly busy = signal(false);
  /** Read when the menu opens: xterm has no signal for its selection. */
  protected readonly hasSelection = signal(false);
  protected readonly ended = computed(() => this.tab().state() === 'ended');
  protected readonly lost = computed(
    () =>
      this.tab().reason() === 'connectionLost' ||
      this.ssh.endReasons()[this.target().connectionId] === 'lost',
  );
  /** Translation key of the end reason. */
  protected readonly endedReason = computed(() => {
    const reason = this.tab().reason();
    return reason ? `terminal.panel.reasons.${reason}` : null;
  });

  constructor() {
    // The menu takes the keyboard, else arrows and Escape go to the shell. Taiga's context dropdown
    // ignores an Escape from inside its own content, so the data list closes itself on Escape.
    let menuWasOpen = false;
    afterRenderEffect(() => {
      const ref = this.dropdown()?.ref();
      if (ref) {
        menuWasOpen = true;
        (ref.location.nativeElement as HTMLElement)
          .querySelector<HTMLElement>('[tuiOption]')
          ?.focus({ preventScroll: true });
      } else if (menuWasOpen) {
        menuWasOpen = false;
        const focused = document.activeElement;
        if (!focused || focused === document.body) {
          this.focus();
        }
      }
    });
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
    // Capture phase: xterm stops Escape at its textarea, which would also send ESC to the shell.
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && this.dropdown()?.ref()) {
        event.preventDefault();
        event.stopPropagation();
        this.dropdown()?.toggle(false);
      }
    };
    this.host.nativeElement.addEventListener('keydown', onEscape, true);
    inject(DestroyRef).onDestroy(() => {
      this.host.nativeElement.removeEventListener('keydown', onEscape, true);
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

  /**
   * A program that reads the mouse (tmux, htop, vim) owns the plain right click; Shift+right click
   * bypasses it, as it does for selecting text. Runs before the frame's context dropdown.
   */
  protected guardContextMenu(event: MouseEvent): void {
    if (this.xterm()?.mouseTracking && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  protected onMenuOpen(): void {
    this.hasSelection.set(!!this.xterm()?.hasSelection());
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (!inTerminal(event.target)) {
      return;
    }
    if (isMenuKey(event)) {
      event.preventDefault();
      this.openAtCursor();
      return;
    }
    const key = terminalKey(event);
    if (key) {
      // Also stops the browser's own paste (Ctrl+Shift+V) and devtools (Ctrl+Shift+C) commands.
      event.preventDefault();
      this.run(key);
    }
  }

  protected run(action: TerminalKey | 'clear'): void {
    const xterm = this.xterm();
    if (!xterm) {
      return;
    }
    switch (action) {
      case 'copy':
        void this.copy(xterm.getSelection());
        break;
      case 'paste':
        void this.paste();
        break;
      case 'selectAll':
        xterm.selectAll();
        break;
      case 'clear':
        xterm.clear();
        break;
    }
    this.focus();
  }

  private xterm() {
    return this.sessions.view(this.tab());
  }

  /** Taiga's context dropdown opens at the pointer of a contextmenu event: give it the cursor cell. */
  private openAtCursor(): void {
    const frame = this.frame()?.nativeElement;
    if (!frame) {
      return;
    }
    const rect = frame.getBoundingClientRect();
    const point = this.xterm()?.cursorPoint() ?? { x: rect.left, y: rect.top };
    frame.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
      }),
    );
  }

  private async copy(text: string): Promise<void> {
    if (!text) {
      return;
    }
    try {
      await this.clipboard.write(text);
    } catch {
      this.notify('copyFailed', 'copyFailedText');
    }
  }

  private async paste(): Promise<void> {
    if (this.ended()) {
      return;
    }
    let text: string;
    try {
      text = await this.clipboard.read();
    } catch {
      this.notify('pasteFailed', 'pasteFailedText');
      return;
    }
    if (text && !this.ended()) {
      this.xterm()?.paste(text);
    }
  }

  private notify(label: string, content: string): void {
    const t = (key: string) => this.transloco.translate(`terminal.menu.${key}`);
    this.alerts.open(t(content), { label: t(label), appearance: 'negative' }).subscribe();
  }
}
