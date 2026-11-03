import { computed, signal } from '@angular/core';
import type {
  Collection,
  ConfigNode,
  DeletedNodes,
  Host,
  MoveResult,
  Project,
  VariableView,
} from './config.models';

export function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return { id, name, variables: [], environments: [], activeEnvironmentId: null, ...extra };
}

export function collection(
  id: string,
  name: string,
  projectId: string | null = null,
  parentId: string | null = null,
): Collection {
  return { kind: 'collection', id, name, projectId, parentId };
}

export function host(
  id: string,
  name: string,
  projectId: string | null = null,
  parentId: string | null = null,
): Host {
  return {
    kind: 'host',
    id,
    name,
    projectId,
    parentId,
    hostname: `${name}.example.com`,
    port: '22',
    username: 'deploy',
    auth: { kind: 'agent' },
  };
}

/** Spec fixture: a signal-backed stand-in for `ConfigService`; specs spy on the mutations. */
export function fakeConfig() {
  const projects = signal<Project[]>([]);
  const nodes = signal<ConfigNode[]>([]);
  const variables = signal<VariableView[]>([]);
  const loading = signal(false);
  const loaded = signal(true);
  const findNode = (id: string): ConfigNode | null => nodes().find((n) => n.id === id) ?? null;
  const findProject = (id: string): Project | null => projects().find((p) => p.id === id) ?? null;
  return {
    projects,
    nodes,
    variables,
    loading,
    loaded,
    hosts: computed(() => nodes().filter((n): n is Host => n.kind === 'host')),
    findNode,
    findProject,
    findHost: (id: string) => {
      const node = findNode(id);
      if (node?.kind !== 'host') {
        return null;
      }
      return { project: node.projectId ? findProject(node.projectId) : null, host: node };
    },
    load: (): Promise<void> => Promise.resolve(),
    createProject: (name: string): Promise<Project> => Promise.resolve(project('new', name)),
    renameProject: (): Promise<void> => Promise.resolve(),
    deleteProject: (): Promise<void> => Promise.resolve(),
    setActiveEnvironment: (): Promise<void> => Promise.resolve(),
    createCollection: (
      projectId: string | null,
      parentId: string | null,
      name: string,
    ): Promise<Collection> => Promise.resolve(collection('new', name, projectId, parentId)),
    renameCollection: (id: string, name: string): Promise<Collection> =>
      Promise.resolve({ ...(findNode(id) as Collection), name }),
    deleteCollection: (): Promise<DeletedNodes> =>
      Promise.resolve({ collectionIds: [], hostIds: [] }),
    deleteHost: (): Promise<void> => Promise.resolve(),
    moveNode: (): Promise<MoveResult> => Promise.resolve({ nodes: [], scopeChanged: false }),
  };
}

export type FakeConfig = ReturnType<typeof fakeConfig>;
