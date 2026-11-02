import { Service, signal } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { invokeCommand } from './ipc-error';
import type {
  ConnectEvent,
  ConnectionInfo,
  ConnectionState,
  Credential,
  HostKeyChanged,
  HostKeyPrompt,
} from './ssh.models';

export interface ConnectHandlers {
  decide: (prompt: HostKeyPrompt) => Promise<boolean>;
  changed: (event: HostKeyChanged) => void;
}

@Service()
export class SshService {
  private readonly _states = signal<Readonly<Record<string, ConnectionState>>>({});

  readonly states = this._states.asReadonly();

  stateOf(hostId: string): ConnectionState {
    return this._states()[hostId] ?? 'idle';
  }

  async connect(
    hostId: string,
    handlers: ConnectHandlers,
    credential?: Credential,
  ): Promise<ConnectionInfo> {
    this.setState(hostId, 'connecting');
    const onEvent = new Channel<ConnectEvent>();
    onEvent.onmessage = (event) => {
      if (event.kind === 'status') {
        this.setState(hostId, event.state);
      } else if (event.kind === 'hostKeyPrompt') {
        this.setState(hostId, 'awaitingHostKey');
        void this.resolvePrompt(hostId, event, handlers.decide);
      } else {
        handlers.changed(event);
      }
    };
    try {
      const info = await invokeCommand<ConnectionInfo>('connect_host', {
        hostId,
        onEvent,
        credential: credential ?? null,
      });
      this.setState(hostId, 'connected');
      return info;
    } catch (err) {
      this.setState(hostId, 'error');
      throw err;
    }
  }

  async answerHostKey(requestId: string, accept: boolean): Promise<void> {
    await invokeCommand<null>('answer_host_key', { requestId, accept });
  }

  async replaceHostKey(hostId: string, fingerprint: string): Promise<void> {
    await invokeCommand<null>('replace_host_key', { hostId, fingerprint });
  }

  async disconnect(hostId: string): Promise<void> {
    await invokeCommand<null>('disconnect_host', { hostId });
    this.setState(hostId, 'idle');
  }

  async loadConnections(): Promise<ConnectionInfo[]> {
    const list = await invokeCommand<ConnectionInfo[]>('list_connections');
    this._states.update((states) => {
      const next = { ...states };
      for (const { hostId, state } of list) {
        next[hostId] = state;
      }
      return next;
    });
    return list;
  }

  private async resolvePrompt(
    hostId: string,
    prompt: HostKeyPrompt,
    decide: ConnectHandlers['decide'],
  ): Promise<void> {
    const accept = await decide(prompt).catch(() => false);
    try {
      await this.answerHostKey(prompt.requestId, accept);
      if (accept) {
        this.setState(hostId, 'authenticating');
      }
    } catch {
      // connect_host fails by itself once the request is gone
    }
  }

  private setState(hostId: string, state: ConnectionState): void {
    this._states.update((states) => ({ ...states, [hostId]: state }));
  }
}
