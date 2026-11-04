import { afterRenderEffect, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiInput,
  TuiTextfield,
} from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { CurrentScope } from '../../../shared/current-scope';
import { HostLauncher } from '../../host-connection/host-launcher';
import { ancestors } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';
import { SidebarFilter } from '../sidebar-filter';
import { SidebarState } from '../sidebar-state';

/** Aside `<header>` content: the host filter and the New menu. */
@Component({
  imports: [TuiButton, TuiDataList, TuiDropdown, TuiHint, TuiInput, TuiTextfield],
  selector: 'app-aside-header',
  templateUrl: './aside-header.html',
  styleUrl: './aside-header.scss',
  host: { '(window:keydown)': 'onWindowKeydown($event)' },
})
export class AsideHeader {
  private readonly config = inject(ConfigService);
  private readonly scope = inject(CurrentScope);
  private readonly actions = inject(ProjectActions);
  private readonly launcher = inject(HostLauncher);
  private readonly state = inject(SidebarState);
  private readonly router = inject(Router);
  protected readonly filter = inject(SidebarFilter);

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  protected readonly isHome = this.scope.isHome;
  protected readonly loaded = this.config.loaded;
  protected readonly newOpen = signal(false);

  constructor() {
    let handled = 0;
    afterRenderEffect(() => {
      const request = this.filter.fieldFocus();
      if (request !== handled) {
        handled = request;
        this.field().nativeElement.focus();
      }
    });
  }

  protected onInput(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        this.openFirstMatch();
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.filter.focusTree();
        break;
      case 'Escape':
        if (this.filter.query()) {
          event.preventDefault();
          this.filter.clear();
        }
        break;
    }
  }

  /** Ctrl+K focuses the filter, except in a terminal, where it is the shell's kill-line. */
  protected onWindowKeydown(event: KeyboardEvent): void {
    const ctrl = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (!ctrl || event.key.toLowerCase() !== 'k') {
      return;
    }
    const target = event.target as Element | null;
    if (target?.closest?.('.terminal-host, .xterm')) {
      return;
    }
    event.preventDefault();
    this.field().nativeElement.focus();
  }

  private openFirstMatch(): void {
    if (!this.filter.active()) {
      return;
    }
    const host = this.filter.firstMatch();
    if (host) {
      this.filter.clear();
      this.state.expand(ancestors(this.config.nodes(), host.id).map((c) => c.id));
      void this.launcher.openTerminal(host);
      return;
    }
    const project = this.filter.visibleProjects()[0];
    if (project) {
      this.filter.clear();
      void this.router.navigate(['/projects', project.id]);
    }
  }

  protected newHost(): void {
    this.newOpen.set(false);
    this.actions.addHost({ projectId: this.scope.projectId(), parentId: null });
  }

  protected newCollection(): void {
    this.newOpen.set(false);
    this.actions.addCollection({ projectId: this.scope.projectId(), parentId: null });
  }

  protected newProject(): void {
    this.newOpen.set(false);
    this.actions.createProject();
  }
}
