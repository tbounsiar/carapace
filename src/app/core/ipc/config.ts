import { Service, signal } from '@angular/core';
import type {
  ConfigView,
  Environment,
  Host,
  HostInput,
  Project,
  ResolvedHost,
  VariableInput,
  VariableScope,
  VariableView,
} from './config.models';
import { invokeCommand } from './ipc-error';

export interface HostLocation {
  readonly project: Project;
  readonly host: Host;
}

@Service()
export class ConfigService {
  private readonly _variables = signal<VariableView[]>([]);
  private readonly _projects = signal<Project[]>([]);
  private readonly _loading = signal(false);

  /** Global variables. */
  readonly variables = this._variables.asReadonly();
  readonly projects = this._projects.asReadonly();
  readonly loading = this._loading.asReadonly();

  async load(): Promise<void> {
    this._loading.set(true);
    try {
      const config = await invokeCommand<ConfigView>('get_config');
      this._variables.set(config.variables);
      this._projects.set(config.projects);
    } finally {
      this._loading.set(false);
    }
  }

  findHost(hostId: string): HostLocation | null {
    for (const project of this._projects()) {
      const host = project.hosts.find((h) => h.id === hostId);
      if (host) {
        return { project, host };
      }
    }
    return null;
  }

  async createProject(name: string): Promise<Project> {
    const project = await invokeCommand<Project>('create_project', { name });
    this._projects.update((list) => [...list, project]);
    return project;
  }

  async renameProject(projectId: string, name: string): Promise<void> {
    const project = await invokeCommand<Project>('rename_project', { projectId, name });
    this.patchProject(projectId, (p) => ({ ...p, name: project.name }));
  }

  async deleteProject(projectId: string): Promise<void> {
    await invokeCommand<null>('delete_project', { projectId });
    this._projects.update((list) => list.filter((p) => p.id !== projectId));
  }

  async createEnvironment(projectId: string, name: string): Promise<Environment> {
    const env = await invokeCommand<Environment>('create_environment', { projectId, name });
    this.patchProject(projectId, (p) => ({ ...p, environments: [...p.environments, env] }));
    return env;
  }

  async renameEnvironment(projectId: string, environmentId: string, name: string): Promise<void> {
    const env = await invokeCommand<Environment>('rename_environment', {
      projectId,
      environmentId,
      name,
    });
    this.patchProject(projectId, (p) => ({
      ...p,
      environments: p.environments.map((e) =>
        e.id === environmentId ? { ...e, name: env.name } : e,
      ),
    }));
  }

  async deleteEnvironment(projectId: string, environmentId: string): Promise<void> {
    await invokeCommand<null>('delete_environment', { projectId, environmentId });
    this.patchProject(projectId, (p) => ({
      ...p,
      environments: p.environments.filter((e) => e.id !== environmentId),
      activeEnvironmentId: p.activeEnvironmentId === environmentId ? null : p.activeEnvironmentId,
    }));
  }

  async setActiveEnvironment(projectId: string, environmentId: string | null): Promise<void> {
    await invokeCommand<unknown>('set_active_environment', { projectId, environmentId });
    this.patchProject(projectId, (p) => ({ ...p, activeEnvironmentId: environmentId }));
  }

  /** Replaces the whole list of the scope. */
  async setVariables(scope: VariableScope, variables: VariableInput[]): Promise<VariableView[]> {
    const saved = await invokeCommand<VariableView[]>('set_variables', { scope, variables });
    if (scope.kind === 'global') {
      this._variables.set(saved);
    } else if (scope.kind === 'project') {
      this.patchProject(scope.projectId, (p) => ({ ...p, variables: saved }));
    } else {
      this.patchProject(scope.projectId, (p) => ({
        ...p,
        environments: p.environments.map((e) =>
          e.id === scope.environmentId ? { ...e, variables: saved } : e,
        ),
      }));
    }
    return saved;
  }

  async createHost(projectId: string, host: HostInput): Promise<Host> {
    const created = await invokeCommand<Host>('create_host', { projectId, host });
    this.patchProject(projectId, (p) => ({ ...p, hosts: [...p.hosts, created] }));
    return created;
  }

  async updateHost(projectId: string, hostId: string, host: HostInput): Promise<Host> {
    const updated = await invokeCommand<Host>('update_host', { projectId, hostId, host });
    this.patchProject(projectId, (p) => ({
      ...p,
      hosts: p.hosts.map((h) => (h.id === hostId ? updated : h)),
    }));
    return updated;
  }

  async deleteHost(projectId: string, hostId: string): Promise<void> {
    await invokeCommand<null>('delete_host', { projectId, hostId });
    this.patchProject(projectId, (p) => ({ ...p, hosts: p.hosts.filter((h) => h.id !== hostId) }));
  }

  resolveHost(
    projectId: string,
    hostId: string,
    environmentId: string | null,
  ): Promise<ResolvedHost> {
    return invokeCommand<ResolvedHost>('resolve_host', { projectId, hostId, environmentId });
  }

  private patchProject(projectId: string, fn: (p: Project) => Project): void {
    this._projects.update((list) => list.map((p) => (p.id === projectId ? fn(p) : p)));
  }
}
