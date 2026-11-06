import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiButton, TuiDataList, TuiDropdown, TuiIcon, TuiTitle } from '@taiga-ui/core';
import { TuiButtonLoading, TuiSkeleton, TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiCardLarge, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import type { Project } from '../../../core/ipc/config.models';
import { SshService } from '../../../core/ipc/ssh';
import { connectedCounts } from '../../../shared/connection-status';
import {
  boardLookups,
  countHosts,
  countText,
  filterGroups,
  hostGroups,
  isFiltering,
  projectMatches,
  projectSummary,
  statsText,
} from '../../dashboard/board';
import { HostGroups } from '../../dashboard/host-groups/host-groups';
import { HostsToolbar } from '../../dashboard/hosts-toolbar/hosts-toolbar';
import { DataTransferActions } from '../../data-transfer/data-transfer-actions';
import { HostLauncher } from '../../host-connection/host-launcher';
import { byName, countNodes, HOME, scopeTree } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';
import { errorText } from '../../../shared/save-error';
import { uiText } from '../../../shared/ui-text';
import { ContextMenuTarget } from '../../../shared/context-menu/context-menu-target';

const HOME_ROOT = { projectId: null, parentId: null };

interface ProjectMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly separated?: boolean;
  readonly run: (project: Project) => void;
}

/** The Home page (`/`): the projects, then hosts and collections outside projects. */
@Component({
  imports: [
    ContextMenuTarget,
    HostGroups,
    HostsToolbar,
    RouterLink,
    TuiBlockStatus,
    TuiButton,
    TuiButtonLoading,
    TuiCardLarge,
    TuiDataList,
    TuiDropdown,
    TuiHeader,
    TuiIcon,
    TuiSkeleton,
    TuiStatus,
    TuiTitle,
    TranslocoPipe,
  ],
  selector: 'app-welcome',
  styleUrl: './welcome.scss',
  templateUrl: './welcome.html',
})
export class Welcome {
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly actions = inject(ProjectActions);
  private readonly launcher = inject(HostLauncher);
  private readonly router = inject(Router);
  private readonly transfer = inject(DataTransferActions);

  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly toolbar = viewChild(HostsToolbar);
  protected readonly placeholders = [1, 2, 3, 4, 5, 6];

  protected readonly query = signal('');
  protected readonly connectedOnly = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly importing = this.transfer.importing;

  protected readonly loaded = this.config.loaded;
  protected readonly loadError = computed(() => {
    const err = this.config.loadError();
    return err && !this.config.loaded() ? errorText(err) : null;
  });
  private readonly nodes = computed(() => this.config.nodes().filter((n) => n.projectId === null));
  private readonly projects = computed(() => [...this.config.projects()].sort(byName));
  protected readonly empty = computed(() => this.projects().length === 0 && !this.nodes().length);

  private readonly counts = computed(() => connectedCounts(this.config.hosts(), this.ssh.states()));
  protected readonly stats = computed(() =>
    statsText({
      ...countNodes(this.nodes()),
      connected: this.counts().get(null) ?? 0,
      projects: this.projects().length,
    }),
  );

  private readonly filter = computed(() => ({
    query: this.query(),
    connectedOnly: this.connectedOnly(),
  }));
  protected readonly filtering = computed(() => isFiltering(this.filter()));

  protected readonly projectCards = computed(() => {
    const hosts = this.config.hosts();
    return this.projects()
      .map((project) => {
        const connected = this.counts().get(project.id) ?? 0;
        const count = hosts.filter((h) => h.projectId === project.id).length;
        return {
          project,
          connected,
          summary: projectSummary(count, connected),
        };
      })
      .filter((card) => projectMatches(card.project, this.filter(), card.connected));
  });

