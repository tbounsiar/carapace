import { NgTemplateOutlet } from '@angular/common';
import {
  afterEveryRender,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiItem } from '@taiga-ui/cdk';
import { TuiButton, TuiDataList, TuiDropdown, TuiHint, TuiIcon, TuiLoader } from '@taiga-ui/core';
import { TuiBadgeNotification, TuiStatus, TuiTabs, TuiTabsWithMore } from '@taiga-ui/kit';
import { ConfigService } from '../../../core/ipc/config';
import { OpenDialogs } from '../../../shared/open-dialogs';
import { uiText } from '../../../shared/ui-text';
import { OptionLabel } from '../../../shared/option-reason/option-label';
import { OptionReason } from '../../../shared/option-reason/option-reason';
import { HostLauncher } from '../../host-connection/host-launcher';
import { type TabTitle, tabLabel, tabTitles, terminalNumber } from '../tab-titles';
import { Workspace, type WorkspaceTab } from '../workspace';
import { type TabMenuEntry, WorkspaceActions } from '../workspace-actions';
import { inTerminal, workspaceKey } from '../workspace-keys';

export const TAB_PANEL_ID = 'workspace-tab-panel';

export function tabElementId(tab: WorkspaceTab): string {
  return `workspace-tab-${tab.id}`;
}

/** `{host}-terminal-{n}`, `{host}-files`, `{host}-edit-{name}`: the test id suffix of a tab. */
export function tabTestSuffix(tab: WorkspaceTab, host: string): string {
  if (tab.kind === 'terminal') {
    return `${host}-terminal-${terminalNumber(tab) ?? tab.label.replace('Terminal ', '')}`;
  }
  return tab.kind === 'files' ? `${host}-files` : `${host}-edit-${tab.label}`;
}

/** Every open tab of every host, on every route; no tab is selected off `/tabs/:id`. */
@Component({
  imports: [
    NgTemplateOutlet,
    OptionLabel,
    OptionReason,
    TranslocoPipe,
    TuiBadgeNotification,
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiHint,
    TuiIcon,
    TuiItem,
    TuiLoader,
    TuiStatus,
    TuiTabs,
  ],
  selector: 'app-tab-strip',
  host: { '[style.display]': "tabs().length ? 'flex' : 'none'" },
  templateUrl: './tab-strip.html',
  styleUrl: './tab-strip.scss',
})
export class TabStrip {
  private readonly workspace = inject(Workspace);
  private readonly actions = inject(WorkspaceActions);
  private readonly launcher = inject(HostLauncher);
  private readonly config = inject(ConfigService);
  private readonly dialogs = inject(OpenDialogs);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly strip = viewChild(TuiTabsWithMore);

  protected readonly panelId = TAB_PANEL_ID;
  protected readonly tabs = this.workspace.tabs;
  protected readonly active = this.workspace.active;
  protected readonly activeIndex = computed(() => {
    const active = this.active();
    return active ? this.tabs().indexOf(active) : -1;
  });
  protected readonly titles = computed(() =>
    tabTitles(this.tabs(), this.config.hosts(), this.config.projects(), this.config.nodes()),
  );
  protected readonly menuTab = signal<WorkspaceTab | null>(null);
  protected readonly menuEntries = computed<TabMenuEntry[]>(() => {
    const tab = this.menuTab();
    return tab ? this.actions.menu(tab) : [];
  });
  protected readonly newHint = computed(() => {
    const active = this.active();
    if (!active) {
      return uiText('workspace.strip.selectFirst');
    }
    const host = this.titles().get(active.id)?.host;
    return host ? uiText('workspace.strip.newOn', { host }) : uiText('workspace.strip.newHere');
  });

