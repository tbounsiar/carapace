import type { AuthMethod } from '../../core/ipc/config.models';
import type {
  DataCounts,
  FileScope,
  ImportPlan,
  ImportResult,
  ItemKind,
  NeedsSecret,
  PlanChange,
  PlanItem,
  PlanRow,
  Strategy,
} from '../../core/ipc/data-transfer';

/** `TranslocoService.translate`, passed in so these stay pure functions. */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

export const PICKER_BUSY = 'dataTransfer.pickerBusy';

type CountKey = 'added' | 'updated' | 'unchanged' | 'copied' | 'removed' | 'skipped';

const KINDS: readonly ItemKind[] = ['project', 'collection', 'host', 'variable', 'key'];

/** Grammatical gender of each noun in French; English ignores it. */
const FEMININE: ReadonlySet<ItemKind> = new Set<ItemKind>(['collection', 'variable', 'key']);

/** `ms`, `mp`, `fs` or `fp`: how a French participle agrees with a list of counted nouns. */
function agreement(kinds: readonly ItemKind[], total: number): string {
  const gender = kinds.every((kind) => FEMININE.has(kind)) ? 'f' : 'm';
  return gender + (total === 1 ? 's' : 'p');
}

export function countOf(t: Translate, kind: ItemKind, count: number): string {
  return t(`dataTransfer.count.${kind}`, { count });
}

export const KIND_ICONS: Readonly<Record<ItemKind, string>> = {
  project: '@tui.folder-kanban',
  collection: '@tui.folder',
  host: '@tui.server',
  variable: '@tui.variable',
  key: '@tui.key-round',
};

const COLUMNS: Readonly<Record<Strategy, readonly CountKey[]>> = {
  merge: ['added', 'updated', 'unchanged', 'skipped'],
  replace: ['added', 'updated', 'unchanged', 'removed'],
  duplicate: ['added', 'copied', 'skipped'],
};

