import { TestBed } from '@angular/core/testing';
import { TuiDialogService } from '@taiga-ui/core';
import { of } from 'rxjs';
import type { FileEntry } from '../../core/ipc/files';
import { FileDialogs, fileNames } from './file-dialogs';

const entry = (kind: FileEntry['kind']): FileEntry => ({
  name: 'logs',
  path: '/srv/logs',
  kind,
  size: null,
  modified: null,
  permissions: null,
  hidden: false,
});

describe('FileDialogs', () => {
  const open = vi.fn();
  let service: FileDialogs;

  beforeEach(() => {
    open.mockReset();
    TestBed.configureTestingModule({
      providers: [{ provide: TuiDialogService, useValue: { open } }],
    });
    service = TestBed.inject(FileDialogs);
  });

  it('opens the name dialog with file name rules and already_exists as conflict', () => {
    open.mockReturnValue(of(undefined));
    const save = vi.fn();
    service.askName('New folder', 'remote', '', save);
    const options = open.mock.calls[0][1] as {
      label: string;
      data: {
        save: unknown;
        conflictCode: string;
        trim: boolean;
        validator: (c: unknown) => unknown;
      };
    };
    expect(options.label).toBe('New folder');
    expect(options.data).toMatchObject({ save, conflictCode: 'already_exists', trim: false });
    expect(options.data.validator({ value: 'a/b' })).not.toBeNull();
    expect(options.data.validator({ value: 'a\\b' })).toBeNull();
  });

  it('says "everything inside" for directories', async () => {
    open.mockReturnValue(of(true));
    expect(await service.confirmDelete(entry('dir'))).toBe(true);
    const options = open.mock.calls[0][1] as { label: string; data: { content: string } };
    expect(options.label).toBe('Delete folder "logs"?');
    expect(options.data.content).toContain('everything inside');
  });

  it('names up to five entries in the multi confirm, then "and N more"', async () => {
    open.mockReturnValue(of(true));
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) => ({
      ...entry('file'),
      name,
    }));
    expect(await service.confirmDeleteMany(files)).toBe(true);
    const options = open.mock.calls[0][1] as { label: string; data: { content: string } };
    expect(options.label).toBe('Delete 8 items?');
    expect(options.data.content).toBe('a, b, c, d, e and 3 more.');
  });

  it('says folders go with their content in the multi confirm', async () => {
    open.mockReturnValue(of(false));
    expect(await service.confirmDeleteMany([entry('file'), entry('dir')])).toBe(false);
    const options = open.mock.calls[0][1] as { label: string; data: { content: string } };
    expect(options.label).toBe('Delete 2 items?');
    expect(options.data.content).toBe('logs, logs. Folders are deleted with everything inside.');
  });

  it('lists names with "and N more" past the limit', () => {
    expect(fileNames(['a', 'b'], 3)).toBe('a, b');
    expect(fileNames(['a', 'b', 'c', 'd'], 3)).toBe('a, b, c and 1 more');
  });

  it('resolves false when the confirm closes without an answer', async () => {
    open.mockReturnValue(of());
    expect(await service.confirmDelete(entry('file'))).toBe(false);
    const options = open.mock.calls[0][1] as { label: string; data: { content: string } };
    expect(options.label).toBe('Delete file "logs"?');
    expect(options.data.content).not.toContain('everything inside');
  });
});
