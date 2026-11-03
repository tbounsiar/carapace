import { Service } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { invokeCommand } from './ipc-error';

export interface QuitRequested {
  readonly kind: 'quitRequested';
}

export type AppEvent = QuitRequested;

/** Window lifecycle owned by the backend: closing is held back while the guard is set. */
@Service()
export class AppEvents {
  async setQuitGuard(active: boolean): Promise<void> {
    await invokeCommand<null>('set_quit_guard', { active });
  }

  async subscribe(onEvent: (event: AppEvent) => void): Promise<void> {
    const channel = new Channel<AppEvent>();
    channel.onmessage = onEvent;
    await invokeCommand<null>('subscribe_app_events', { onEvent: channel });
  }

  async quit(): Promise<void> {
    await invokeCommand<null>('quit_app');
  }
}
