import type { ConfigService } from '../../core/ipc/config';
import type { EditedFile, EditedState } from '../../core/ipc/external-edits';
import { errorText } from '../project-tree/save-error';

export type StateLook =
  | { readonly kind: 'loader'; readonly word: string }
  | { readonly kind: 'status'; readonly word: string; readonly color: string }
  | {
      readonly kind: 'badge';
      readonly word: string;
      readonly appearance: string;
      readonly icon: string;
    };

const pad = (n: number) => String(n).padStart(2, '0');

/** Local "14:02". */
export function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local "3 Nov 23:10". */
export function dayTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clockTime(ms)}`;
}

/** Shape, colour and word of a state: never colour alone (UX spec, States). */
export function stateLook(file: EditedFile): StateLook {
  switch (file.state) {
    case 'opening':
      return { kind: 'loader', word: 'Opening…' };
    case 'uploading':
      return { kind: 'loader', word: 'Uploading…' };
    case 'synced':
      return {
        kind: 'status',
        color: 'var(--tui-status-positive)',
        word:
          file.lastUploadedAt === null
            ? 'No changes'
            : `Uploaded ${clockTime(file.lastUploadedAt)}`,
      };
    case 'disconnected':
      return { kind: 'status', color: 'var(--tui-status-neutral)', word: 'Disconnected' };
    case 'conflict':
      return {
        kind: 'badge',
        appearance: 'warning',
        icon: '@tui.triangle-alert',
        word: 'Changed on server',
      };
    case 'failed':
      return {
        kind: 'badge',
        appearance: 'negative',
        icon: '@tui.circle-x',
        word: 'Upload failed',
      };
    case 'waiting':
      return {
        kind: 'badge',
        appearance: 'neutral',
        icon: '@tui.unplug',
        word: 'Waiting for connection',
      };
    case 'recovered':
      return {
        kind: 'badge',
        appearance: 'warning',
        icon: '@tui.history',
        word:
          file.recoveredAt === null
            ? 'Not uploaded'
            : `Not uploaded (from ${dayTime(file.recoveredAt)})`,
      };
  }
}

export type RowAction = 'resolve' | 'retry' | 'reconnect' | 'upload';

const ROW_ACTIONS: Partial<Record<EditedState, { action: RowAction; label: string }>> = {
  conflict: { action: 'resolve', label: 'Resolve' },
  failed: { action: 'retry', label: 'Retry' },
  waiting: { action: 'reconnect', label: 'Reconnect' },
  recovered: { action: 'upload', label: 'Upload' },
};

export function rowAction(file: EditedFile): { action: RowAction; label: string } | null {
  return ROW_ACTIONS[file.state] ?? null;
}

/** "vps (Payments)", "vps" at Home; null when the host no longer exists. */
export function hostLabel(config: ConfigService, hostId: string): string | null {
  const found = config.findHost(hostId);
  if (!found) {
    return null;
  }
  return found.project ? `${found.host.name} (${found.project.name})` : found.host.name;
}

/**
 * Failures nothing overrides, so no Retry nor Overwrite: the host reaches another server, or the
 * server's new content is something the system opener would run.
 */
export function lockedFailure(file: EditedFile): boolean {
  return (
    file.state === 'failed' &&
    (file.error?.code === 'host_changed' || file.error?.code === 'blocked_type')
  );
}

/** "deploy.bat would be run, not opened, by your system. Choose an editor app …". */
export function blockedTypeText(name: string): string {
  const ext = extensionOf(name);
  const files = ext ? `.${ext} files` : 'this file';
  return `${name} would be run, not opened, by your system. Choose an editor app in Settings to edit ${files}.`;
}

/**
 * Why the file can no longer be uploaded or opened: its host is gone, or reaches another server.
 * `host` is the host's name from the config, null when the config no longer has it.
 */
export function uploadBlocker(file: EditedFile, host: string | null): string | null {
  if (lockedFailure(file)) {
    return file.error?.code === 'blocked_type'
      ? 'Your system would run this file'
      : `${host ?? 'The host'} now points to another server`;
  }
  if (!file.canUpload || host === null) {
    return host === null ? 'The host no longer exists' : `${host} no longer exists`;
  }
  return null;
}

/** Plain host name for sentences; "the server" when the host is gone. */
export function hostName(config: ConfigService, hostId: string): string {
  return config.findHost(hostId)?.host.name ?? 'the server';
}

/**
 * Why an upload failed, in the user's words (spec Copy, upload failure reasons and lock reasons).
 * `host` is null when the config no longer has the host.
 */
export function failureReason(file: EditedFile, hostName: string | null): string | null {
  const error = file.error;
  if (!error) {
    return null;
  }
  const host = hostName ?? 'the server';
  switch (error.code) {
    case 'permission_denied':
      return `Permission denied on ${host}.`;
    case 'not_found':
      return `The folder no longer exists on ${host}.`;
    case 'network':
    case 'not_connected':
      return 'Connection lost during the upload.';
    case 'host_changed':
      return `${hostName ?? 'The host'} now points to another server. Nothing was sent. Copy your changes out with Show in folder, then stop editing.`;
    case 'blocked_type':
      return 'Your system would run this file. Choose an editor app in Settings.';
    default:
      return errorText(error);
  }
}

/** "a, b, c, d, e and 2 more". */
export function nameList(names: readonly string[], max = 5): string {
  if (names.length <= max) {
    return names.join(', ');
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** "app.env (db-1), logo.png (web)", like the unsaved editor tabs in the quit dialog. */
export function notUploadedNames(
  files: readonly EditedFile[],
  hostOf: (hostId: string) => string,
): string {
  return files.map((f) => `${f.name} (${hostOf(f.hostId)})`).join(', ');
}

/** Extra sentences of a host / collection / project delete confirm (spec X5). */
export function deleteLines(affected: readonly EditedFile[]): string {
  if (!affected.length) {
    return '';
  }
  const count =
    affected.length === 1
      ? '1 file open in an external editor'
      : `${affected.length} files open in an external editor`;
  const lost = affected.filter((f) => f.notUploaded).map((f) => f.name);
  const lostLine = lost.length ? ` Changes not uploaded in ${lost.join(', ')} will be lost.` : '';
  return ` ${count} will stop syncing.${lostLine}`;
}

/** The extension of a file name, without the dot; '' for none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}
