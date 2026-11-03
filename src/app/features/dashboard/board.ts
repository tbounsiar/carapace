import type { Host, Project, VariableView } from '../../core/ipc/config.models';
import type { ConnectionState } from '../../core/ipc/ssh.models';
import { previewHost, variableLayers } from '../../shared/template';
import { plural, type TreeItem } from '../project-tree/node-tree';

/** Hosts held directly by one container (the scope root or a collection), in sidebar order. */
export interface HostGroup {
  readonly id: string;
  /** Collection names below the scope; empty for the scope root. */
  readonly path: readonly string[];
  readonly label: string;
  readonly testId: string;
  readonly hosts: readonly Host[];
}

export const ROOT_GROUP = 'root';

/** One group per container holding hosts directly: the root first, then collections depth-first. */
export function hostGroups(items: readonly TreeItem[], scopeName: string): HostGroup[] {
  const groups: HostGroup[] = [];
  const walk = (list: readonly TreeItem[], id: string, path: readonly string[]): void => {
    const hosts = list.flatMap((i) => (i.kind === 'host' ? [i.host] : []));
    if (hosts.length) {
      groups.push({
        id,
        path,
        label: path.length ? path.join(' / ') : `${scopeName} (top level)`,
        testId: `host-group-${[scopeName, ...path].join('/')}`,
        hosts,
      });
    }
    for (const item of list) {
      if (item.kind === 'collection') {
        walk(item.children, item.id, [...path, item.collection.name]);
      }
    }
  };
  walk(items, ROOT_GROUP, []);
  return groups;
}

export interface BoardFilter {
  readonly query: string;
  readonly connectedOnly: boolean;
}

export interface BoardLookups {
  readonly address: (host: Host) => string;
  readonly connected: (host: Host) => boolean;
}

/**
 * Hosts whose name, resolved address or a collection above them contains the query
 * (case-insensitive), and connected ones only when asked; empty groups are dropped.
 */
export function filterGroups(
  groups: readonly HostGroup[],
  filter: BoardFilter,
  lookups: BoardLookups,
): HostGroup[] {
  const q = filter.query.trim().toLowerCase();
  const result: HostGroup[] = [];
  for (const group of groups) {
    const inPath = !!q && group.path.some((name) => name.toLowerCase().includes(q));
    const hosts = group.hosts.filter(
      (host) =>
        (!filter.connectedOnly || lookups.connected(host)) &&
        (!q ||
          inPath ||
          host.name.toLowerCase().includes(q) ||
          lookups.address(host).toLowerCase().includes(q)),
    );
    if (hosts.length) {
      result.push({ ...group, hosts });
    }
  }
  return result;
}

/** Addresses as the cards show them (UI-side preview) and connection states, for searching. */
export function boardLookups(
  variables: readonly VariableView[],
  projects: readonly Project[],
  states: Readonly<Record<string, ConnectionState>>,
): BoardLookups {
  return {
    address: (host) =>
      previewHost(
        host,
        variableLayers(variables, projects.find((p) => p.id === host.projectId) ?? null),
      ).address,
    connected: (host) => states[host.id] === 'connected',
  };
}

export function countHosts(groups: readonly HostGroup[]): number {
  return groups.reduce((sum, g) => sum + g.hosts.length, 0);
}

export function isFiltering(filter: BoardFilter): boolean {
  return !!filter.query.trim() || filter.connectedOnly;
}

export function projectMatches(project: Project, filter: BoardFilter, connected: number): boolean {
  const q = filter.query.trim().toLowerCase();
  return (!filter.connectedOnly || connected > 0) && project.name.toLowerCase().includes(q);
}

export interface Stats {
  readonly hosts: number;
  readonly collections: number;
  readonly connected: number;
  readonly projects?: number;
}

/** "12 hosts · 3 collections · 2 connected"; zero collections, connections or projects are left out. */
export function statsText(stats: Stats): string {
  const parts = [
    stats.hosts ? plural(stats.hosts, 'host') : 'No hosts yet',
    stats.collections ? plural(stats.collections, 'collection') : '',
    stats.connected ? `${stats.connected} connected` : '',
    stats.projects ? plural(stats.projects, 'project') : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** "5 of 12 hosts". */
export function countText(visible: number, total: number): string {
  return `${visible} of ${plural(total, 'host')}`;
}

/** "20 hosts · 2 connected" for a project card. */
export function projectSummary(hosts: number, connected: number): string {
  return [plural(hosts, 'host'), connected ? `${connected} connected` : '']
    .filter(Boolean)
    .join(' · ');
}
