import type {
  ImportPlan,
  ImportPreview,
  ImportResult,
  ItemKind,
  PlanRow,
} from '../../core/ipc/data-transfer';

export function row(kind: ItemKind, counts: Partial<Omit<PlanRow, 'kind'>> = {}): PlanRow {
  return { kind, added: 0, updated: 0, unchanged: 0, copied: 0, removed: 0, skipped: 0, ...counts };
}

export function plan(extra: Partial<ImportPlan> = {}): ImportPlan {
  return {
    rows: [],
    items: [],
    moreItems: 0,
    removedHostIds: [],
    movedHostIds: [],
    affectedConnectedHosts: [],
    secretValuesDeleted: 0,
    savedSecretHosts: 0,
    needsSecret: [],
    undefinedVariables: [],
    blocking: [],
    ...extra,
  };
}

/** Merge adds and updates; Replace also deletes 3 hosts; Keep both copies. */
export function preview(extra: Partial<ImportPreview> = {}): ImportPreview {
  return {
    importId: 'i1',
    fileName: 'carapace-payments-2026-11-05.json',
    file: {
      scope: { kind: 'project', projectName: 'Payments' },
      exportedAt: '2026-11-05T10:12:00Z',
      appVersion: '0.2.0',
      counts: { projects: 1, collections: 2, hosts: 5, variables: 2, secretVariables: 1, keys: 0 },
    },
    plans: {
      merge: plan({
        rows: [
          row('host', { added: 4, updated: 9, unchanged: 7 }),
          row('collection', { added: 2 }),
        ],
        items: [
          {
            kind: 'host',
            action: 'update',
            name: 'api-1',
            newName: null,
            location: ['Payments', 'Backend'],
            reason: 'same_id',
            changes: [{ field: 'address', from: 'deploy@10.0.1.5:22', to: 'deploy@10.0.9.5:22' }],
          },
        ],
        needsSecret: [{ scope: { kind: 'global' }, name: 'root_pw', hostCount: 1 }],
      }),
      replace: plan({
        rows: [row('host', { added: 4, updated: 9, removed: 3 })],
        items: [
          {
            kind: 'host',
            action: 'remove',
            name: 'old-1',
            newName: null,
            location: ['Payments'],
            reason: 'not_in_file',
            changes: [],
          },
        ],
        removedHostIds: ['h9'],
        affectedConnectedHosts: ['old-1'],
        secretValuesDeleted: 2,
        savedSecretHosts: 3,
      }),
      duplicate: plan({
        rows: [row('host', { added: 4, copied: 9 })],
        items: [
          {
            kind: 'host',
            action: 'copy',
            name: 'api-1',
            newName: 'api-1 (imported)',
            location: ['Payments'],
            reason: 'same_name',
            changes: [],
          },
        ],
      }),
    },
    ...extra,
  };
}

export function result(extra: Partial<ImportResult> = {}): ImportResult {
  return {
    rows: [row('host', { added: 4, updated: 9 }), row('collection', { added: 2 })],
    renamed: [],
    skipped: [],
    disconnected: [],
    needsSecret: [],
    backupName: 'data-20261105-101200-before-import.json',
    secretValuesDeleted: 0,
    ...extra,
  };
}
