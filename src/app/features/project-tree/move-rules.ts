import type { ConfigNode, Project, VariableView } from '../../core/ipc/config.models';
import { undefinedReferences } from '../../shared/template';
import {
  byName,
  canMoveInto,
  containerPath,
  HOME,
  hostsOf,
  plural,
  sameContainer,
  scopeName,
  scopeTree,
  type Container,
  type TreeItem,
} from './node-tree';

export interface MoveTarget {
  readonly container: Container;
  /** Scope name first: `['Payments', 'Backend']`. */
  readonly path: readonly string[];
  readonly current: boolean;
}

export interface MoveTargetGroup {
  readonly label: string;
  readonly targets: readonly MoveTarget[];
}

/** Every container `node` may go to, grouped by scope (Home first), its own subtree left out. */
export function moveTargets(
  nodes: readonly ConfigNode[],
  projects: readonly Project[],
  node: ConfigNode,
): MoveTargetGroup[] {
  const group = (projectId: string | null): MoveTargetGroup => {
    const name = scopeName(projects, projectId);
    const targets: MoveTarget[] = [];
    const add = (parentId: string | null, path: readonly string[]): void => {
      const container = { projectId, parentId };
      if (canMoveInto(nodes, node, container) && parentId !== node.id) {
        targets.push({ container, path, current: sameContainer(container, node) });
      }
    };
    const walk = (items: readonly TreeItem[], path: readonly string[]): void => {
      for (const item of items) {
        if (item.kind === 'collection' && item.id !== node.id) {
          const childPath = [...path, item.collection.name];
          add(item.id, childPath);
          walk(item.children, childPath);
        }
      }
    };
    add(null, [name]);
    walk(scopeTree(nodes, projectId), [name]);
    return { label: name, targets };
  };
  return [null, ...[...projects].sort(byName).map((p) => p.id)].map(group);
}

export interface CrossScopeWarning {
  /** Notification title in the Move dialog. */
  readonly title: string;
  /** Confirm label for a drop. */
  readonly question: string;
  readonly body: string;
  /** "Not defined in Payments: db_host." or empty. */
  readonly missing: string;
}

/** What changes when `node` leaves its scope for `target`'s; null within a scope. */
export function crossScopeWarning(
  nodes: readonly ConfigNode[],
  projects: readonly Project[],
  globals: readonly VariableView[],
  node: ConfigNode,
  target: Container,
): CrossScopeWarning | null {
  if (node.projectId === target.projectId) {
    return null;
  }
  const hosts = hostsOf(nodes, node);
  const subject =
    node.kind === 'host' ? node.name : `The ${plural(hosts.length, 'host')} in ${node.name}`;
  const their = node.kind === 'host' ? 'Its' : 'Their';
  const project = target.projectId ? projects.find((p) => p.id === target.projectId) : null;
  const targetName = project?.name ?? HOME;
  const rest = `${their} open connections are closed and ${their.toLowerCase()} saved passwords are forgotten.`;
  const body = project
    ? `${subject} will use the variables of ${project.name}. ${rest}`
    : `${subject} will use global variables only. ${rest}`;
  const undefinedNames = undefinedReferences(hosts, globals, project ?? null);
  const missing = undefinedNames.length
    ? `Not defined in ${targetName}: ${undefinedNames.join(', ')}.`
    : '';
  if (!project) {
    return {
      title: 'Moving out of the project',
      question: 'Move out of the project?',
      body,
      missing,
    };
  }
  return node.projectId
    ? { title: 'Moving to another project', question: 'Move to another project?', body, missing }
    : { title: 'Moving into a project', question: 'Move into a project?', body, missing };
}

/**
 * Where a moved node went, for the toast: "Payments (top level)" for a scope root, the path below
 * the scope within one ("Backend / Legacy"), the scope first across scopes ("Home / Lab").
 */
export function moveDestination(
  nodes: readonly ConfigNode[],
  projects: readonly Project[],
  target: Container,
  crossScope: boolean,
): string {
  const [scope, ...below] = containerPath(nodes, projects, target);
  if (!below.length) {
    return `${scope} (top level)`;
  }
  return (crossScope ? [scope, ...below] : below).join(' / ');
}
