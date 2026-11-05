import { Component, computed, inject, input, linkedSignal, viewChild } from '@angular/core';
import { TuiButton } from '@taiga-ui/core';
import { TuiSkeleton } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiCardLarge } from '@taiga-ui/layout';
import { TranslocoPipe } from '@jsverse/transloco';
import { ConfigService } from '../../../core/ipc/config';
import { SshService } from '../../../core/ipc/ssh';
import {
  boardLookups,
  countHosts,
  countText,
  filterGroups,
  hostGroups,
  isFiltering,
} from '../../dashboard/board';
import { HostGroups } from '../../dashboard/host-groups/host-groups';
import { HostsToolbar } from '../../dashboard/hosts-toolbar/hosts-toolbar';
import { HostLauncher } from '../../host-connection/host-launcher';
import { scopeTree } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';

/** The project dashboard's Hosts tab: hosts as cards grouped by collection, with search. */
@Component({
  imports: [
    HostGroups,
    HostsToolbar,
    TranslocoPipe,
    TuiBlockStatus,
    TuiButton,
    TuiCardLarge,
    TuiSkeleton,
  ],
  selector: 'app-project-hosts',
  styleUrl: './project-hosts.scss',
  templateUrl: './project-hosts.html',
})
export class ProjectHosts {
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly actions = inject(ProjectActions);
  private readonly launcher = inject(HostLauncher);

  readonly projectId = input.required<string>();

  private readonly toolbar = viewChild(HostsToolbar);
  protected readonly placeholders = [1, 2, 3, 4, 5, 6];

  /** Page state: reset when the project changes, never persisted. */
  protected readonly query = linkedSignal({ source: this.projectId, computation: () => '' });
  protected readonly connectedOnly = linkedSignal({
    source: this.projectId,
    computation: () => false,
  });

  protected readonly loaded = this.config.loaded;
  private readonly project = computed(() => this.config.findProject(this.projectId()));
  private readonly nodes = computed(() =>
    this.config.nodes().filter((n) => n.projectId === this.projectId()),
  );
  protected readonly empty = computed(() => this.nodes().length === 0);
  private readonly groups = computed(() =>
    hostGroups(scopeTree(this.nodes(), this.projectId()), this.project()?.name ?? '', false),
  );
  private readonly total = computed(() => countHosts(this.groups()));
  protected readonly noHosts = computed(() => !this.empty() && this.total() === 0);

  private readonly filter = computed(() => ({
    query: this.query(),
    connectedOnly: this.connectedOnly(),
  }));
  protected readonly visible = computed(() =>
    filterGroups(
      this.groups(),
      this.filter(),
      boardLookups(this.config.variables(), this.config.projects(), this.ssh.states()),
    ),
  );
  protected readonly count = computed(() =>
    isFiltering(this.filter()) ? countText(countHosts(this.visible()), this.total()) : null,
  );
  protected readonly trimmedQuery = computed(() => this.query().trim());

  protected newHost(): void {
    this.actions.addHost({ projectId: this.projectId(), parentId: null });
  }

  protected newCollection(): void {
    this.actions.addCollection({ projectId: this.projectId(), parentId: null });
  }

  protected openFirst(): void {
    const host = this.visible()[0]?.hosts[0];
    if (host) {
      void this.launcher.openTerminal(host);
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