  constructor() {
    const onKeydown = (event: KeyboardEvent) => this.onShortcut(event);
    // Capture phase on the document: runs before xterm and CodeMirror see the key.
    document.addEventListener('keydown', onKeydown, true);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', onKeydown, true));
    // Off a tab (the More button, the gaps) the browser menu is kept and the strip menu is not opened.
    const onContextmenu = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.('[data-tab]')) {
        event.stopPropagation();
      }
    };
    this.host.addEventListener('contextmenu', onContextmenu, true);
    // With no active tab Taiga gives every tab tabindex -1; the strip keeps one tab stop.
    afterEveryRender({
      read: () => {
        if (this.activeIndex() >= 0) {
          return;
        }
        const tabs = [...this.host.querySelectorAll<HTMLElement>('tui-tabs [tuiTab]')];
        if (tabs.length && !tabs.some((t) => t.tabIndex === 0)) {
          tabs[0].tabIndex = 0;
        }
      },
    });
  }

  protected title(tab: WorkspaceTab): TabTitle {
    const label = tabLabel(tab);
    return (
      this.titles().get(tab.id) ?? {
        path: '',
        host: '',
        label,
        title: label,
        hint: label,
        aria: label,
      }
    );
  }

  protected suffix(tab: WorkspaceTab): string {
    return tabTestSuffix(tab, this.title(tab).host);
  }

  protected tabId(tab: WorkspaceTab): string {
    return tabElementId(tab);
  }

  protected hiddenTabs(): WorkspaceTab[] {
    const strip = this.strip();
    return strip ? this.tabs().filter((_, i) => strip.shouldShow(i)) : [];
  }

  protected async select(index: number): Promise<void> {
    const tab = this.tabs()[index];
    if (tab && !(await this.workspace.activate(tab))) {
      this.strip()?.activeItemIndex.set(this.activeIndex());
    }
  }

  protected activate(tab: WorkspaceTab): void {
    void this.workspace.activate(tab);
  }

  protected close(tab: WorkspaceTab): void {
    void this.actions.close(tab);
  }

  protected newTerminal(): void {
    const host = this.hostOf(this.active());
    if (host) {
      void this.launcher.newTerminal(host);
    }
  }

  protected onContextmenu(event: MouseEvent): void {
    const id = (event.target as Element | null)?.closest?.('[data-tab]')?.getAttribute('data-tab');
    this.menuTab.set(id ? this.workspace.find(id) : null);
  }

  protected run(entry: TabMenuEntry): void {
    entry.run();
  }

  /** Middle click closes; its mousedown would otherwise start autoscroll. */
  protected onAuxclick(event: MouseEvent, tab: WorkspaceTab): void {
    if (event.button === 1) {
      event.preventDefault();
      this.close(tab);
    }
  }

  protected onMousedown(event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
    }
  }

  protected onTabKeydown(event: KeyboardEvent, tab: WorkspaceTab): void {
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
    if (event.key === 'Delete' && plain && !event.shiftKey) {
      event.preventDefault();
      this.close(tab);
      return;
    }
    if (
      (event.key === 'F10' && event.shiftKey && plain) ||
      (event.key === 'ContextMenu' && plain)
    ) {
      event.preventDefault();
      // Taiga's context dropdown opens at the pointer of a contextmenu event: give it the tab's corner.
      const element = event.currentTarget as HTMLElement;
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left,
          clientY: rect.bottom,
        }),
      );
    }
  }

  private hostOf(tab: WorkspaceTab | null) {
    return tab ? (this.config.findHost(tab.hostId)?.host ?? null) : null;
  }

  private onShortcut(event: KeyboardEvent): void {
    const key = workspaceKey(event);
    if (!key || !this.dialogs.none()) {
      return;
    }
    const tabs = this.tabs();
    const active = this.active();
    const index = active ? tabs.indexOf(active) : -1;
    let target: WorkspaceTab | undefined;
    switch (key.kind) {
      case 'next':
        target = tabs[index < 0 ? 0 : (index + 1) % tabs.length];
        break;
      case 'previous':
        target = tabs[index < 0 ? tabs.length - 1 : (index - 1 + tabs.length) % tabs.length];
        break;
      case 'index':
        target = tabs[key.index];
        break;
      case 'last':
        target = tabs.at(-1);
        break;
      case 'closeOutsideTerminal':
        if (inTerminal(event.target)) {
          return;
        }
        if (!active) {
          return;
        }
        this.close(active);
        break;
      case 'close':
        if (!active) {
          return;
        }
        this.close(active);
        break;
      case 'newTerminal':
        if (!active) {
          return;
        }
        this.newTerminal();
        break;
    }
    if (
      (key.kind === 'next' ||
        key.kind === 'previous' ||
        key.kind === 'index' ||
        key.kind === 'last') &&
      !target
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target) {
      this.activate(target);
    }
  }
}
