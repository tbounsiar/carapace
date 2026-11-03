import { Service, signal } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import type { ConnectionTarget } from './connection';
import { invokeCommand } from './ipc-error';
import type {
  ConnectEvent,
  ConnectionInfo,
  ConnectionState,
  Credential,
  EndReason,
  HostKeyChanged,
  HostKeyPrompt,
} from './ssh.models';

export interface ConnectHandlers {
  decide: (prompt: HostKeyPrompt) => Promise<boolean>;
  changed: (event: HostKeyChanged) => void;
}

/** Connection states keyed by connection id (the host id). */
@Service()
export class SshService {
  private readonly _states = signal<Readonly<Record<string, ConnectionState>>>({});

  private readonly _endReasons = signal<Readonly<Record<string, EndReason>>>({});

  readonly states = this._states.asReadonly();
  /** Set once a connection closed, cleared when it opens again. */
  readonly endReasons = this._endReasons.asReadonly();

  stateOf(connectionId: string): ConnectionState {
    return this._states()[connectionId] ?? 'idle';
  }

  async connect(
    target: ConnectionTarget,
    handlers: ConnectHandlers,
    credential?: Credential,
  ): Promise<ConnectionInfo> {
    const id = target.connectionId;
    this.setEndReason(id, null);
    this.setState(id, 'connecting');
    const onEvent = new Channel<ConnectEvent>();
    onEvent.onmessage = (event) => {
      if (event.kind === 'status') {
        this.setState(id, event.state);
      } else if (event.kind === 'hostKeyPrompt') {
        this.setState(id, 'awaitingHostKey');
        void this.resolvePrompt(id, event, handlers.decide);
      } else {
        handlers.changed(event);
      }
    };
    try {
      const info = await invokeCommand<ConnectionInfo>('connect_host', {
        hostId: target.hostId,
        onEvent,
        credential: credential ?? null,
      });
      this.setState(id, 'connected');
      return info;
    } catch (err) {
      this.setState(id, 'error');
      throw err;
    }
  }

  async answerHostKey(requestId: string, accept: boolean): Promise<void> {
    await invokeCommand<null>('answer_host_key', { requestId, accept });
  }

  async replaceHostKey(connectionId: string, fingerprint: string): Promise<void> {
    await invokeCommand<null>('replace_host_key', { connectionId, fingerprint });
  }

  async disconnect(connectionId: string): Promise<void> {
    await invokeCommand<null>('disconnect_host', { connectionId });
    this.ended(connectionId, 'user');
  }

  /** The backend reported the connection closed. */
  ended(connectionId: string, reason: EndReason): void {
    this.setEndReason(connectionId, reason);
    this.setState(connectionId, 'idle');
  }

  async loadConnections(): Promise<ConnectionInfo[]> {
    const list = await invokeCommand<ConnectionInfo[]>('list_connections');
    this._states.update((states) => {
      const next = { ...states };
      for (const { connectionId, state } of list) {
        next[connectionId] = state;
      }
      return next;
    });
    return list;
  }

  private async resolvePrompt(
    connectionId: string,
    prompt: HostKeyPrompt,
    decide: ConnectHandlers['decide'],
  ): Promise<void> {
    const accept = await decide(prompt).catch(() => false);
    try {
      await this.answerHostKey(prompt.requestId, accept);
      if (accept) {
        this.setState(connectionId, 'authenticating');
      }
    } catch {
      // connect_host fails by itself once the request is gone
    }
  }

  private setEndReason(connectionId: string, reason: EndReason | null): void {
    this._endReasons.update((reasons) => {
      const next = { ...reasons };
      if (reason) {
        next[connectionId] = reason;
      } else {
        delete next[connectionId];
      }
      return next;
    });
  }

  private setState(connectionId: string, state: ConnectionState): void {
    this._states.update((states) => ({ ...states, [connectionId]: state }));
  }
}
