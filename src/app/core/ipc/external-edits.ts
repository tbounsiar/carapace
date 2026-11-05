import { Service } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import type { BackendText } from './backend-text';
import { invokeCommand } from './ipc-error';

export type EditedState =
  | 'opening'
  | 'synced'
  | 'uploading'
  | 'conflict'
  | 'failed'
  | 'waiting'
  | 'disconnected'
  | 'recovered';

/**
 * A remote file open in an external editor. The local copy's path never crosses IPC: the
 * backend opens, reveals and deletes it by id.
 */
export interface EditedFile {
  readonly id: string;
  readonly hostId: string;
  readonly remotePath: string;
  readonly name: string;
  readonly state: EditedState;
  /** Only in `conflict`. */
  readonly conflict: 'changed' | 'deleted' | null;
  /** Only in `failed`. */
  readonly error: (BackendText & { readonly code: string }) | null;
  /** Unix milliseconds, like every time below. */
  readonly openedAt: number;
  readonly lastSyncedAt: number | null;
  /** null: nothing uploaded since the file was opened. */
  readonly lastUploadedAt: number | null;
  readonly recoveredAt: number | null;
  readonly size: number;
  readonly notUploaded: boolean;
  readonly needsAttention: boolean;
  readonly watched: boolean;
  /**
   * False for a recovered copy whose host no longer exists (or whose config could not be read):
   * upload, resolve and open then fail `not_found`; only reveal and discard work.
   */
  readonly canUpload: boolean;
}

export type EditedEvent =
  | { readonly kind: 'updated'; readonly file: EditedFile }
  | { readonly kind: 'removed'; readonly id: string };

export interface OpenExternalRequest {
  readonly connectionId: string;
  readonly path: string;
  /** From the listing; the backend checks the real size too. */
  readonly size?: number | null;
  readonly confirmLarge?: boolean;
  readonly confirmSensitive?: boolean;
}

export type ConflictChoice = 'overwrite' | 'useServer';

export interface DeleteTarget {
  readonly kind: 'host' | 'collection' | 'project';
  readonly id: string;
}

export interface ExternalEditorSetting {
  readonly mode: 'system' | 'custom';
  readonly appPath: string | null;
  readonly noticeSeen: boolean;
}

/** Above this size the backend asks for `confirmLarge`. */
export const CONFIRM_LARGE_BYTES = 20 * 1024 * 1024;
/** The backend refuses anything larger. */
export const MAX_EXTERNAL_BYTES = 1024 * 1024 * 1024;

/** Remote files edited in an external app: copies, uploads, conflicts and the app setting. */
@Service()
export class ExternalEditsIpc {
  open(request: OpenExternalRequest): Promise<EditedFile> {
    const { connectionId, path, size, confirmLarge, confirmSensitive } = request;
    return invokeCommand<EditedFile>('open_external', {
      connectionId,
      path,
      size: size ?? null,
      confirmLarge: confirmLarge ?? false,
      confirmSensitive: confirmSensitive ?? false,
    });
  }

  /** The backend keeps one subscriber: a new call replaces the previous channel. */
  subscribe(onEvent: (event: EditedEvent) => void): Promise<EditedFile[]> {
    const channel = new Channel<EditedEvent>();
    channel.onmessage = onEvent;
    return invokeCommand<EditedFile[]>('subscribe_edited', { onEvent: channel });
  }

  list(): Promise<EditedFile[]> {
    return invokeCommand<EditedFile[]>('list_edited');
  }

  hasUnsynced(): Promise<boolean> {
    return invokeCommand<boolean>('has_unsynced');
  }

  uploadNow(id: string): Promise<EditedFile> {
    return invokeCommand<EditedFile>('upload_now', { id });
  }

  /** `useServer` downloads again: over 20 MiB it fails with `large_file` unless confirmed. */
  resolveConflict(id: string, choice: ConflictChoice, confirmLarge = false): Promise<EditedFile> {
    return invokeCommand<EditedFile>('resolve_conflict', { id, choice, confirmLarge });
  }

  /** Fails with `not_uploaded` when the copy holds changes and `force` is false. */
  async stop(id: string, force: boolean): Promise<void> {
    await invokeCommand<null>('stop_editing', { id, force });
  }

  stopAll(force: boolean): Promise<number> {
    return invokeCommand<number>('stop_all_editing', { force });
  }

  async discardRecovered(id: string): Promise<void> {
    await invokeCommand<null>('discard_recovered', { id });
  }

  async reveal(id: string): Promise<void> {
    await invokeCommand<null>('reveal', { id });
  }

  affected(target: DeleteTarget): Promise<EditedFile[]> {
    return invokeCommand<EditedFile[]>('edited_affected', { target });
  }

  getEditor(): Promise<ExternalEditorSetting> {
    return invokeCommand<ExternalEditorSetting>('get_external_editor');
  }

  setEditor(setting: ExternalEditorSetting): Promise<ExternalEditorSetting> {
    return invokeCommand<ExternalEditorSetting>('set_external_editor', { ...setting });
  }

  /** The native picker runs in the backend; null when cancelled or another picker is open. */
  async pickEditor(current: string | null): Promise<string | null> {
    try {
      return await invokeCommand<string | null>('pick_external_editor', { current });
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'busy') {
        return null;
      }
      throw err;
    }
  }
}
