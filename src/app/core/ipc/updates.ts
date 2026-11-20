import { Service } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { invokeCommand } from './ipc-error';

export interface UpdateInfo {
  readonly version: string;
  /** ISO 8601, UTC. */
  readonly date: string | null;
}

/** `downloadOnly`: deb/rpm and dev builds; the release page replaces the in-app install. */
export type InstallKind = 'inPlace' | 'downloadOnly';

export interface UpdateState {
  readonly current: string;
  readonly autoCheck: boolean;
  readonly skippedVersion: string | null;
  /** ISO 8601, UTC; last successful check of this run. */
  readonly lastCheck: string | null;
  readonly available: UpdateInfo | null;
  readonly downloaded: boolean;
  readonly installKind: InstallKind;
}

export interface UpdateAvailable {
  readonly kind: 'available';
  readonly info: UpdateInfo;
}

export type UpdateEvent = UpdateAvailable;

export interface UpdateProgress {
  readonly downloaded: number;
  readonly total: number | null;
}

/** The update commands. The plugin's own webview commands are not granted. */
@Service()
export class UpdatesIpc {
  state(): Promise<UpdateState> {
    return invokeCommand<UpdateState>('update_state');
  }

  setAutoCheck(enabled: boolean): Promise<UpdateState> {
    return invokeCommand<UpdateState>('set_update_auto_check', { enabled });
  }

  /** Ignores the skipped version and pushes no event. */
  check(): Promise<UpdateInfo | null> {
    return invokeCommand<UpdateInfo | null>('check_update');
  }

  /** Automatic checks; an update found before the subscription is replayed unless skipped. */
  async subscribe(onEvent: (event: UpdateEvent) => void): Promise<void> {
    const channel = new Channel<UpdateEvent>();
    channel.onmessage = onEvent;
    await invokeCommand<null>('subscribe_updates', { onEvent: channel });
  }

  skip(version: string): Promise<UpdateState> {
    return invokeCommand<UpdateState>('skip_update', { version });
  }

  /** Resolves once downloaded and verified; rejects `cancelled` after `cancelDownload`. */
  async download(onProgress: (progress: UpdateProgress) => void): Promise<void> {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onProgress;
    await invokeCommand<null>('download_update', { onProgress: channel });
  }

  async cancelDownload(): Promise<void> {
    await invokeCommand<null>('cancel_update_download');
  }

  /**
   * The app exits or restarts on success. `confirmed` says the page already decided (confirm
   * accepted, Restart now, or nothing open); without it the backend refuses while work is open.
   */
  async apply(confirmed: boolean): Promise<void> {
    await invokeCommand<null>('apply_update', { confirmed });
  }

  async openReleaseNotes(version: string): Promise<void> {
    await invokeCommand<null>('open_release_notes', { version });
  }
}
