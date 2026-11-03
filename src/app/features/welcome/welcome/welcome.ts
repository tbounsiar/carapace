import { Component, computed, inject } from '@angular/core';
import { TuiButton } from '@taiga-ui/core';
import { TuiAvatar } from '@taiga-ui/kit';
import { TuiBlockStatus } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import type { Project } from '../../../core/ipc/config.models';
import { ProjectActions } from '../../project-tree/project-actions';

@Component({
  imports: [TuiAvatar, TuiBlockStatus, TuiButton],
  selector: 'app-welcome',
  styleUrl: './welcome.scss',
  templateUrl: './welcome.html',
})
export class Welcome {
  private readonly config = inject(ConfigService);
  private readonly actions = inject(ProjectActions);

  protected readonly hasProjects = computed(() => this.config.projects().length > 0);
  /** Only when no project has a host: then "select a host" would point at nothing. */
  protected readonly firstEmptyProject = computed(() => {
    const projects = this.config.projects();
    return projects.length && projects.every((p) => p.hosts.length === 0) ? projects[0] : null;
  });

  protected createProject(): void {
    this.actions.createProject();
  }

  protected addHost(project: Project): void {
    this.actions.addHost(project);
  }
}
