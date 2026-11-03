import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TuiButton, TuiDataList, TuiDropdown, TuiHint, TuiTitle } from '@taiga-ui/core';
import { TuiSkeleton, TuiTabs } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { SshService } from '../../../core/ipc/ssh';
import { connectedCounts } from '../../../shared/connection-status';
import { statsText } from '../../dashboard/board';
import { countNodes } from '../../project-tree/node-tree';
import { ProjectActions } from '../../project-tree/project-actions';
import { errorText } from '../../project-tree/save-error';

/** `/projects/:projectId`: the project dashboard, its header and the Hosts / Variables tabs. */
@Component({
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TuiBlockStatus,
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiHeader,
    TuiHint,
    TuiSkeleton,
    TuiTabs,
    TuiTitle,
  ],
  selector: 'app-project-home',
  templateUrl: './project-home.html',
  styleUrl: './project-home.scss',
})
export class ProjectHome {
  private readonly config = inject(ConfigService);
  private readonly ssh = inject(SshService);
  private readonly actions = inject(ProjectActions);

  readonly projectId = input.required<string>();

  protected readonly menuOpen = signal(false);
  protected readonly loaded = this.config.loaded;
  protected readonly project = computed(() => this.config.findProject(this.projectId()));
  protected readonly notFound = computed(() => !this.project() && this.config.loaded());
  protected readonly loadError = computed(() => {
    const err = this.config.loadError();
    return err && !this.config.loaded() ? errorText(err) : null;
  });
  private readonly nodes = computed(() =>
    this.config.nodes().filter((n) => n.projectId === this.projectId()),
  );
  protected readonly empty = computed(() => this.nodes().length === 0);

  protected readonly stats = computed(() => {
    const counts = countNodes(this.nodes());
    const connected =
      connectedCounts(this.config.hosts(), this.ssh.states()).get(this.projectId()) ?? 0;
    return statsText({ ...counts, connected });
  });

  protected newHost(): void {
    this.actions.addHost({ projectId: this.projectId(), parentId: null });
  }

  protected newCollection(): void {
    this.menuOpen.set(false);
    this.actions.addCollection({ projectId: this.projectId(), parentId: null });
  }

  protected rename(): void {
    this.menuOpen.set(false);
    const project = this.project();
    if (project) {
      this.actions.renameProject(project);
    }
  }

  protected remove(): void {
    this.menuOpen.set(false);
    const project = this.project();
    if (project) {
      void this.actions.deleteProject(project);
    }
  }

  protected retry(): void {
    // A failure stays visible through `loadError`.
    this.config.load().catch(() => undefined);
  }
}
