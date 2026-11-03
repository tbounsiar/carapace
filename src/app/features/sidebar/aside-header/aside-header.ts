import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TuiDataList, TuiDropdown, TuiHint } from '@taiga-ui/core';
import { TuiChevron } from '@taiga-ui/kit';
import { TuiNavigation } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { ThemeService } from '../../../core/theme/theme';
import { CurrentScope } from '../../../shared/current-scope';
import { EnvSelect } from '../../env-select/env-select/env-select';
import { ProjectActions } from '../../project-tree/project-actions';

/** Aside `<header>` content: the project, its environment and variables, and the New menu. */
@Component({
  imports: [EnvSelect, RouterLink, TuiChevron, TuiDataList, TuiDropdown, TuiHint, TuiNavigation],
  selector: 'app-aside-header',
  templateUrl: './aside-header.html',
  styleUrl: './aside-header.scss',
})
export class AsideHeader {
  private readonly config = inject(ConfigService);
  private readonly scope = inject(CurrentScope);
  private readonly actions = inject(ProjectActions);

  protected readonly project = this.scope.project;
  protected readonly loaded = this.config.loaded;
  protected readonly theme = inject(ThemeService).effective;
  protected readonly newOpen = signal(false);

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
