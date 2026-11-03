import type { ConnectionState } from '../core/ipc/ssh.models';

export interface ConnectionStatus {
  readonly label: string;
  readonly color: string;
  readonly busy: boolean;
  readonly loading: boolean;
}

const STATUSES: Record<ConnectionState, ConnectionStatus> = {
  idle: { label: 'Not connected', color: 'var(--tui-status-neutral)', busy: false, loading: false },
  connecting: { label: 'Connecting', color: 'var(--tui-status-info)', busy: true, loading: true },
  authenticating: {
    label: 'Authenticating',
    color: 'var(--tui-status-info)',
    busy: true,
    loading: true,
  },
  awaitingHostKey: {
    label: 'Verify host key',
    color: 'var(--tui-status-warning)',
    busy: true,
    loading: false,
  },
  connected: {
    label: 'Connected',
    color: 'var(--tui-status-positive)',
    busy: false,
    loading: false,
  },
  error: {
    label: 'Connection failed',
    color: 'var(--tui-status-negative)',
    busy: false,
    loading: false,
  },
};

export function connectionStatus(state: ConnectionState): ConnectionStatus {
  return STATUSES[state];
}

/** Connected connections per project id (`null` for Home), any environment. */
export function connectedCounts(
  hosts: readonly { readonly id: string; readonly projectId: string | null }[],
  states: Readonly<Record<string, ConnectionState>>,
): Map<string | null, number> {
  const scopeOf = new Map(hosts.map((h) => [h.id, h.projectId]));
  const counts = new Map<string | null, number>();
  for (const [connectionId, state] of Object.entries(states)) {
    const hostId = connectionId.slice(0, connectionId.lastIndexOf('@'));
    if (state === 'connected' && scopeOf.has(hostId)) {
      const scope = scopeOf.get(hostId) ?? null;
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
  }
  return counts;
}
