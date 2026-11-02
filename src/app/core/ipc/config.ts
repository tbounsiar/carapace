import { Service, signal } from '@angular/core';
import type { Environment, Host, HostInput, Project } from './config.models';
import { invokeCommand } from './ipc-error';

@Service()
export class ConfigService {
  private readonly _projects = signal<Project[]>([]);
  private readonly _loading = signal(false);

  readonly projects = this._projects.asReadonly();
  readonly loading = this._loading.asReadonly();

  async load(): Promise<void> {
    this._loading.set(true);
    try {
      this._projects.set(await invokeCommand<Project[]>('list_projects'));
    } finally {
      this._loading.set(false);
    }
  }

  async createProject(name: string): Promise<Project> {
    const project = await invokeCommand<Project>('create_project', { name });
    this._projects.update((list) => [...list, project]);
    return project;
  }

  async renameProject(projectId: string, name: string): Promise<Project> {
    const project = await invokeCommand<Project>('rename_project', { projectId, name });
    this.patchProject(projectId, () => project);
    return project;
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

  async renameEnvironment(
    projectId: string,
    environmentId: string,
    name: string,
  ): Promise<Environment> {
    const env = await invokeCommand<Environment>('rename_environment', {
      projectId,
      environmentId,
      name,
    });
    this.patchEnvironment(projectId, environmentId, () => env);
    return env;
  }

  async deleteEnvironment(projectId: string, environmentId: string): Promise<void> {
    await invokeCommand<null>('delete_environment', { projectId, environmentId });
    this.patchProject(projectId, (p) => ({
      ...p,
      environments: p.environments.filter((e) => e.id !== environmentId),
    }));
  }

  async createHost(projectId: string, environmentId: string, host: HostInput): Promise<Host> {
    const created = await invokeCommand<Host>('create_host', { projectId, environmentId, host });
    this.patchEnvironment(projectId, environmentId, (e) => ({
      ...e,
      hosts: [...e.hosts, created],
    }));
    return created;
  }

  async updateHost(
    projectId: string,
    environmentId: string,
    hostId: string,
    host: HostInput,
  ): Promise<Host> {
    const updated = await invokeCommand<Host>('update_host', {
      projectId,
      environmentId,
      hostId,
      host,
    });
    this.patchEnvironment(projectId, environmentId, (e) => ({
      ...e,
      hosts: e.hosts.map((h) => (h.id === hostId ? updated : h)),
    }));
    return updated;
  }

  async deleteHost(projectId: string, environmentId: string, hostId: string): Promise<void> {
    await invokeCommand<null>('delete_host', { projectId, environmentId, hostId });
    this.patchEnvironment(projectId, environmentId, (e) => ({
      ...e,
      hosts: e.hosts.filter((h) => h.id !== hostId),
    }));
  }

  private patchProject(projectId: string, fn: (p: Project) => Project): void {
    this._projects.update((list) => list.map((p) => (p.id === projectId ? fn(p) : p)));
  }

  private patchEnvironment(
    projectId: string,
    environmentId: string,
    fn: (e: Environment) => Environment,
  ): void {
    this.patchProject(projectId, (p) => ({
      ...p,
      environments: p.environments.map((e) => (e.id === environmentId ? fn(e) : e)),
    }));
  }
}
