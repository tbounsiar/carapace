import type {
  DataCounts,
  FileScope,
  ImportPlan,
  ImportResult,
  ItemKind,
  NeedsSecret,
  PlanItem,
  PlanRow,
  Strategy,
} from '../../core/ipc/data-transfer';
import { plural } from '../project-tree/node-tree';

export const PICKER_BUSY = 'Another file dialog is open. Close it first.';

type CountKey = 'added' | 'updated' | 'unchanged' | 'copied' | 'removed' | 'skipped';

const KINDS: readonly ItemKind[] = ['project', 'collection', 'host', 'variable', 'key'];

const ROW_LABELS: Readonly<Record<ItemKind, string>> = {
  project: 'Projects',
  collection: 'Collections',
  host: 'Hosts',
  variable: 'Variables',
  key: 'SSH keys',
};

const NOUNS: Readonly<Record<ItemKind, string>> = {
  project: 'project',
  collection: 'collection',
  host: 'host',
  variable: 'variable',
  key: 'SSH key',
};

export const KIND_ICONS: Readonly<Record<ItemKind, string>> = {
  project: '@tui.folder-kanban',
  collection: '@tui.folder',
  host: '@tui.server',
  variable: '@tui.variable',
  key: '@tui.key-round',
};

const COLUMNS: Readonly<Record<Strategy, readonly { key: CountKey; label: string }[]>> = {
  merge: [
    { key: 'added', label: 'New' },
    { key: 'updated', label: 'Updated' },
    { key: 'unchanged', label: 'Unchanged' },
    { key: 'skipped', label: 'Skipped' },
  ],
  replace: [
    { key: 'added', label: 'New' },
    { key: 'updated', label: 'Updated' },
    { key: 'unchanged', label: 'Unchanged' },
    { key: 'removed', label: 'Deleted' },
  ],
  duplicate: [
    { key: 'added', label: 'New' },
    { key: 'copied', label: 'Copied' },
    { key: 'skipped', label: 'Skipped' },
  ],
};

export const STRATEGY_LABELS: Readonly<Record<Strategy, string>> = {
  merge: 'Merge',
  replace: 'Replace',
  duplicate: 'Keep both',
};

export interface TableCell {
  readonly value: number;
  readonly negative: boolean;
}

export interface TableView {
  readonly columns: readonly string[];
  readonly rows: readonly { kind: ItemKind; label: string; cells: readonly TableCell[] }[];
}

function rowOf(rows: readonly PlanRow[], kind: ItemKind): PlanRow | undefined {
  return rows.find((r) => r.kind === kind);
}

/** True when applying the plan would change nothing. */
export function nothingToImport(plan: ImportPlan): boolean {
  return plan.rows.every((r) => !r.added && !r.updated && !r.copied && !r.removed);
}

/** Rows and columns whose counts are all 0 are left out. */
export function tableView(plan: ImportPlan, strategy: Strategy): TableView {
  const columns = COLUMNS[strategy];
  const rows = KINDS.map((kind) => rowOf(plan.rows, kind)).filter(
    (row): row is PlanRow => !!row && columns.some((c) => row[c.key] > 0),
  );
  const shown = columns.filter((c) => rows.some((row) => row[c.key] > 0));
  return {
    columns: shown.map((c) => c.label),
    rows: rows.map((row) => ({
      kind: row.kind,
      label: ROW_LABELS[row.kind],
      cells: shown.map((c) => ({
        value: row[c.key],
        negative: c.key === 'removed' && row[c.key] > 0,
      })),
    })),
  };
}

/** Replace asks for a confirmation when it deletes items or keychain values. */
export function hasDeletions(plan: ImportPlan): boolean {
  return (
    plan.rows.some((r) => r.removed > 0) ||
    plan.secretValuesDeleted > 0 ||
    plan.savedSecretHosts > 0
  );
}

export function replaceSubtitle(scope: FileScope): string {
  const part =
    scope.kind === 'project'
      ? scope.projectName
      : scope.kind === 'home'
        ? 'Home and global variables'
        : 'all your data';
  return `Make ${part} exactly like the file`;
}

