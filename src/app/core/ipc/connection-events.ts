import { inject, Service } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { invokeCommand } from './ipc-error';
import { SshService } from './ssh';
import type { EndReason } from './ssh.models';

export interface ConnectionEnded {
  readonly kind: 'connectionEnded';
  readonly connectionId: string;
  readonly reason: EndReason;
}

export type ConnectionEvent = ConnectionEnded;

/** Last end reason of each connection not reconnected since, returned by the subscription. */
export interface EndedConnection {
  readonly connectionId: string;
  readonly reason: EndReason;
}

/**
 * The backend's connection lifecycle stream. The only place that knows its wire shape, so a
 * change of the event contract stays in this file.
 */
@Service()
export class ConnectionEvents {
  private readonly ssh = inject(SshService);
  private started: Promise<boolean> | null = null;

  /** Resolves false when the backend has no stream; states then only follow connect/disconnect. */
  start(): Promise<boolean> {
    this.started ??= this.subscribe();
    return this.started;
  }

  private async subscribe(): Promise<boolean> {
    const onEvent = new Channel<ConnectionEvent>();
    onEvent.onmessage = (event) => {
      if (event.kind === 'connectionEnded') {
        this.ssh.ended(event.connectionId, event.reason === 'user' ? 'user' : 'lost');
      }
    };
    try {
      const ended = await invokeCommand<EndedConnection[]>('subscribe_connections', { onEvent });
      for (const { connectionId, reason } of ended ?? []) {
        if (this.ssh.stateOf(connectionId) !== 'connected') {
          this.ssh.ended(connectionId, reason === 'user' ? 'user' : 'lost');
        }
      }
      return true;
    } catch {
      this.started = null;
      return false;
    }
  }
}
