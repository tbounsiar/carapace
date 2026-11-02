/** A connection is a host in one environment of its project (or in none). */
export interface ConnectionTarget {
  readonly projectId: string;
  readonly hostId: string;
  readonly environmentId: string | null;
  readonly connectionId: string;
}

export function connectionId(hostId: string, environmentId: string | null): string {
  return `${hostId}@${environmentId ?? 'none'}`;
}

export function connectionTarget(
  projectId: string,
  hostId: string,
  environmentId: string | null,
): ConnectionTarget {
  return { projectId, hostId, environmentId, connectionId: connectionId(hostId, environmentId) };
}
