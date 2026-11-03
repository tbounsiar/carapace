import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiButton, TuiTitle } from '@taiga-ui/core';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { countNodes, countText, plural } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';

/** `/projects/:projectId`: what the project holds. */
@Component({
  imports: [RouterLink, TuiBlockStatus, TuiButton, TuiHeader, TuiTitle],
  selector: 'app-project-home',
  templateUrl: './project-home.html',
  styleUrl: './project-home.scss',
})
export class ProjectHome {
  private readonly config = inject(ConfigService);
  private readonly actions = inject(ProjectActions);

  readonly projectId = input.required<string>();

  protected readonly project = computed(() => this.config.findProject(this.projectId()));
  protected readonly notFound = computed(() => !this.project() && this.config.loaded());
  private readonly nodes = computed(() =>
    this.config.nodes().filter((n) => n.projectId === this.projectId()),
  );
  protected readonly empty = computed(() => this.nodes().length === 0);

  protected readonly summary = computed(() => {
    const counts = countNodes(this.nodes());
    if (!counts.hosts) {
      return 'No hosts yet';
    }
    if (!counts.collections) {
      return plural(counts.hosts, 'host');
    }
    return `${plural(counts.hosts, 'host')} in ${countText({ collections: counts.collections, hosts: 0 })}`;
  });

  protected newHost(): void {
    this.actions.addHost({ projectId: this.projectId(), parentId: null });
  }

  protected newCollection(): void {
    this.actions.addCollection({ projectId: this.projectId(), parentId: null });
  }
}