export function strategyLabel(t: Translate, strategy: Strategy): string {
  return t(`dataTransfer.strategy.${strategy}`);
}

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
export function tableView(t: Translate, plan: ImportPlan, strategy: Strategy): TableView {
  const columns = COLUMNS[strategy];
  const rows = KINDS.map((kind) => rowOf(plan.rows, kind)).filter(
    (row): row is PlanRow => !!row && columns.some((c) => row[c] > 0),
  );
  const shown = columns.filter((c) => rows.some((row) => row[c] > 0));
  return {
    columns: shown.map((c) => t(`dataTransfer.columns.${c}`)),
    rows: rows.map((row) => ({
      kind: row.kind,
      label: t(`dataTransfer.kinds.${row.kind}`),
      cells: shown.map((c) => ({
        value: row[c],
        negative: c === 'removed' && row[c] > 0,
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

export function replaceSubtitle(t: Translate, scope: FileScope): string {
  return scope.kind === 'project'
    ? t('dataTransfer.replaceNote.project', { name: scope.projectName })
    : t(`dataTransfer.replaceNote.${scope.kind}`);
}

export function scopeText(t: Translate, scope: FileScope): string {
  return scope.kind === 'project'
    ? t('dataTransfer.scope.project', { name: scope.projectName })
    : t(`dataTransfer.scope.${scope.kind}`);
}

/** "Project “Payments” · exported Nov 5, 2026, 10:12 AM · Carapace 0.2.0"; missing parts left out. */
export function fileMeta(
  t: Translate,
  locale: string,
  file: { scope: FileScope; exportedAt: string | null; appVersion: string | null },
): string {
  const parts = [scopeText(t, file.scope)];
  const date = file.exportedAt ? new Date(file.exportedAt) : null;
  if (date && !Number.isNaN(date.getTime())) {
    const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    parts.push(t('dataTransfer.import.exported', { date: format.format(date) }));
  }
  if (file.appVersion) {
    parts.push(`Carapace ${file.appVersion}`);
  }
  return parts.join(' · ');
}

/** "api-1, db-2 and 3 more". */
export function listNames(t: Translate, names: readonly string[], max = 5): string {
  if (names.length <= max) {
    return names.join(', ');
  }
  return t('dataTransfer.andMore', {
    names: names.slice(0, max).join(', '),
    count: names.length - max,
  });
}

/** "a, b and c" */
function joinAnd(t: Translate, parts: readonly string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? '')
    : t('dataTransfer.and', { head: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
}

const SENTENCE_KINDS: readonly ItemKind[] = ['host', 'collection', 'project', 'variable'];

interface Counted {
  readonly list: string;
  readonly form: string;
}

function countsOf(
  t: Translate,
  rows: readonly PlanRow[],
  key: CountKey,
  kinds = SENTENCE_KINDS,
): Counted | null {
  const found = kinds
    .map((kind) => [kind, rowOf(rows, kind)?.[key] ?? 0] as const)
    .filter(([, n]) => n > 0);
  if (!found.length) {
    return null;
  }
  const total = found.reduce((sum, [, n]) => sum + n, 0);
  return {
    list: joinAnd(
      t,
      found.map(([kind, n]) => countOf(t, kind, n)),
    ),
    form: agreement(
      found.map(([kind]) => kind),
      total,
    ),
  };
}

type Verb = 'added' | 'copied' | 'updated' | 'removed' | 'registered';

/** "4 hosts and 2 collections added, 9 hosts updated, 1 SSH key registered." */
export function summarySentence(t: Translate, rows: readonly PlanRow[]): string {
  const entries: [Counted | null, Verb][] = [
    [countsOf(t, rows, 'added'), 'added'],
    [countsOf(t, rows, 'copied'), 'copied'],
    [countsOf(t, rows, 'updated'), 'updated'],
    [countsOf(t, rows, 'removed'), 'removed'],
    [countsOf(t, rows, 'added', ['key']), 'registered'],
    [countsOf(t, rows, 'updated', ['key']), 'updated'],
  ];
  const parts = entries.flatMap(([counted, verb]) =>
    counted ? [t(`dataTransfer.summary.${verb}`, { list: counted.list, form: counted.form })] : [],
  );
  if (!parts.length) {
    return t('dataTransfer.summary.nothing');
  }
  const text = parts.join(', ');
  return t('dataTransfer.summary.sentence', {
    text: `${text.charAt(0).toUpperCase()}${text.slice(1)}`,
  });
}

/** Body of the Replace confirm (I2); `extra` holds the workspace sentences. */
export function replaceConfirmText(t: Translate, plan: ImportPlan, extra: string): string {
  const deleted = countsOf(t, plan.rows, 'removed');
  const sentences: string[] = [];
  if (deleted) {
    sentences.push(t('dataTransfer.confirm.deleted', { list: deleted.list, form: deleted.form }));
  } else if (plan.secretValuesDeleted || plan.savedSecretHosts) {
    sentences.push(t('dataTransfer.confirm.secretsDeleted'));
  }
  const connections = plan.affectedConnectedHosts.length;
  if (connections) {
    sentences.push(t('dataTransfer.confirm.connections', { count: connections }));
  }
  sentences.push(t('dataTransfer.confirm.backup'));
  return sentences.join(' ') + extra;
}

/** "Replace deletes 3 secret variable values and the saved passwords of 12 hosts from this computer." */
export function deletedSecretsText(
  t: Translate,
  plan: ImportPlan,
  strategy: Strategy,
): string | null {
  const values = plan.secretValuesDeleted;
  const hosts = plan.savedSecretHosts;
  if (!values && !hosts) {
    return null;
  }
  const parts = [
    values ? t('dataTransfer.count.secretValue', { count: values }) : '',
    hosts ? t('dataTransfer.deletedSecrets.savedPasswords', { count: hosts }) : '',
  ].filter(Boolean);
  const key = strategy === 'replace' ? 'replace' : 'other';
  return t(`dataTransfer.deletedSecrets.${key}`, { list: joinAnd(t, parts) });
}

const SECRETS_SENT_MAX = 10;

/** "api-1 will send db_pw to deploy@10.9.9.9:22 instead of old@host:22", at most 10 + "and N more". */
export function secretsSentLines(t: Translate, list: ImportPlan['secretsSentTo']): string[] {
  const entries = list ?? [];
  const lines = entries.slice(0, SECRETS_SENT_MAX).map((e) =>
    e.from
      ? t('dataTransfer.secretsSent.lineFrom', {
          host: e.host,
          variable: e.variable,
          to: e.to,
          from: e.from,
        })
      : t('dataTransfer.secretsSent.line', { host: e.host, variable: e.variable, to: e.to }),
  );
  if (entries.length > SECRETS_SENT_MAX) {
    lines.push(t('dataTransfer.secretsSent.more', { count: entries.length - SECRETS_SENT_MAX }));
  }
  return lines;
}

export function secretScopeName(t: Translate, entry: NeedsSecret): string {
  return entry.scope.kind === 'project' ? entry.scope.projectName : t('dataTransfer.global');
}

/** "db_pw (Payments) — used by 4 hosts" */
export function needsSecretLine(t: Translate, entry: NeedsSecret): string {
  return t('dataTransfer.needsSecret.line', {
    name: entry.name,
    scope: secretScopeName(t, entry),
    count: entry.hostCount,
  });
}

export function undefinedLine(t: Translate, list: ImportPlan['undefinedVariables']): string {
  const parts = list.map((v) =>
    t('dataTransfer.undefined.part', { name: v.name, count: v.hostCount }),
  );
  return t('dataTransfer.undefined.line', { list: parts.join(', ') });
}

export interface DetailView {
  readonly testId: string;
  readonly icon: string;
  readonly name: string;
  readonly location: string;
  readonly lines: readonly string[];
  readonly badge: { readonly label: string; readonly appearance: string };
}

const BADGE_APPEARANCES: Readonly<Record<PlanItem['action'], string>> = {
  update: 'info',
  copy: 'neutral',
  rename: 'neutral',
  remove: 'negative',
  skip: 'neutral',
};

const ACTION_ORDER: readonly PlanItem['action'][] = ['update', 'copy', 'rename', 'remove', 'skip'];

function isKeyFileSkip(item: PlanItem): boolean {
  return item.reason === 'key_file_missing' || item.reason === 'key_file_mismatch';
}

function gender(kind: ItemKind): string {
  return FEMININE.has(kind) ? 'f' : 'm';
}

function authValue(t: Translate, auth: AuthMethod): string {
  const label = t(`common.auth.${auth.kind}`);
  switch (auth.kind) {
    case 'password':
      return auth.password
        ? t('dataTransfer.detail.authRef', { auth: label, ref: auth.password })
        : label;
    case 'key':
      return auth.passphrase
        ? t('dataTransfer.detail.authKeyPassphrase', {
            auth: label,
            path: auth.keyPath,
            ref: auth.passphrase,
          })
        : t('dataTransfer.detail.authKey', { auth: label, path: auth.keyPath });
    case 'agent':
      return label;
  }
}

/**
 * The scope segment of a location is the backend's English "Home" (hosts, collections) or
 * "Global" (variables); project names stay as they are.
 */
function scopeSegment(t: Translate, kind: ItemKind, segment: string): string {
  if (kind === 'variable') {
    return segment === 'Global' ? t('dataTransfer.detail.global') : segment;
  }
  return segment === 'Home' ? t('common.home') : segment;
}

function locationText(t: Translate, kind: ItemKind, location: readonly string[]): string {
  return location.map((s, i) => (i === 0 ? scopeSegment(t, kind, s) : s)).join(' / ');
}

function changeValue(
  t: Translate,
  kind: ItemKind,
  field: PlanChange['field'],
  value: PlanChange['from'],
): string {
  if (typeof value !== 'string') {
    return authValue(t, value);
  }
  if (field === 'kind' && (value === 'plain' || value === 'secret')) {
    return t(`variables.editor.kinds.${value}`);
  }
  if (field === 'location') {
    return locationText(t, kind, value.split(' / '));
  }
  return value;
}

export function detailLines(t: Translate, item: PlanItem): string[] {
  const lines: string[] = [];
  for (const change of item.changes) {
    const value = (v: PlanChange['from']) => changeValue(t, item.kind, change.field, v);
    lines.push(
      t(`dataTransfer.detail.${change.field}`, { from: value(change.from), to: value(change.to) }),
    );
  }
  if (item.newName && item.newName !== item.name && !item.changes.some((c) => c.field === 'name')) {
    lines.push(t('dataTransfer.detail.name', { from: item.name, to: item.newName }));
  }
  const deleted = t('dataTransfer.detail.deleted', { gender: gender(item.kind) });
  switch (item.reason) {
    case 'same_id':
      lines.push(t('dataTransfer.detail.sameId'));
      break;
    case 'same_name':
    case 'name_taken':
      lines.push(t('dataTransfer.detail.sameName', { kind: item.kind }));
      break;
    case 'kept_secret':
      lines.push(t('dataTransfer.detail.keptSecret'));
      break;
    case 'becomes_secret':
      lines.push(t('dataTransfer.detail.becomesSecret'));
      break;
    case 'variable_exists':
      lines.push(t('dataTransfer.detail.variableExists'));
      break;
    case 'key_file_missing':
      if (item.detail === 'outside_home') {
        lines.push(
          item.path
            ? t('dataTransfer.detail.outsideHomePath', { path: item.path })
            : t('dataTransfer.detail.outsideHome'),
        );
      } else {
        lines.push(
          item.path
            ? t('dataTransfer.detail.keyMissingPath', { path: item.path })
            : t('dataTransfer.detail.keyMissing'),
        );
      }
      break;
    case 'key_file_mismatch':
      lines.push(
        item.detail
          ? t('dataTransfer.detail.keyMismatchAlgorithm', { algorithm: item.detail })
          : t('dataTransfer.detail.keyMismatch'),
      );
      break;
    case 'not_in_file':
      lines.push(deleted);
      break;
    case 'redirects_hosts':
      break;
    case 'id_in_use':
      break;
  }
  if (item.redirects?.length) {
    lines.push(
      t('dataTransfer.detail.redirects', {
        count: item.redirects.length,
        names: listNames(t, item.redirects),
      }),
    );
  }
  if (item.action === 'remove' && item.reason !== 'not_in_file') {
    lines.push(deleted);
  }
  return lines;
}

/** Updates, copies, renames, deletions, skips, then key files not found. */
export function detailViews(t: Translate, items: readonly PlanItem[]): DetailView[] {
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
      location: locationText(t, item.kind, item.location),
      lines: detailLines(t, item),
      badge: {
        label: t(`dataTransfer.badge.${item.action}`, { gender: gender(item.kind) }),
        appearance: BADGE_APPEARANCES[item.action],
      },
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
export function exportCountsText(t: Translate, counts: DataCounts): string {
  const list: [ItemKind, number][] = [
    ['project', counts.projects],
    ['collection', counts.collections],
    ['host', counts.hosts],
    ['variable', counts.variables],
    ['key', counts.keys],
  ];
  const parts = list.filter(([, n]) => n > 0).map(([kind, n]) => countOf(t, kind, n));
  return parts.length ? parts.join(' · ') : t('dataTransfer.export.empty');
}
