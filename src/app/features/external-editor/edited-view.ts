import { translate } from '@jsverse/transloco';
import type { ConfigService } from '../../core/ipc/config';
import type { EditedFile, EditedState } from '../../core/ipc/external-edits';
import { errorText } from '../../shared/save-error';

export type StateLook =
  | { readonly kind: 'loader'; readonly word: string }
  | { readonly kind: 'status'; readonly word: string; readonly color: string }
  | {
      readonly kind: 'badge';
      readonly word: string;
      readonly appearance: string;
      readonly icon: string;
    };

const t = (key: string, params?: Record<string, unknown>): string =>
  translate(`externalEditor.view.${key}`, params);

/** Local time, "2:02 PM" / "14:02". */
export function clockTime(ms: number, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(ms));
}

/** Local day and time, "Nov 3, 11:10 PM" / "3 nov., 23:10". */
export function dayTime(ms: number, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** Shape, colour and word of a state: never colour alone (UX spec, States). */
export function stateLook(file: EditedFile, locale = 'en-US'): StateLook {
  switch (file.state) {
    case 'opening':
      return { kind: 'loader', word: t('opening') };
    case 'uploading':
      return { kind: 'loader', word: t('uploading') };
    case 'synced':
      return {
        kind: 'status',
        color: 'var(--tui-status-positive)',
        word:
          file.lastUploadedAt === null
            ? t('noChanges')
            : t('uploaded', { time: clockTime(file.lastUploadedAt, locale) }),
      };
    case 'disconnected':
      return { kind: 'status', color: 'var(--tui-status-neutral)', word: t('disconnected') };
    case 'conflict':
      return {
        kind: 'badge',
        appearance: 'warning',
        icon: '@tui.triangle-alert',
        word: t('changedOnServer'),
      };
    case 'failed':
      return {
        kind: 'badge',
        appearance: 'negative',
        icon: '@tui.circle-x',
        word: t('uploadFailed'),
      };
    case 'waiting':
      return {
        kind: 'badge',
        appearance: 'neutral',
        icon: '@tui.unplug',
        word: t('waiting'),
      };
    case 'recovered':
      return {
        kind: 'badge',
        appearance: 'warning',
        icon: '@tui.history',
        word:
          file.recoveredAt === null
            ? t('notUploaded')
            : t('notUploadedFrom', { date: dayTime(file.recoveredAt, locale) }),
      };
  }
}

export type RowAction = 'resolve' | 'retry' | 'reconnect' | 'upload';

const ROW_ACTIONS: Partial<Record<EditedState, RowAction>> = {
  conflict: 'resolve',
  failed: 'retry',
  waiting: 'reconnect',
  recovered: 'upload',
};

export function rowAction(file: EditedFile): { action: RowAction; label: string } | null {
  const action = ROW_ACTIONS[file.state];
  return action ? { action, label: translate(`externalEditor.rowAction.${action}`) } : null;
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
  return ext ? t('blockedTypeExt', { name, ext }) : t('blockedTypeFile', { name });
}

/**
 * Why the file can no longer be uploaded or opened: its host is gone, or reaches another server.
 * `host` is the host's name from the config, null when the config no longer has it.
 */
export function uploadBlocker(file: EditedFile, host: string | null): string | null {
  if (lockedFailure(file)) {
    return file.error?.code === 'blocked_type'
      ? t('wouldRun')
      : host === null
        ? t('unknownOtherServer')
        : t('otherServer', { host });
  }
  if (!file.canUpload || host === null) {
    return host === null ? t('unknownGone') : t('hostGone', { host });
  }
  return null;
}

/** Plain host name for sentences; "the server" when the host is gone. */
export function hostName(config: ConfigService, hostId: string): string {
  return config.findHost(hostId)?.host.name ?? t('theServer');
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
  const host = hostName ?? t('theServer');
  switch (error.code) {
    case 'permission_denied':
      return t('permissionDenied', { host });
    case 'not_found':
      return t('folderGone', { host });
    case 'network':
    case 'not_connected':
      return t('connectionLost');
    case 'host_changed':
      return hostName === null ? t('unknownHostChanged') : t('hostChanged', { host: hostName });
    case 'blocked_type':
      return t('blockedType');
    default:
      return errorText(error);
  }
}

/** "a, b, c, d, e and 2 more". */
export function nameList(names: readonly string[], max = 5): string {
  if (names.length <= max) {
    return names.join(', ');
  }
  return t('nameListMore', { names: names.slice(0, max).join(', '), count: names.length - max });
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
  const lost = affected.filter((f) => f.notUploaded).map((f) => f.name);
  const lostLine = lost.length ? ` ${t('deleteLost', { names: lost.join(', ') })}` : '';
  return ` ${t('deleteStops', { count: affected.length })}${lostLine}`;
}

/** The extension of a file name, without the dot; '' for none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}
