import type { Environment, Host, Project } from '../../core/ipc/config.models';

export type TreeNode =
  | {
      readonly kind: 'project';
      readonly id: string;
      readonly project: Project;
      readonly children: readonly TreeNode[];
    }
  | {
      readonly kind: 'environment';
      readonly id: string;
      readonly project: Project;
      readonly environment: Environment;
      readonly children: readonly TreeNode[];
    }
  | {
      readonly kind: 'host';
      readonly id: string;
      readonly project: Project;
      readonly environment: Environment;
      readonly host: Host;
      readonly children: readonly TreeNode[];
    };

export function toNodes(projects: readonly Project[]): TreeNode[] {
  return projects.map((project) => ({
    kind: 'project',
    id: project.id,
    project,
    children: project.environments.map((environment) => ({
      kind: 'environment',
      id: environment.id,
      project,
      environment,
      children: environment.hosts.map((host) => ({
        kind: 'host',
        id: host.id,
        project,
        environment,
        host,
        children: [],
      })),
    })),
  }));
}

export function nodeLabel(node: TreeNode): string {
  switch (node.kind) {
    case 'project':
      return node.project.name;
    case 'environment':
      return node.environment.name;
    case 'host':
      return node.host.name;
  }
}
