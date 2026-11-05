import type { FileEntry, FileKind } from '../../core/ipc/files';

export type SortKey = 'name' | 'size' | 'modified';
export type SortDirection = 1 | -1;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareNullable(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

function compareBy(key: SortKey, a: FileEntry, b: FileEntry): number {
  switch (key) {
    case 'name':
      return collator.compare(a.name, b.name);
    case 'size':
      return compareNullable(a.size, b.size);
    case 'modified':
      return compareNullable(a.modified, b.modified);
  }
}

/** Directories always come first, whatever the direction; ties fall back to the name, ascending. */
export function compareEntries(
  a: FileEntry,
  b: FileEntry,
  key: SortKey,
  direction: SortDirection,
): number {
  const dirs = Number(b.kind === 'dir') - Number(a.kind === 'dir');
  if (dirs !== 0) return dirs;
  const primary = direction * compareBy(key, a, b);
  return primary !== 0 || key === 'name' ? primary : collator.compare(a.name, b.name);
}

/** Stable: entries that compare equal keep their listing order. */
export function sortEntries(
  entries: readonly FileEntry[],
  key: SortKey,
  direction: SortDirection,
): FileEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, key, direction));
}

export function visibleEntries(entries: readonly FileEntry[], showHidden: boolean): FileEntry[] {
  return showHidden ? [...entries] : entries.filter((e) => !e.hidden);
}

const UNITS = {
  en: ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'],
  fr: ['o', 'Ko', 'Mo', 'Go', 'To', 'Po', 'Eo'],
} as const;

/** Binary multiples in both languages; French uses the units French systems show (Ko, Mo...). */
export function formatSize(bytes: number | null, locale = 'en-US'): string {
  if (bytes === null) return '';
  const french = locale.startsWith('fr');
  const units = french ? UNITS.fr : UNITS.en;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(value);
  return `${number}${french ? ' ' : ' '}${units[unit]}`;
}

export function formatModified(seconds: number | null, locale = 'en-US'): string {
  return seconds === null
    ? ''
    : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(seconds * 1000),
      );
}

export const KIND_ICONS: Record<FileKind, string> = {
  dir: '@tui.folder',
  file: '@tui.file',
  symlink: '@tui.link',
  other: '@tui.file-question-mark',
};

/** Symlink targets are not resolved yet; opening one just tries to list it. */
export function isOpenable(entry: FileEntry): boolean {
  return entry.kind === 'dir' || entry.kind === 'symlink';
}
