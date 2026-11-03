export interface HostKeyPrompt {
  kind: 'hostKeyPrompt';
  requestId: string;
  status: 'unknown';
  hostname: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export interface HostKeyChanged {
  kind: 'hostKeyChanged';
  hostname: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  knownFingerprints: string[];
}

export interface StatusEvent {
  kind: 'status';
  state: 'connecting' | 'authenticating' | 'connected';
}

export type ConnectEvent = HostKeyPrompt | HostKeyChanged | StatusEvent;

/** Why a connection closed: the user disconnected it, or it dropped. */
export type EndReason = 'user' | 'lost';

export interface ConnectionInfo {
  connectionId: string;
  hostId: string;
  state: 'connected';
}

export type ConnectionState =
  'idle' | 'connecting' | 'authenticating' | 'awaitingHostKey' | 'connected' | 'error';

/** Sent with `connect_host` only; never stored, never returned by the backend. */
export interface Credential {
  secret: string;
  remember: boolean;
}
