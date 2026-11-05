import type { ConnectionState } from '../core/ipc/ssh.models';
import { uiText } from './ui-text';

export interface ConnectionStatus {
  readonly label: string;
  readonly color: string;
  readonly busy: boolean;
  readonly loading: boolean;
}

const STATUSES: Record<ConnectionState, Omit<ConnectionStatus, 'label'>> = {
  idle: { color: 'var(--tui-status-neutral)', busy: false, loading: false },
  connecting: { color: 'var(--tui-status-info)', busy: true, loading: true },
  authenticating: {
    color: 'var(--tui-status-info)',
    busy: true,
    loading: true,
  },
  awaitingHostKey: {
    color: 'var(--tui-status-warning)',
    busy: true,
    loading: false,
  },
  connected: {
    color: 'var(--tui-status-positive)',
    busy: false,
    loading: false,
  },
  error: {
    color: 'var(--tui-status-negative)',
    busy: false,
    loading: false,
  },
};

export function connectionStatus(state: ConnectionState): ConnectionStatus {
  return { label: uiText(`common.connection.${state}`), ...STATUSES[state] };
}

/** Connected hosts per project id (`null` for Home). */
export function connectedCounts(
  hosts: readonly { readonly id: string; readonly projectId: string | null }[],
  states: Readonly<Record<string, ConnectionState>>,
): Map<string | null, number> {
  const scopeOf = new Map(hosts.map((h) => [h.id, h.projectId]));
  const counts = new Map<string | null, number>();
  for (const [hostId, state] of Object.entries(states)) {
    if (state === 'connected' && scopeOf.has(hostId)) {
      const scope = scopeOf.get(hostId) ?? null;
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
  }
  return counts;
}
