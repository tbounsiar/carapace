import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { type TuiStringHandler } from '@taiga-ui/cdk';
import { TuiDataList, TuiNotificationService, TuiTextfield } from '@taiga-ui/core';
import { TuiBadge, TuiChevron, TuiSelect } from '@taiga-ui/kit';
import { ConfigService } from '../../../core/ipc/config';
import { CurrentProject } from '../../../shared/current-project';
import { environmentMarker, type EnvironmentMarker } from '../../../shared/environment-kind';
import { notifyError } from '../../project-tree/save-error';

/** Environment ids are UUIDs, so this can't collide with one. */
const NONE = 'none';

@Component({
  imports: [FormsModule, TuiBadge, TuiChevron, TuiDataList, TuiSelect, TuiTextfield],
  selector: 'app-env-select',
  styleUrl: './env-select.scss',
  templateUrl: './env-select.html',
})
export class EnvSelect {
  private readonly config = inject(ConfigService);
  private readonly current = inject(CurrentProject);
  private readonly alerts = inject(TuiNotificationService);

  protected readonly none = NONE;
  protected readonly project = this.current.project;
  protected readonly selected = computed(() => this.current.environment()?.id ?? NONE);
  protected readonly marker = computed(() => {
    const env = this.current.environment();
    return env ? environmentMarker(env.name) : null;
  });

  protected readonly stringify: TuiStringHandler<string> = (id) =>
    this.project()?.environments.find((e) => e.id === id)?.name ?? 'No environment';

  protected markerOf(name: string): EnvironmentMarker {
    return environmentMarker(name);
  }

  protected async choose(id: string | null): Promise<void> {
    const project = this.project();
    const environmentId = !id || id === NONE ? null : id;
    if (!project || environmentId === project.activeEnvironmentId) {
      return;
    }
    try {
      await this.config.setActiveEnvironment(project.id, environmentId);
    } catch (err) {
      notifyError(this.alerts, err, 'Environment not changed');
    }
  }
}
