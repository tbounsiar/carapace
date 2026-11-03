import { Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TuiDataList, TuiDropdown, TuiNotificationService } from '@taiga-ui/core';
import { TuiBadge, TuiChevron } from '@taiga-ui/kit';
import { TuiNavigation } from '@taiga-ui/layout';
import { ConfigService } from '../../../core/ipc/config';
import { ThemeService } from '../../../core/theme/theme';
import type { Environment, Project } from '../../../core/ipc/config.models';
import { environmentMarker, type EnvironmentMarker } from '../../../shared/environment-kind';
import { notifyError } from '../../project-tree/save-error';

/** The aside header item showing and switching the active environment of the current project. */
@Component({
  imports: [TuiBadge, TuiChevron, TuiDataList, TuiDropdown, TuiNavigation],
  selector: 'app-env-select',
  styleUrl: './env-select.scss',
  templateUrl: './env-select.html',
})
export class EnvSelect {
  private readonly config = inject(ConfigService);
  private readonly alerts = inject(TuiNotificationService);
  private readonly router = inject(Router);

  readonly project = input.required<Project>();

  protected readonly theme = inject(ThemeService).effective;
  protected readonly open = signal(false);
  protected readonly environment = computed<Environment | null>(() => {
    const project = this.project();
    return project.environments.find((e) => e.id === project.activeEnvironmentId) ?? null;
  });
  protected readonly marker = computed(() => {
    const env = this.environment();
    return env ? environmentMarker(env.name) : null;
  });
  protected readonly ariaLabel = computed(() => {
    const env = this.environment();
    if (!env) {
      return 'Environment: No environment';
    }
    return this.marker()?.kind === 'production'
      ? `Environment: ${env.name}, production`
      : `Environment: ${env.name}`;
  });

  protected markerOf(name: string): EnvironmentMarker {
    return environmentMarker(name);
  }

  protected isActive(env: Environment | null): boolean {
    return (env?.id ?? null) === this.project().activeEnvironmentId;
  }

  protected async choose(env: Environment | null): Promise<void> {
    this.open.set(false);
    const project = this.project();
    const environmentId = env?.id ?? null;
    if (environmentId === project.activeEnvironmentId) {
      return;
    }
    try {
      await this.config.setActiveEnvironment(project.id, environmentId);
    } catch (err) {
      notifyError(this.alerts, err, 'Environment not changed');
    }
  }

  protected manage(): void {
    this.open.set(false);
    void this.router.navigate(['/projects', this.project().id, 'variables']);
  }
}
