/** A connection is a host: one connection per host, its id is the host id. */
export interface ConnectionTarget {
  readonly projectId: string | null;
  readonly hostId: string;
  readonly connectionId: string;
}

export function connectionId(hostId: string): string {
  return hostId;
}

export function connectionTarget(projectId: string | null, hostId: string): ConnectionTarget {
  return { projectId, hostId, connectionId: connectionId(hostId) };
}

export function hostTarget(host: {
  readonly id: string;
  readonly projectId: string | null;
}): ConnectionTarget {
  return connectionTarget(host.projectId, host.id);
}
