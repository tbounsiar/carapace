import type { ConfigNode, Project, VariableView } from '../../core/ipc/config.models';
import { undefinedReferences } from '../../shared/template';
import { uiText } from '../../shared/ui-text';
import {
  byName,
  canMoveInto,
  containerPath,
  hostsOf,
  sameContainer,
  scopeLabel,
  scopeName,
  scopeTree,
  type Container,
  type TreeItem,
} from './node-tree';

export interface MoveTarget {
  readonly container: Container;
  /** Scope name first: `['Payments', 'Backend']`; Home is `Home` whatever the language. */
  readonly path: readonly string[];
  /** As shown: "Payments / Backend", "Accueil (racine)". */
  readonly text: string;
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
    const label = scopeLabel(projects, projectId);
    const targets: MoveTarget[] = [];
    const add = (parentId: string | null, path: readonly string[]): void => {
      const container = { projectId, parentId };
      if (canMoveInto(nodes, node, container) && parentId !== node.id) {
        const text =
          path.length === 1
            ? uiText('projectTree.topLevel', { scope: label })
            : [label, ...path.slice(1)].join(' / ');
        targets.push({ container, path, text, current: sameContainer(container, node) });
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
    return { label, targets };
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
  const project = target.projectId ? projects.find((p) => p.id === target.projectId) : null;
  const key = `${node.kind === 'host' ? 'host' : 'collection'}To${project ? 'Project' : 'Home'}`;
  const body = uiText(`projectTree.move.warning.${key}`, {
    name: node.name,
    project: project?.name,
    count: hosts.length,
  });
  const undefinedNames = undefinedReferences(hosts, globals, project ?? null);
  const missing = undefinedNames.length
    ? uiText('projectTree.move.warning.missing', {
        scope: project?.name ?? uiText('common.home'),
        names: undefinedNames.join(', '),
      })
    : '';
  const direction = !project ? 'out' : node.projectId ? 'other' : 'into';
  return {
    title: uiText(`projectTree.move.warning.title.${direction}`),
    question: uiText(`projectTree.move.warning.question.${direction}`),
    body,
    missing,
  };
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
    return uiText('projectTree.topLevel', { scope });
  }
  return (crossScope ? [scope, ...below] : below).join(' / ');
}
