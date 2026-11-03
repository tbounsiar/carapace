import { Component, computed, inject } from '@angular/core';
import { TuiButton, TuiTitle } from '@taiga-ui/core';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { ProjectActions } from '../../project-tree/project-actions';

const HOME_ROOT = { projectId: null, parentId: null };

/** The Home page (`/`): hosts and collections outside projects, and the projects. */
@Component({
  imports: [TuiBlockStatus, TuiButton, TuiHeader, TuiTitle],
  selector: 'app-welcome',
  styleUrl: './welcome.scss',
  templateUrl: './welcome.html',
})
export class Welcome {
  private readonly config = inject(ConfigService);
  private readonly actions = inject(ProjectActions);

  protected readonly loaded = this.config.loaded;
  protected readonly empty = computed(
    () =>
      this.config.projects().length === 0 && !this.config.nodes().some((n) => n.projectId === null),
  );

  protected readonly hint = computed(() =>
    this.config.nodes().some((n) => n.kind === 'host' && n.projectId === null)
      ? 'Pick a host in the sidebar, or double-click a project to open it.'
      : 'Double-click a project to open it.',
  );

  protected createProject(): void {
    this.actions.createProject();
  }

  protected addHost(): void {
    this.actions.addHost(HOME_ROOT);
  }

  protected addCollection(): void {
    this.actions.addCollection(HOME_ROOT);
  }
}
