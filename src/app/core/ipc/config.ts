import { computed, Service, signal } from '@angular/core';
import type {
  Collection,
  ConfigNode,
  ConfigView,
  DeletedNodes,
  Host,
  HostInput,
  MoveResult,
  Project,
  ResolvedHost,
  VariableInput,
  VariableScope,
  VariableView,
} from './config.models';
import { invokeCommand } from './ipc-error';

/** `project` is null for a Home host. */
export interface HostLocation {
  readonly project: Project | null;
  readonly host: Host;
}

@Service()
export class ConfigService {
  private readonly _variables = signal<VariableView[]>([]);
  private readonly _projects = signal<Project[]>([]);
  private readonly _nodes = signal<ConfigNode[]>([]);
  private readonly _loading = signal(false);
  private readonly _loaded = signal(false);
  private readonly _loadError = signal<unknown>(null);

  /** Global variables. */
  readonly variables = this._variables.asReadonly();
  readonly projects = this._projects.asReadonly();
  /** Collections and hosts of every scope, flat; the tree is given by `parentId`. */
  readonly nodes = this._nodes.asReadonly();
  readonly loading = this._loading.asReadonly();
  /** True once a load succeeded; before that an unknown id may just not be loaded yet. */
  readonly loaded = this._loaded.asReadonly();
  /** The error of the last failed load, null once a load starts again. */
  readonly loadError = this._loadError.asReadonly();
  readonly hosts = computed(() => this._nodes().filter((n): n is Host => n.kind === 'host'));

  async load(): Promise<void> {
    this._loading.set(true);
    this._loadError.set(null);
    try {
      const config = await invokeCommand<ConfigView>('get_config');
      this._variables.set(config.variables);
      this._projects.set(config.projects);
      this._nodes.set(config.nodes);
      this._loaded.set(true);
    } catch (err) {
      this._loadError.set(err);
      throw err;
    } finally {
      this._loading.set(false);
    }
  }

  findNode(nodeId: string): ConfigNode | null {
    return this._nodes().find((n) => n.id === nodeId) ?? null;
  }

  findHost(hostId: string): HostLocation | null {
    const host = this.findNode(hostId);
    if (host?.kind !== 'host') {
      return null;
    }
    const project = host.projectId ? this.findProject(host.projectId) : null;
    return host.projectId && !project ? null : { project, host };
  }

  findProject(projectId: string): Project | null {
    return this._projects().find((p) => p.id === projectId) ?? null;
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
    this._nodes.update((list) => list.filter((n) => n.projectId !== projectId));
  }

  /** Replaces the whole list of the scope. */
  async setVariables(scope: VariableScope, variables: VariableInput[]): Promise<VariableView[]> {
    const saved = await invokeCommand<VariableView[]>('set_variables', { scope, variables });
    if (scope.kind === 'global') {
      this._variables.set(saved);
    } else {
      this.patchProject(scope.projectId, (p) => ({ ...p, variables: saved }));
    }
    return saved;
  }

  async createCollection(
    projectId: string | null,
    parentId: string | null,
    name: string,
  ): Promise<Collection> {
    const created = await invokeCommand<Collection>('create_collection', {
      projectId,
      parentId,
      name,
    });
    this._nodes.update((list) => [...list, created]);
    return created;
  }

  async renameCollection(collectionId: string, name: string): Promise<Collection> {
    const renamed = await invokeCommand<Collection>('rename_collection', { collectionId, name });
    this.replaceNodes([renamed]);
    return renamed;
  }

  /** Recursive: the collection, its sub-collections and their hosts. */
  async deleteCollection(collectionId: string): Promise<DeletedNodes> {
    const deleted = await invokeCommand<DeletedNodes>('delete_collection', { collectionId });
    const gone = new Set([collectionId, ...deleted.collectionIds, ...deleted.hostIds]);
    this._nodes.update((list) => list.filter((n) => !gone.has(n.id)));
    return deleted;
  }

  async createHost(
    projectId: string | null,
    parentId: string | null,
    host: HostInput,
  ): Promise<Host> {
    const created = await invokeCommand<Host>('create_host', { projectId, parentId, host });
    this._nodes.update((list) => [...list, created]);
    return created;
  }

  async updateHost(hostId: string, host: HostInput): Promise<Host> {
    const updated = await invokeCommand<Host>('update_host', { hostId, host });
    this.replaceNodes([updated]);
    return updated;
  }

  async deleteHost(hostId: string): Promise<void> {
    await invokeCommand<null>('delete_host', { hostId });
    this._nodes.update((list) => list.filter((n) => n.id !== hostId));
  }

  /** A move to another scope also closes the moved hosts' connections and forgets their saved secrets. */
  async moveNode(
    nodeId: string,
    projectId: string | null,
    parentId: string | null,
  ): Promise<MoveResult> {
    const result = await invokeCommand<MoveResult>('move_node', { nodeId, projectId, parentId });
    this.replaceNodes(result.nodes);
    return result;
  }

  resolveHost(hostId: string): Promise<ResolvedHost> {
    return invokeCommand<ResolvedHost>('resolve_host', { hostId });
  }

  private replaceNodes(nodes: readonly ConfigNode[]): void {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    this._nodes.update((list) => list.map((n) => byId.get(n.id) ?? n));
  }

  private patchProject(projectId: string, fn: (p: Project) => Project): void {
    this._projects.update((list) => list.map((p) => (p.id === projectId ? fn(p) : p)));
  }
}
