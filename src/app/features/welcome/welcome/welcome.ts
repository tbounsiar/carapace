import { Component, computed, inject } from '@angular/core';
import { TuiButton } from '@taiga-ui/core';
import { TuiAvatar } from '@taiga-ui/kit';
import { TuiBlockStatus } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
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

  protected createProject(): void {
    this.actions.createProject();
  }
}
