import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TuiButton, TuiDataList, TuiDropdown } from '@taiga-ui/core';
import { TuiChevron, TuiStatus } from '@taiga-ui/kit';
import { ConfigService } from '../../../core/ipc/config';
import type { Project } from '../../../core/ipc/config.models';
import { SshService } from '../../../core/ipc/ssh';
import { ThemeService } from '../../../core/theme/theme';
import { connectedCounts } from '../../../shared/connection-status';
import { CurrentScope } from '../../../shared/current-scope';
import { byName, HOME, plural } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';

/** Header selector: where the user is (Home or a project), and the way to go elsewhere. */
@Component({
  imports: [TuiButton, TuiChevron, TuiDataList, TuiDropdown, TuiStatus],
  selector: 'app-project-select',
  templateUrl: './project-select.html',
  styleUrl: './project-select.scss',
})
export class ProjectSelect {
  private readonly config = inject(ConfigService);
  private readonly scope = inject(CurrentScope);
  private readonly ssh = inject(SshService);
  private readonly actions = inject(ProjectActions);
  private readonly router = inject(Router);

  protected readonly theme = inject(ThemeService).effective;
  protected readonly open = signal(false);
  protected readonly current = this.scope.project;
  protected readonly label = computed(() => this.current()?.name ?? HOME);
  protected readonly projects = computed(() => [...this.config.projects()].sort(byName));
  private readonly counts = computed(() => connectedCounts(this.config.hosts(), this.ssh.states()));

  protected connections(project: Project): number {
    return this.counts().get(project.id) ?? 0;
  }

  protected connectionsLabel(project: Project): string {
    return `${plural(this.connections(project), 'open connection')}`;
  }

  protected isCurrent(project: Project | null): boolean {
    return (this.current()?.id ?? null) === (project?.id ?? null);
  }

  protected go(project: Project | null): void {
    this.open.set(false);
    void this.router.navigate(project ? ['/projects', project.id] : ['/']);
  }

  protected newProject(): void {
    this.open.set(false);
    this.actions.createProject();
  }
}
