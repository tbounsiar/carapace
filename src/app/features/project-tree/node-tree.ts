import type { Collection, ConfigNode, Host, Project } from '../../core/ipc/config.models';

export const HOME = 'Home';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return collator.compare(a.name, b.name);
}

/** Where a node lives: a scope (`projectId`, null for Home) and a collection in it, or its root. */
export interface Container {
  readonly projectId: string | null;
  readonly parentId: string | null;
}

export interface TreeCollection {
  readonly kind: 'collection';
  readonly id: string;
  readonly collection: Collection;
  readonly children: readonly TreeItem[];
}

export interface TreeHost {
  readonly kind: 'host';
  readonly id: string;
  readonly host: Host;
}

export type TreeItem = TreeCollection | TreeHost;

/** Collections first, then hosts, each sorted by name. */
export function scopeTree(nodes: readonly ConfigNode[], projectId: string | null): TreeItem[] {
  const children = new Map<string | null, ConfigNode[]>();
  for (const node of nodes) {
    if (node.projectId === projectId) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
  }
  const build = (parentId: string | null, seen: ReadonlySet<string>): TreeItem[] => {
    const list = [...(children.get(parentId) ?? [])].sort(byName);
    const collections = list
      .filter((n): n is Collection => n.kind === 'collection' && !seen.has(n.id))
      .map<TreeItem>((collection) => ({
        kind: 'collection',
        id: collection.id,
        collection,
        children: build(collection.id, new Set([...seen, collection.id])),
      }));
    const hosts = list
      .filter((n): n is Host => n.kind === 'host')
      .map<TreeItem>((host) => ({ kind: 'host', id: host.id, host }));
    return [...collections, ...hosts];
  };
  return build(null, new Set());
}

/** The collections above a node, outermost first. */
export function ancestors(nodes: readonly ConfigNode[], nodeId: string): Collection[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: Collection[] = [];
  let parentId = byId.get(nodeId)?.parentId ?? null;
  while (parentId) {
    const parent = byId.get(parentId);
    if (parent?.kind !== 'collection' || path.includes(parent)) {
      break;
    }
    path.unshift(parent);
    parentId = parent.parentId;
  }
  return path;
}

/** Every node below a collection, at any depth (the collection itself excluded). */
export function descendants(nodes: readonly ConfigNode[], collectionId: string): ConfigNode[] {
  const found: ConfigNode[] = [];
  const queue = [collectionId];
  const seen = new Set(queue);
  while (queue.length) {
    const parentId = queue.shift();
    for (const node of nodes) {
      if (node.parentId === parentId && !seen.has(node.id)) {
        seen.add(node.id);
        found.push(node);
        if (node.kind === 'collection') {
          queue.push(node.id);
        }
      }
    }
  }
  return found;
}

/** The host itself, or every host inside the collection. */
export function hostsOf(nodes: readonly ConfigNode[], node: ConfigNode): Host[] {
  if (node.kind === 'host') {
    return [node];
  }
  return descendants(nodes, node.id).filter((n): n is Host => n.kind === 'host');
}

export interface Counts {
  readonly collections: number;
  readonly hosts: number;
}

export function countNodes(list: readonly ConfigNode[]): Counts {
  const hosts = list.filter((n) => n.kind === 'host').length;
  return { collections: list.length - hosts, hosts };
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "2 collections and 12 hosts"; a part with 0 is left out; extra parts come last. */
export function countText(counts: Counts): string {
  const parts = [
    counts.collections ? plural(counts.collections, 'collection') : '',
    counts.hosts ? plural(counts.hosts, 'host') : '',
  ].filter(Boolean);
  return parts.join(' and ');
}

export function scopeName(projects: readonly Project[], projectId: string | null): string {
  return projectId ? (projects.find((p) => p.id === projectId)?.name ?? '') : HOME;
}

/** Scope name then collection names: `['Payments', 'Backend']`, `['Home']`. */
export function containerPath(
  nodes: readonly ConfigNode[],
  projects: readonly Project[],
  container: Container,
): string[] {
  const names = [scopeName(projects, container.projectId)];
  if (container.parentId) {
    names.push(...ancestors(nodes, container.parentId).map((c) => c.name));
    const parent = nodes.find((n) => n.id === container.parentId);
    if (parent) {
      names.push(parent.name);
    }
  }
  return names;
}

export function sameContainer(a: Container, b: Container): boolean {
  return a.projectId === b.projectId && a.parentId === b.parentId;
}

/** Whether `node` may go into `target`: never into itself or one of its descendants. */
export function canMoveInto(
  nodes: readonly ConfigNode[],
  node: ConfigNode,
  target: Container,
): boolean {
  if (node.kind === 'host' || !target.parentId) {
    return true;
  }
  if (target.parentId === node.id) {
    return false;
  }
  return !descendants(nodes, node.id).some((n) => n.id === target.parentId);
}
