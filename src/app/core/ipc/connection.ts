/** A connection is a host in one environment of its project, or in none (always none at Home). */
export interface ConnectionTarget {
  readonly projectId: string | null;
  readonly hostId: string;
  readonly environmentId: string | null;
  readonly connectionId: string;
}

export function connectionId(hostId: string, environmentId: string | null): string {
  return `${hostId}@${environmentId ?? 'none'}`;
}

export function connectionTarget(
  projectId: string | null,
  hostId: string,
  environmentId: string | null,
): ConnectionTarget {
  return { projectId, hostId, environmentId, connectionId: connectionId(hostId, environmentId) };
}

/** The target of a host in the active environment of its project. */
export function hostTarget(
  host: { readonly id: string; readonly projectId: string | null },
  project: { readonly activeEnvironmentId: string | null } | null,
): ConnectionTarget {
  return connectionTarget(host.projectId, host.id, project?.activeEnvironmentId ?? null);
}
