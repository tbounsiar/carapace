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
