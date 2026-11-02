import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  TuiButton,
  TuiDataList,
  TuiDialogService,
  TuiDropdown,
  TuiHint,
  TuiTitle,
} from '@taiga-ui/core';
import { TUI_CONFIRM, TuiBadge } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { Environment, VariableScope } from '../../../core/ipc/config.models';
import { CurrentProject } from '../../../shared/current-project';
import { environmentMarker, type EnvironmentMarker } from '../../../shared/environment-kind';
import { ProjectActions } from '../../project-tree/project-actions';
import type { LeaveGuarded } from '../unsaved-changes-guard';
import { VariablesEditor } from '../variables-editor/variables-editor';

const PROJECT = 'project';

@Component({
  imports: [
    RouterLink,
    TuiBadge,
    TuiBlockStatus,
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiHeader,
    TuiHint,
    TuiTitle,
    VariablesEditor,
  ],
  selector: 'app-variables-page',
  styleUrl: './variables-page.scss',
  templateUrl: './variables-page.html',
})
export class VariablesPage implements LeaveGuarded {
  private readonly config = inject(ConfigService);
  private readonly actions = inject(ProjectActions);
  private readonly dialogs = inject(TuiDialogService);
  private readonly current = inject(CurrentProject);

  /** Absent on the global variables route. */
  readonly projectId = input<string>();

  private readonly editor = viewChild(VariablesEditor);
  protected readonly example = '${name}';
  protected readonly openMenu = signal<string | null>(null);
  /** `project` or an environment id. */
  protected readonly selected = linkedSignal(() => {
    this.projectId();
    return PROJECT;
  });

  protected readonly project = computed(() => {
    const id = this.projectId();
    return id ? (this.config.projects().find((p) => p.id === id) ?? null) : null;
  });
  protected readonly notFound = computed(
    () => !!this.projectId() && !this.project() && !this.config.loading(),
  );
  protected readonly environment = computed<Environment | null>(
    () => this.project()?.environments.find((e) => e.id === this.selected()) ?? null,
  );

  protected readonly scope = computed<VariableScope | null>(() => {
    const project = this.project();
    if (!this.projectId()) {
      return { kind: 'global' };
    }
    if (!project) {
      return null;
    }
    const env = this.environment();
    return env
      ? { kind: 'environment', projectId: project.id, environmentId: env.id }
      : { kind: 'project', projectId: project.id };
  });

  protected readonly variables = computed(() => {
    if (!this.projectId()) {
      return this.config.variables();
    }
    return this.environment()?.variables ?? this.project()?.variables ?? [];
  });

  protected readonly scopeLabel = computed(() => {
    if (!this.projectId()) {
      return 'Global variables';
    }
    const env = this.environment();
    return env ? `Environment ${env.name}` : 'Project variables';
  });

  constructor() {
    effect(() => {
      const id = this.projectId();
      if (id && this.project()) {
        this.current.select(id);
      }
    });
  }

  async canLeave(): Promise<boolean> {
    if (!this.editor()?.dirty()) {
      return true;
    }
    return firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, {
        label: 'Discard unsaved changes?',
        size: 's',
        data: {
          content: 'Your changes to these variables are not saved.',
          yes: 'Discard',
          no: 'Keep editing',
          appearance: ['primary-destructive', 'secondary'],
        },
      }),
      { defaultValue: false },
    );
  }

  protected marker(env: Environment): EnvironmentMarker {
    return environmentMarker(env.name);
  }

  protected isActive(env: Environment): boolean {
    return this.project()?.activeEnvironmentId === env.id;
  }

  protected async select(key: string): Promise<void> {
    if (key !== this.selected() && (await this.canLeave())) {
      this.selected.set(key);
    }
  }

  protected setMenu(env: Environment, open: boolean): void {
    this.openMenu.update((current) => (open ? env.id : current === env.id ? null : current));
  }

  protected addEnvironment(): void {
    const project = this.project();
    if (project) {
      this.actions.addEnvironment(project);
    }
  }

  protected renameEnvironment(env: Environment): void {
    const project = this.project();
    if (project) {
      this.actions.renameEnvironment(project, env);
    }
  }

  protected async removeEnvironment(env: Environment): Promise<void> {
    const project = this.project();
    if (
      project &&
      (await this.actions.removeEnvironment(project, env)) &&
      this.selected() === env.id
    ) {
      this.selected.set(PROJECT);
    }
  }
}