  private readonly groups = computed(() => hostGroups(scopeTree(this.nodes(), null), HOME));
  private readonly total = computed(() => countHosts(this.groups()));
  protected readonly hasHosts = computed(() => this.total() > 0);
  protected readonly visible = computed(() =>
    filterGroups(
      this.groups(),
      this.filter(),
      boardLookups(this.config.variables(), this.config.projects(), this.ssh.states()),
    ),
  );
  protected readonly count = computed(() =>
    this.filtering() && this.hasHosts()
      ? countText(countHosts(this.visible()), this.total())
      : null,
  );
  protected readonly showProjects = computed(
    () => !this.filtering() || this.projectCards().length > 0,
  );
  protected readonly nothingVisible = computed(
    () => this.filtering() && !this.projectCards().length && !this.visible().length,
  );
  protected readonly trimmedQuery = computed(() => this.query().trim());

  /** The project whose card was right-clicked last. */
  protected readonly menuProject = signal<Project | null>(null);
  /** The sidebar project row menu, same entries and ids. */
  protected readonly projectMenu = computed<ProjectMenuEntry[]>(() => [
    {
      id: 'menu-open',
      label: uiText('sidebar.menu.openProject'),
      icon: '@tui.arrow-right',
      run: (project) => void this.router.navigate(['/projects', project.id]),
    },
    {
      id: 'menu-variables',
      label: uiText('sidebar.menu.variables'),
      icon: '@tui.variable',
      run: (project) => void this.router.navigate(['/projects', project.id, 'variables']),
    },
    {
      id: 'menu-edit',
      label: uiText('common.rename'),
      icon: '@tui.pencil',
      run: (project) => this.actions.renameProject(project),
    },
    {
      id: 'menu-delete',
      label: uiText('common.delete'),
      icon: '@tui.trash',
      separated: true,
      run: (project) => void this.deleteProject(project),
    },
  ]);

  protected createProject(): void {
    this.actions.createProject();
  }

  protected addHost(): void {
    this.actions.addHost(HOME_ROOT);
  }

  protected addCollection(): void {
    this.actions.addCollection(HOME_ROOT);
  }

  protected exportHome(): void {
    this.menuOpen.set(false);
    void this.transfer.exportData({ kind: 'home' });
  }

  protected importData(): void {
    this.menuOpen.set(false);
    void this.transfer.importData();
  }

  protected retry(): void {
    // A failure stays visible through `loadError`.
    this.config.load().catch(() => undefined);
  }

  protected openFirst(): void {
    const host = this.visible()[0]?.hosts[0];
    if (host) {
      void this.launcher.openTerminal(host);
      return;
    }
    const card = this.projectCards()[0];
    if (card && this.filtering()) {
      void this.router.navigate(['/projects', card.project.id]);
    }
  }

  protected clearSearch(): void {
    this.query.set('');
    this.toolbar()?.focus();
  }

  protected showAll(): void {
    this.connectedOnly.set(false);
    this.toolbar()?.focus();
  }

  protected focusSearch(): void {
    this.toolbar()?.focus();
  }

  protected onCardKeydown(event: KeyboardEvent): void {
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
    if (
      plain &&
      ((event.key === 'F10' && event.shiftKey) || (event.key === 'ContextMenu' && !event.shiftKey))
    ) {
      event.preventDefault();
      // Taiga's context dropdown opens at the pointer of a contextmenu event: give it the card's corner.
      const card = event.currentTarget as HTMLElement;
      const rect = card.getBoundingClientRect();
      card.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left,
          clientY: rect.bottom,
        }),
      );
    }
  }

  protected runProjectEntry(entry: ProjectMenuEntry): void {
    const project = this.menuProject();
    if (!project) {
      return;
    }
    // Dialogs give the focus back to where it was when they opened: the card.
    this.card(project.id)?.focus();
    entry.run(project);
  }

  private async deleteProject(project: Project): Promise<void> {
    const index = this.projectCards().findIndex((c) => c.project.id === project.id);
    if (!(await this.actions.deleteProject(project))) {
      return;
    }
    afterNextRender(
      () => {
        const cards = this.host.querySelectorAll<HTMLElement>('[data-project-card]');
        const next = cards[Math.min(index, cards.length - 1)];
        (next ?? this.host.querySelector<HTMLElement>('[data-testid="home-new-project"]'))?.focus();
      },
      { injector: this.injector },
    );
  }

  private card(projectId: string): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(`[data-project-card="${projectId}"]`);
  }
}
