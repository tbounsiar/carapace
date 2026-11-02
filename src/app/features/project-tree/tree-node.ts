import type { Host, Project } from '../../core/ipc/config.models';

export type TreeNode =
  | {
      readonly kind: 'project';
      readonly id: string;
      readonly project: Project;
      readonly children: readonly TreeNode[];
    }
  | {
      readonly kind: 'host';
      readonly id: string;
      readonly project: Project;
      readonly host: Host;
      readonly children: readonly TreeNode[];
    };

export function toNodes(projects: readonly Project[]): TreeNode[] {
  return projects.map((project) => ({
    kind: 'project',
    id: project.id,
    project,
    children: project.hosts.map((host) => ({
      kind: 'host',
      id: host.id,
      project,
      host,
      children: [],
    })),
  }));
}

export function nodeLabel(node: TreeNode): string {
  return node.kind === 'project' ? node.project.name : node.host.name;
}
