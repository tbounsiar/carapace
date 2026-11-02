import type { FileEntry } from '../../core/ipc/files';
import { formatModified, formatSize, isOpenable, sortEntries, visibleEntries } from './file-list';

function entry(name: string, patch: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/d/${name}`,
    kind: 'file',
    size: 0,
    modified: 0,
    permissions: null,
    hidden: name.startsWith('.'),
    ...patch,
  };
}

const names = (list: FileEntry[]): string[] => list.map((e) => e.name);

describe('sortEntries', () => {
  const list = [
    entry('b.txt', { size: 10, modified: 300 }),
    entry('src', { kind: 'dir', size: null, modified: 100 }),
    entry('A.txt', { size: 30, modified: 100 }),
    entry('lib', { kind: 'dir', size: null, modified: 200 }),
    entry('c.txt', { size: 10, modified: 200 }),
  ];

  it('puts directories first and sorts by name, case-insensitively', () => {
    expect(names(sortEntries(list, 'name', 1))).toEqual(['lib', 'src', 'A.txt', 'b.txt', 'c.txt']);
  });

  it('keeps directories first when descending', () => {
    expect(names(sortEntries(list, 'name', -1))).toEqual(['src', 'lib', 'c.txt', 'b.txt', 'A.txt']);
  });

  it('sorts by size with ties by name', () => {
    expect(names(sortEntries(list, 'size', 1))).toEqual(['lib', 'src', 'b.txt', 'c.txt', 'A.txt']);
    expect(names(sortEntries(list, 'size', -1))).toEqual(['lib', 'src', 'A.txt', 'b.txt', 'c.txt']);
  });

  it('sorts by modified date', () => {
    expect(names(sortEntries(list, 'modified', 1))).toEqual([
      'src',
      'lib',
      'A.txt',
      'c.txt',
      'b.txt',
    ]);
  });

  it('orders numbers naturally', () => {
    const files = [entry('file10'), entry('file2'), entry('file1')];
    expect(names(sortEntries(files, 'name', 1))).toEqual(['file1', 'file2', 'file10']);
  });

  it('puts unknown sizes first when ascending', () => {
    const files = [entry('a', { size: 5 }), entry('b', { size: null })];
    expect(names(sortEntries(files, 'size', 1))).toEqual(['b', 'a']);
  });

  it('is stable for entries that compare equal', () => {
    const files = [
      entry('x', { path: '/1' }),
      entry('X', { path: '/2' }),
      entry('x', { path: '/3' }),
    ];
    expect(sortEntries(files, 'name', 1).map((e) => e.path)).toEqual(['/1', '/2', '/3']);
    expect(sortEntries(files, 'size', -1).map((e) => e.path)).toEqual(['/1', '/2', '/3']);
  });

  it('does not mutate the input', () => {
    const copy = [...list];
    sortEntries(list, 'name', -1);
    expect(list).toEqual(copy);
  });
});

describe('visibleEntries', () => {
  it('hides hidden entries unless asked', () => {
    const list = [entry('.ssh', { kind: 'dir' }), entry('notes')];
    expect(names(visibleEntries(list, false))).toEqual(['notes']);
    expect(names(visibleEntries(list, true))).toEqual(['.ssh', 'notes']);
  });
});

describe('formatSize', () => {
  it('formats bytes with binary units', () => {
    expect(formatSize(null)).toBe('');
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KiB');
    expect(formatSize(1536)).toBe('1.5 KiB');
    expect(formatSize(10 * 1024)).toBe('10 KiB');
    expect(formatSize(5 * 1024 ** 2)).toBe('5.0 MiB');
    expect(formatSize(300 * 1024 ** 3)).toBe('300 GiB');
    expect(formatSize(2 * 1024 ** 4)).toBe('2.0 TiB');
  });
});

describe('formatModified', () => {
  it('formats unix seconds as a short date and time', () => {
    const seconds = Date.UTC(2026, 0, 15, 9, 30) / 1000;
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(seconds * 1000));
    expect(formatModified(seconds)).toBe(expected);
    expect(formatModified(null)).toBe('');
  });
});

describe('isOpenable', () => {
  it('opens directories and symlinks only', () => {
    expect(isOpenable(entry('d', { kind: 'dir' }))).toBe(true);
    expect(isOpenable(entry('l', { kind: 'symlink' }))).toBe(true);
    expect(isOpenable(entry('f'))).toBe(false);
    expect(isOpenable(entry('o', { kind: 'other' }))).toBe(false);
  });
});
