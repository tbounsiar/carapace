import { Service } from '@angular/core';
import { invokeCommand } from './ipc-error';

export type DataScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'home' }
  | { readonly kind: 'project'; readonly projectId: string };

export type ItemKind = 'project' | 'collection' | 'host' | 'variable' | 'key';

/** `duplicate` is "Keep both". */
export type Strategy = 'merge' | 'replace' | 'duplicate';

export const STRATEGIES: readonly Strategy[] = ['merge', 'replace', 'duplicate'];

export interface DataCounts {
  readonly projects: number;
  readonly collections: number;
  readonly hosts: number;
  readonly variables: number;
  readonly secretVariables: number;
  readonly keys: number;
}

export interface ExportResult {
  /** Base name only. */
  readonly fileName: string;
  readonly counts: DataCounts;
}

export type FileScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'home' }
  | { readonly kind: 'project'; readonly projectName: string };

export interface PlanRow {
  readonly kind: ItemKind;
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly copied: number;
  readonly removed: number;
  readonly skipped: number;
}

export type PlanAction = 'update' | 'copy' | 'rename' | 'remove' | 'skip';

export type PlanReason =
  | 'same_id'
  | 'same_name'
  | 'id_in_use'
  | 'name_taken'
  | 'kept_secret'
  | 'becomes_secret'
  | 'variable_exists'
  | 'key_file_missing'
  | 'key_file_mismatch'
  | 'not_in_file'
  | 'redirects_hosts';

export interface PlanChange {
  readonly field: 'name' | 'address' | 'location' | 'auth' | 'value' | 'kind';
  /** Plain data only (raw templates, plain values, paths), never a secret. */
  readonly from: string;
  readonly to: string;
}

export interface PlanItem {
  readonly kind: ItemKind;
  readonly action: PlanAction;
  readonly name: string;
  readonly newName: string | null;
  /** Path segments, scope first. */
  readonly location: readonly string[];
  readonly reason: PlanReason;
  readonly changes: readonly PlanChange[];
  /** Keys only: the path as written in the file (`~/…` under the home folder). */
  readonly path?: string;
  /**
   * Keys: the algorithm the file announces (`key_file_mismatch`), or `outside_home`
   * (`key_file_missing`: the path is outside the user's home and was not inspected).
   */
  readonly detail?: string;
  /** Variables: the hosts whose address this change moves. */
  readonly redirects?: readonly string[];
}

export type SecretScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string; readonly projectName: string };

export interface NeedsSecret {
  readonly scope: SecretScope;
  readonly name: string;
  readonly hostCount: number;
}

/** A host whose secret variable would be sent to a target it does not reach today. */
export interface SecretTarget {
  readonly host: string;
  readonly location: readonly string[];
  readonly variable: string;
  /** `user@host:port` today; null for a new host. */
  readonly from: string | null;
  readonly to: string;
}

export interface ImportPlan {
  readonly rows: readonly PlanRow[];
  /** At most 500. */
  readonly items: readonly PlanItem[];
  readonly moreItems: number;
  readonly removedHostIds: readonly string[];
  /** Cross-scope moves. */
  readonly movedHostIds: readonly string[];
  /** Names of connected hosts that are removed or moved. */
  readonly affectedConnectedHosts: readonly string[];
  readonly secretValuesDeleted: number;
  readonly savedSecretHosts: number;
  readonly needsSecret: readonly NeedsSecret[];
  readonly undefinedVariables: readonly { readonly name: string; readonly hostCount: number }[];
  /** Non-empty: this strategy cannot be applied. */
  readonly blocking: readonly string[];
  /** Absent from older backends: read as empty. */
  readonly secretsSentTo?: readonly SecretTarget[];
}

export interface ImportPreview {
  /** Opaque; one pending import at a time. */
  readonly importId: string;
  readonly fileName: string;
  readonly file: {
    readonly scope: FileScope;
    readonly exportedAt: string | null;
    readonly appVersion: string | null;
    readonly counts: DataCounts;
  };
  readonly plans: Readonly<Record<Strategy, ImportPlan>>;
}

export interface ImportResult {
  readonly rows: readonly PlanRow[];
  readonly renamed: readonly {
    readonly kind: ItemKind;
    readonly from: string;
    readonly to: string;
  }[];
  readonly skipped: readonly PlanItem[];
  /** Host names. */
  readonly disconnected: readonly string[];
  readonly needsSecret: readonly NeedsSecret[];
  /** Base name in the backups folder of the app home. */
  readonly backupName: string;
  readonly secretValuesDeleted: number;
}

/**
 * Export and import of data files. The backend opens the OS pickers and reads or writes the file
 * itself: no path or file content crosses IPC.
 */
@Service()
export class DataTransferIpc {
  /** Null when the save dialog was cancelled. */
  exportData(scope: DataScope, includeShared: boolean): Promise<ExportResult | null> {
    return invokeCommand<ExportResult | null>('export_data', { scope, includeShared });
  }

  /** Opens the open dialog and plans the three strategies; null when cancelled. */
  previewImport(): Promise<ImportPreview | null> {
    return invokeCommand<ImportPreview | null>('preview_import');
  }

  /** The same parsed file, planned again against the current data. */
  refreshImport(importId: string): Promise<ImportPreview> {
    return invokeCommand<ImportPreview>('refresh_import', { importId });
  }

  applyImport(importId: string, strategy: Strategy): Promise<ImportResult> {
    return invokeCommand<ImportResult>('apply_import', { importId, strategy });
  }

  async undoImport(importId: string): Promise<void> {
    await invokeCommand<null>('undo_import', { importId });
  }

  /** Drops the pending import and its undo state; an unknown id is fine. */
  async cancelImport(importId: string): Promise<void> {
    await invokeCommand<null>('cancel_import', { importId });
  }
}
