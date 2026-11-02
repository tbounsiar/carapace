import { computed, inject, Service, signal } from '@angular/core';
import { ConfigService } from '../core/ipc/config';
import type { Environment, Project } from '../core/ipc/config.models';

/** The project the header environment selector acts on: the last one the user opened. */
@Service()
export class CurrentProject {
  private readonly config = inject(ConfigService);
  private readonly selectedId = signal<string | null>(null);

  readonly project = computed<Project | null>(() => {
    const projects = this.config.projects();
    return projects.find((p) => p.id === this.selectedId()) ?? projects[0] ?? null;
  });

  readonly environment = computed<Environment | null>(() => {
    const project = this.project();
    return project?.environments.find((e) => e.id === project.activeEnvironmentId) ?? null;
  });

  select(projectId: string): void {
    this.selectedId.set(projectId);
  }
}
