import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiTitle } from '@taiga-ui/core';
import { TuiSkeleton, TuiStatus } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiCardLarge, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
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
import { HostLauncher } from '../../host-connection/host-launcher';
import { byName, countNodes, HOME, plural, scopeTree } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';
import { errorText } from '../../project-tree/save-error';

const HOME_ROOT = { projectId: null, parentId: null };

/** The Home page (`/`): the projects, then hosts and collections outside projects. */
@Component({
  imports: [
    HostGroups,
    HostsToolbar,
    RouterLink,
    TuiBlockStatus,
    TuiButton,
    TuiCardLarge,
    TuiHeader,
    TuiIcon,
    TuiSkeleton,
    TuiStatus,
    TuiTitle,
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

  private readonly toolbar = viewChild(HostsToolbar);
  protected readonly placeholders = [1, 2, 3, 4, 5, 6];

  protected readonly query = signal('');
  protected readonly connectedOnly = signal(false);

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
          connections: connected ? plural(connected, 'open connection') : null,
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

  protected createProject(): void {
    this.actions.createProject();
  }

  protected addHost(): void {
    this.actions.addHost(HOME_ROOT);
  }

  protected addCollection(): void {
    this.actions.addCollection(HOME_ROOT);
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
}
