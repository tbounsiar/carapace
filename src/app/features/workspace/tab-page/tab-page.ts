import {
  afterNextRender,
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { connectionTarget, hostTarget } from '../../../core/ipc/connection';
import { ConfigService } from '../../../core/ipc/config';
import { EditorPanel } from '../../editor/editor-panel/editor-panel';
import { FilesPanel } from '../../files/files-panel/files-panel';
import { TerminalPanel } from '../../terminal/terminal-panel/terminal-panel';
import { TAB_PANEL_ID, tabElementId } from '../tab-strip/tab-strip';
import { Workspace } from '../workspace';

/** `/tabs/:tabId`: the content of the active workspace tab, filling the rest of the window. */
@Component({
  imports: [EditorPanel, FilesPanel, TerminalPanel],
  selector: 'app-tab-page',
  styleUrl: './tab-page.scss',
  templateUrl: './tab-page.html',
  host: {
    role: 'tabpanel',
    'data-testid': 'tab-panel',
    '[id]': 'panelId',
    '[attr.aria-labelledby]': 'labelledBy()',
    '[style.--app-panel-top.px]': 'top()',
  },
})
export class TabPage {
  private readonly workspace = inject(Workspace);
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly tabId = input.required<string>();

  private readonly terminal = viewChild(TerminalPanel);
  private readonly editor = viewChild(EditorPanel);
  protected readonly panelId = TAB_PANEL_ID;
  protected readonly top = signal(0);
  protected readonly tab = computed(() => this.workspace.find(this.tabId()));
  protected readonly labelledBy = computed(() => {
    const tab = this.tab();
    return tab ? tabElementId(tab) : null;
  });
  protected readonly target = computed(() => {
    const tab = this.tab();
    if (!tab) {
      return null;
    }
    const host = this.config.findHost(tab.hostId)?.host;
    return host ? hostTarget(host) : connectionTarget(null, tab.hostId);
  });

  constructor() {
    effect(() => {
      if (!this.tab()) {
        untracked(() => void this.router.navigate(['/']));
      }
    });
    let request = untracked(this.workspace.focusRequest);
    effect(() => {
      const next = this.workspace.focusRequest();
      this.tab();
      if (next !== request) {
        request = next;
        afterNextRender(() => this.focusContent(), { injector: this.injector });
      }
    });
    // The panel ends at the window bottom: a definite height for xterm's fit and CodeMirror.
    const measure = () => this.top.set(Math.round(this.host.getBoundingClientRect().top));
    afterRenderEffect(() => {
      this.tab();
      measure();
    });
    window.addEventListener('resize', measure);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', measure));
  }

  /**
   * A dialog that just closed (host key, credentials) keeps the page inert during its leave
   * animation, and focus() is then a silent no-op: retry a few times while nothing else has focus.
   */
  private focusContent(attempt = 0): void {
    this.focusOnce();
    const active = document.activeElement;
    const lost =
      !active || active === document.body || !active.isConnected || !!active.closest('tui-modal');
    if (attempt < 10 && lost && !this.host.contains(active)) {
      setTimeout(() => this.focusContent(attempt + 1), 100);
    }
  }

  private focusOnce(): void {
    const kind = this.tab()?.kind;
    if (kind === 'terminal') {
      this.terminal()?.focus();
    } else if (kind === 'edit') {
      this.editor()?.focus();
    } else if (kind === 'files') {
      const target =
        this.host.querySelector<HTMLElement>('[data-testid="pane-remote"] [tabindex="0"]') ??
        this.host.querySelector<HTMLElement>('[data-testid="pane-connect"]') ??
        this.host.querySelector<HTMLElement>('[data-testid="pane-local"] [tabindex="0"]');
      target?.focus();
    }
  }
}