export function scopeText(scope: FileScope): string {
  return scope.kind === 'project'
    ? `Project “${scope.projectName}”`
    : scope.kind === 'home'
      ? 'Home'
      : 'Everything';
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "Project “Payments” · exported 5 Nov 2026, 10:12 · Carapace 0.2.0"; missing parts left out. */
export function fileMeta(file: {
  scope: FileScope;
  exportedAt: string | null;
  appVersion: string | null;
}): string {
  const parts = [scopeText(file.scope)];
  const date = file.exportedAt ? new Date(file.exportedAt) : null;
  if (date && !Number.isNaN(date.getTime())) {
    parts.push(`exported ${DATE_FORMAT.format(date)}`);
  }
  if (file.appVersion) {
    parts.push(`Carapace ${file.appVersion}`);
  }
  return parts.join(' · ');
}

/** "api-1, db-2 and 3 more". */
export function listNames(names: readonly string[], max = 5): string {
  if (names.length <= max) {
    return names.join(', ');
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** "a, b and c" */
function joinAnd(parts: readonly string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const SENTENCE_KINDS: readonly ItemKind[] = ['host', 'collection', 'project', 'variable'];

function countsOf(rows: readonly PlanRow[], key: CountKey, kinds = SENTENCE_KINDS): string[] {
  return kinds
    .map((kind) => [kind, rowOf(rows, kind)?.[key] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => plural(n, NOUNS[kind]));
}

/** "4 hosts and 2 collections added, 9 hosts updated, 1 SSH key registered." */
export function summarySentence(rows: readonly PlanRow[]): string {
  const parts: string[] = [];
  const push = (list: string[], verb: string) => {
    if (list.length) {
      parts.push(`${joinAnd(list)} ${verb}`);
    }
  };
  push(countsOf(rows, 'added'), 'added');
  push(countsOf(rows, 'copied'), 'copied');
  push(countsOf(rows, 'updated'), 'updated');
  push(countsOf(rows, 'removed'), 'deleted');
  push(countsOf(rows, 'added', ['key']), 'registered');
  push(countsOf(rows, 'updated', ['key']), 'updated');
  if (!parts.length) {
    return 'Nothing changed.';
  }
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Body of the Replace confirm (I2); `extra` holds the workspace sentences. */
export function replaceConfirmText(plan: ImportPlan, extra: string): string {
  const deleted = countsOf(plan.rows, 'removed');
  const total = SENTENCE_KINDS.reduce((n, kind) => n + (rowOf(plan.rows, kind)?.removed ?? 0), 0);
  const sentences: string[] = [];
  if (deleted.length) {
    const owner = total === 1 ? 'its' : 'their';
    sentences.push(
      `${joinAnd(deleted)} will be deleted from this computer, with ${owner} saved passwords.`,
    );
  } else if (plan.secretValuesDeleted || plan.savedSecretHosts) {
    sentences.push('Secret values and saved passwords will be deleted from this computer.');
  }
  const connections = plan.affectedConnectedHosts.length;
  if (connections) {
    sentences.push(
      connections === 1
        ? '1 open connection is closed.'
        : `${connections} open connections are closed.`,
    );
  }
  sentences.push('A backup of your data is kept.');
  return sentences.join(' ') + extra;
}

/** "Replace deletes 3 secret variable values and the saved passwords of 12 hosts from this computer." */
export function deletedSecretsText(plan: ImportPlan, strategy: Strategy): string | null {
  const values = plan.secretValuesDeleted;
  const hosts = plan.savedSecretHosts;
  if (!values && !hosts) {
    return null;
  }
  const parts = [
    values ? plural(values, 'secret variable value') : '',
    hosts ? `the saved passwords of ${plural(hosts, 'host')}` : '',
  ].filter(Boolean);
  const subject = strategy === 'replace' ? 'Replace' : 'This import';
  return `${subject} deletes ${joinAnd(parts)} from this computer.`;
}

const SECRETS_SENT_MAX = 10;

/** "api-1 will send db_pw to deploy@10.9.9.9:22 instead of old@host:22", at most 10 + "and N more". */
export function secretsSentLines(list: ImportPlan['secretsSentTo']): string[] {
  const entries = list ?? [];
  const lines = entries
    .slice(0, SECRETS_SENT_MAX)
    .map(
      (e) => `${e.host} will send ${e.variable} to ${e.to}${e.from ? ` instead of ${e.from}` : ''}`,
    );
  if (entries.length > SECRETS_SENT_MAX) {
    lines.push(`and ${entries.length - SECRETS_SENT_MAX} more`);
  }
  return lines;
}

export function secretScopeName(entry: NeedsSecret): string {
  return entry.scope.kind === 'project' ? entry.scope.projectName : 'global';
}

/** "db_pw (Payments) — used by 4 hosts" */
export function needsSecretLine(entry: NeedsSecret): string {
  return `${entry.name} (${secretScopeName(entry)}) — used by ${plural(entry.hostCount, 'host')}`;
}

export function undefinedLine(list: ImportPlan['undefinedVariables']): string {
  const parts = list.map((v) => `${v.name} (used by ${plural(v.hostCount, 'host')})`);
  return `Not defined anywhere: ${parts.join(', ')}.`;
}

export interface DetailView {
  readonly testId: string;
  readonly icon: string;
  readonly name: string;
  readonly location: string;
  readonly lines: readonly string[];
  readonly badge: { readonly label: string; readonly appearance: string };
}

const BADGES: Readonly<Record<PlanItem['action'], DetailView['badge']>> = {
  update: { label: 'Updated', appearance: 'info' },
  copy: { label: 'Copied', appearance: 'neutral' },
  rename: { label: 'Renamed', appearance: 'neutral' },
  remove: { label: 'Deleted', appearance: 'negative' },
  skip: { label: 'Skipped', appearance: 'neutral' },
};

const ACTION_ORDER: readonly PlanItem['action'][] = ['update', 'copy', 'rename', 'remove', 'skip'];

function isKeyFileSkip(item: PlanItem): boolean {
  return item.reason === 'key_file_missing' || item.reason === 'key_file_mismatch';
}

export function detailLines(item: PlanItem): string[] {
  const lines: string[] = [];
  for (const change of item.changes) {
    switch (change.field) {
      case 'address':
        lines.push(`Address: ${change.from} → ${change.to}`);
        break;
      case 'location':
        lines.push(`Moves from ${change.from} to ${change.to}`);
        break;
      case 'name':
        lines.push(`Renamed: ${change.from} → ${change.to}`);
        break;
      case 'value':
        lines.push(`Value: ${change.from} → ${change.to}`);
        break;
      case 'auth':
        lines.push(`Authentication: ${change.from} → ${change.to}`);
        break;
      case 'kind':
        lines.push(`Kind: ${change.from} → ${change.to}`);
        break;
    }
  }
  if (item.newName && item.newName !== item.name && !item.changes.some((c) => c.field === 'name')) {
    lines.push(`Renamed: ${item.name} → ${item.newName}`);
  }
  switch (item.reason) {
    case 'same_id':
      lines.push('Same id');
      break;
    case 'same_name':
    case 'name_taken':
      lines.push(`Same name as a ${NOUNS[item.kind]} here`);
      break;
    case 'kept_secret':
      lines.push('Kept as secret on this computer');
      break;
    case 'becomes_secret':
      lines.push('Becomes secret, no value');
      break;
    case 'variable_exists':
      lines.push('Skipped: a variable with this name exists here');
      break;
    case 'key_file_missing':
      if (item.detail === 'outside_home') {
        lines.push(
          `Key file outside your home folder${item.path ? `: ${item.path}` : ''}. Add it in SSH keys by hand.`,
        );
      } else {
        lines.push(
          item.path
            ? `Key file not found on this computer: ${item.path}`
            : 'Key file not found on this computer',
        );
      }
      break;
    case 'key_file_mismatch':
      lines.push(
        item.detail ? `Key file does not match (${item.detail})` : 'Key file does not match',
      );
      break;
    case 'not_in_file':
      lines.push('Deleted from this computer');
      break;
    case 'redirects_hosts':
      break;
    case 'id_in_use':
      break;
  }
  if (item.redirects?.length) {
    lines.push(
      `Changes the address of ${plural(item.redirects.length, 'host')}: ${listNames(item.redirects)}`,
    );
  }
  if (item.action === 'remove' && item.reason !== 'not_in_file') {
    lines.push('Deleted from this computer');
  }
  return lines;
}

/** Updates, copies, renames, deletions, skips, then key files not found. */
export function detailViews(items: readonly PlanItem[]): DetailView[] {
  const rank = (item: PlanItem) =>
    isKeyFileSkip(item) ? ACTION_ORDER.length : ACTION_ORDER.indexOf(item.action);
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map((entry) => entry.item);
  const seen = new Map<string, number>();
  for (const item of sorted) {
    const key = `${item.kind}-${item.name}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return sorted.map((item) => {
    const key = `${item.kind}-${item.name}`;
    const repeated = (seen.get(key) ?? 0) > 1;
    return {
      testId: `import-item-${key}${repeated ? `/${item.location.join('/')}` : ''}`,
      icon: KIND_ICONS[item.kind],
      name: item.name,
      location: item.location.join(' / '),
      lines: detailLines(item),
      badge: BADGES[item.action],
    };
  });
}

/** The summary lists what did not land as in the file: renamed and skipped items. */
export function summaryItems(result: ImportResult): PlanItem[] {
  return [
    ...result.renamed.map((r): PlanItem => ({
      kind: r.kind,
      action: 'rename',
      name: r.from,
      newName: r.to,
      location: [],
      reason: 'name_taken',
      changes: [],
    })),
    ...result.skipped,
  ];
}

/** "3 projects · 40 hosts · 25 variables" for the export toast. */
export function exportCountsText(counts: DataCounts): string {
  const parts = [
    counts.projects ? plural(counts.projects, 'project') : '',
    counts.collections ? plural(counts.collections, 'collection') : '',
    counts.hosts ? plural(counts.hosts, 'host') : '',
    counts.variables ? plural(counts.variables, 'variable') : '',
    counts.keys ? plural(counts.keys, 'SSH key') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing in it yet';
}
