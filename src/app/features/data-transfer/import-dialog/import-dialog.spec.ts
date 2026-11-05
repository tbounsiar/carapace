import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { DataTransferIpc, type ImportPreview } from '../../../core/ipc/data-transfer';
import { IpcError } from '../../../core/ipc/ipc-error';
import { plan, preview, result, row } from '../import.fixture';
import { ImportDialog, type ImportDialogData, type ImportStart } from './import-dialog';

describe('ImportDialog', () => {
  let fixture: ComponentFixture<ImportDialog>;
  let busy: ReturnType<typeof signal<boolean>>;
  const completeWith = vi.fn();
  const complete = vi.fn();
  const ipc = {
    applyImport: vi.fn(),
    refreshImport: vi.fn(),
    undoImport: vi.fn(),
    cancelImport: vi.fn(() => Promise.resolve()),
  };
  const pick = vi.fn<() => Promise<ImportPreview | null>>();
  const changed = vi.fn(() => Promise.resolve());
  const workspaceLines = vi.fn(() => '');
  const confirm = vi.fn(() => of(true));
  const alerts = { open: vi.fn(() => of(undefined)) };

  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${id}"]`);
  const text = (id: string) => byId(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const choose = async (strategy: string) => {
    byId(`import-strategy-${strategy}`)!.querySelector('input')!.click();
    await settle();
  };
  const submit = async () => {
    byId('import-submit')!.click();
    await settle();
  };

  beforeAll(() => import('../../../shared/destructive-confirm/destructive-confirm'));

  async function setup(start: ImportStart = { kind: 'preview', preview: preview() }) {
    busy = signal(false);
    const data: ImportDialogData = { start, busy, pick, workspaceLines, changed };
    await TestBed.configureTestingModule({
      imports: [ImportDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data, completeWith, $implicit: { complete } },
        },
        { provide: DataTransferIpc, useValue: ipc },
        { provide: TuiDialogService, useValue: { open: confirm } },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ImportDialog);
    await settle();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    confirm.mockImplementation(() => of(true));
    workspaceLines.mockReturnValue('');
  });

  describe('preview', () => {
    it('shows the file, Merge selected, the table, details and secrets to set', async () => {
      await setup();
      expect(text('import-file')).toBe('carapace-payments-2026-11-05.json');
      expect(text('import-file-meta')).toContain('Project “Payments”');
      expect(text('import-file-meta')).toContain('Carapace 0.2.0');
      const merge = byId('import-strategy-merge')!.querySelector('input')!;
      expect(merge.checked).toBe(true);
      expect(text('import-strategy-replace')).toContain('Make Payments exactly like the file');
      expect(text('import-table')).toContain('What changes');
      expect(text('import-row-host')).toBe('Hosts 4 9 7');
      expect(text('import-row-collection')).toBe('Collections 2 — —');
      expect(byId('import-row-project')).toBeNull();
      expect(text('import-details')).toContain('Details (1)');
      expect(text('import-item-host-api-1')).toContain(
        'Address: deploy@10.0.1.5:22 → deploy@10.0.9.5:22',
      );
      expect(text('import-item-host-api-1')).toContain('Updated');
      expect(text('import-needs-secret')).toContain('root_pw (global) — used by 1 host');
      expect(text('import-backup-note')).toBe('A backup of your current data is saved first.');
      expect(byId('import-warning-connections')).toBeNull();
      expect(byId('import-warning-secrets')).toBeNull();
      expect(text('import-submit')).toBe('Import');
    });

    it('switches the table and warnings to Replace at once', async () => {
      workspaceLines.mockReturnValue(' 1 open tab will be closed.');
      await setup();
      await choose('replace');
      expect(text('import-row-host')).toBe('Hosts 4 9 3');
      expect(byId('import-row-host')!.querySelector('.negative')!.textContent!.trim()).toBe('3');
      expect(text('import-warning-connections')).toContain('1 connected host is affected');
      expect(text('import-warning-connections')).toContain(
        'old-1 is deleted or moved to another project. It is disconnected.',
      );
      expect(text('import-warning-connections')).toContain('1 open tab will be closed.');
      expect(text('import-warning-secrets')).toBe(
        'Replace deletes 2 secret variable values and the saved passwords of 3 hosts from this computer.',
      );
      expect(text('import-item-host-old-1')).toContain('Deleted');
      expect(text('import-submit')).toBe('Replace…');
      expect(byId('import-needs-secret')).toBeNull();
    });

    it('shows copies for Keep both', async () => {
      await setup();
      await choose('duplicate');
      expect(text('import-row-host')).toBe('Hosts 4 9');
      expect(text('import-table')).toContain('Copied');
      expect(text('import-item-host-api-1')).toContain('Renamed: api-1 → api-1 (imported)');
      expect(text('import-item-host-api-1')).toContain('Copied');
    });

    it('blocks a strategy whose plan breaks a limit', async () => {
      const p = preview();
      await setup({
        kind: 'preview',
        preview: {
          ...p,
          plans: {
            ...p.plans,
            replace: {
              ...p.plans.replace,
              blocking: ['Payments would have 214 variables (max 200)'],
            },
          },
        },
      });
      await choose('replace');
      expect(text('import-blocking')).toBe(
        'This import cannot be done with Replace: Payments would have 214 variables (max 200).',
      );
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(true);
      await choose('merge');
      expect(byId('import-blocking')).toBeNull();
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(false);
    });

    it('says when there is nothing to import', async () => {
      const same = plan({ rows: [row('host', { unchanged: 5 })] });
      await setup({
        kind: 'preview',
        preview: preview({ plans: { merge: same, replace: same, duplicate: same } }),
      });
      expect(byId('import-nothing')).not.toBeNull();
      expect(byId('import-table')).toBeNull();
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(true);
    });

    it('lists variables defined nowhere', async () => {
      const p = preview();
      await setup({
        kind: 'preview',
        preview: {
          ...p,
          plans: {
            ...p.plans,
            merge: plan({
              rows: [row('host', { added: 1 })],
              undefinedVariables: [{ name: 'db_port', hostCount: 2 }],
            }),
          },
        },
      });
      expect(text('import-needs-secret')).toContain(
        'Not defined anywhere: db_port (used by 2 hosts).',
      );
    });

    it('closes with Cancel and drops the pending import when destroyed', async () => {
      await setup();
      byId('dialog-cancel')!.click();
      expect(complete).toHaveBeenCalled();
      fixture.destroy();
      expect(ipc.cancelImport).toHaveBeenCalledWith('i1');
    });
  });

  describe('secrets sent to new servers', () => {
    const targets = [
      {
        host: 'api-1',
        location: ['Payments'],
        variable: 'db_pw',
        from: 'deploy@10.0.1.5:22',
        to: 'deploy@10.9.9.9:22',
      },
      { host: 'web', location: ['Payments'], variable: 'db_pw', from: null, to: 'deploy@web:22' },
    ];
    const withTargets = () => {
      const p = preview();
      return preview({
        plans: {
          ...p.plans,
          merge: { ...p.plans.merge, secretsSentTo: targets },
          duplicate: { ...p.plans.duplicate, secretsSentTo: targets },
        },
      });
    };
    const ack = () => byId<HTMLInputElement>('import-secrets-ack')!;

    it('needs the user to trust the servers before importing', async () => {
      ipc.applyImport.mockResolvedValue(result());
      await setup({ kind: 'preview', preview: withTargets() });
      expect(text('import-secrets-warning')).toContain('Saved secrets will go to new servers');
      expect(text('import-secrets-warning')).toContain(
        'api-1 will send db_pw to deploy@10.9.9.9:22 instead of deploy@10.0.1.5:22',
      );
      expect(text('import-secrets-warning')).toContain('web will send db_pw to deploy@web:22');
      expect(ack().checked).toBe(false);
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(true);
      ack().click();
      await settle();
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(false);
      await submit();
      expect(ipc.applyImport).toHaveBeenCalledWith('i1', 'merge');
    });

    it('puts the trust checkbox in the last warning and describes Import with it', async () => {
      await setup({ kind: 'preview', preview: withTargets() });
      const warning = byId('import-secrets-warning')!;
      expect(warning.contains(ack())).toBe(true);
      const notes = [
        ...document.querySelectorAll('[data-testid="import-dialog"] [tuinotification]'),
      ];
      expect(notes.at(-1)).toBe(warning);
      expect(warning.nextElementSibling?.getAttribute('data-testid')).toBe('import-backup-note');
      const describedBy = byId('import-submit')!.getAttribute('aria-describedby')!;
      expect(document.getElementById(describedBy)?.textContent).toBe(
        'Saved secrets will go to new servers',
      );
    });

    it('describes Import with nothing when no secret goes to a new server', async () => {
      await setup();
      expect(byId('import-submit')!.hasAttribute('aria-describedby')).toBe(false);
    });

    it('unchecks the trust on a strategy switch', async () => {
      await setup({ kind: 'preview', preview: withTargets() });
      ack().click();
      await settle();
      await choose('duplicate');
      expect(ack().checked).toBe(false);
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(true);
      await choose('replace');
      expect(byId('import-secrets-warning')).toBeNull();
      expect(byId('import-secrets-ack')).toBeNull();
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(false);
    });

    it('unchecks the trust when a stale preview is refreshed', async () => {
      ipc.applyImport.mockRejectedValue(new IpcError('conflict', 'data changed'));
      ipc.refreshImport.mockResolvedValue(withTargets());
      await setup({ kind: 'preview', preview: withTargets() });
      ack().click();
      await settle();
      await submit();
      expect(byId('import-refreshed')).not.toBeNull();
      expect(ack().checked).toBe(false);
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(true);
    });

    it('reads a missing list as empty', async () => {
      await setup();
      expect(byId('import-secrets-warning')).toBeNull();
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(false);
    });
  });

  describe('apply', () => {
    it('imports with Merge, reloads and shows the summary', async () => {
      ipc.applyImport.mockResolvedValue(
        result({
          renamed: [{ kind: 'host', from: 'api-1', to: 'api-1 (imported)' }],
          disconnected: ['api-1', 'db-2'],
          needsSecret: [
            {
              scope: { kind: 'project', projectId: 'p1', projectName: 'Payments' },
              name: 'db_pw',
              hostCount: 4,
            },
            { scope: { kind: 'global' }, name: 'root_pw', hostCount: 1 },
          ],
        }),
      );
      await setup();
      await submit();
      expect(confirm).not.toHaveBeenCalled();
      expect(ipc.applyImport).toHaveBeenCalledWith('i1', 'merge');
      expect(changed).toHaveBeenCalledWith(preview().plans.merge);
      expect(text('import-summary')).toBe('Import complete');
      expect(document.activeElement).toBe(byId('import-summary'));
      expect(fixture.nativeElement.textContent).toContain(
        '4 hosts and 2 collections added, 9 hosts updated.',
      );
      expect(text('import-disconnected')).toContain('api-1, db-2');
      expect(text('import-needs-secret')).toContain('db_pw (Payments) — 4 hosts');
      expect(text('import-item-host-api-1')).toContain('Renamed');
      expect(text('import-backup-name')).toBe('data-20261105-101200-before-import.json');
      expect(byId('import-undo')).not.toBeNull();

      byId('import-open-variables-Payments')!.click();
      expect(completeWith).toHaveBeenCalledWith(['/projects', 'p1', 'variables']);
      byId('import-open-variables-global')!.click();
      expect(completeWith).toHaveBeenCalledWith(['/variables']);
    });

    it('asks before a Replace that deletes, and does nothing on Cancel', async () => {
      confirm.mockImplementation(() => of(false));
      workspaceLines.mockReturnValue(' 1 open tab will be closed.');
      await setup();
      await choose('replace');
      await submit();
      expect(confirm).toHaveBeenCalledTimes(1);
      const [, options] = confirm.mock.calls[0] as unknown as [
        unknown,
        { label: string; data: { content: string; yes: string } },
      ];
      expect(options.label).toBe('Replace data?');
      expect(options.data.yes).toBe('Replace');
      expect(options.data.content).toBe(
        '3 hosts will be deleted from this computer, with their saved passwords. 1 open connection is closed. A backup of your data is kept. 1 open tab will be closed.',
      );
      expect(ipc.applyImport).not.toHaveBeenCalled();
      expect(byId('import-submit')).not.toBeNull();
    });

    it('applies Replace once confirmed', async () => {
      ipc.applyImport.mockResolvedValue(result());
      await setup();
      await choose('replace');
      await submit();
      expect(ipc.applyImport).toHaveBeenCalledWith('i1', 'replace');
      expect(byId('import-summary')).not.toBeNull();
    });

    it('cannot be cancelled while applying', async () => {
      let finish: (value: unknown) => void = () => undefined;
      ipc.applyImport.mockReturnValue(new Promise((r) => (finish = r)));
      await setup();
      await submit();
      expect(busy()).toBe(true);
      expect(byId<HTMLButtonElement>('dialog-cancel')!.disabled).toBe(true);
      finish(result());
      await settle();
      expect(busy()).toBe(false);
    });

    it('refreshes a stale preview and keeps the strategy', async () => {
      ipc.applyImport.mockRejectedValue(new IpcError('conflict', 'data changed'));
      const fresh = preview({ importId: 'i1' });
      ipc.refreshImport.mockResolvedValue(fresh);
      await setup();
      await choose('duplicate');
      await submit();
      expect(ipc.refreshImport).toHaveBeenCalledWith('i1');
      expect(text('import-refreshed')).toBe(
        'Your data changed since this preview. The preview was updated.',
      );
      expect(byId('import-strategy-duplicate')!.querySelector('input')!.checked).toBe(true);
      expect(changed).not.toHaveBeenCalled();
    });

    it('says when the preview expired', async () => {
      ipc.applyImport.mockRejectedValue(new IpcError('not_found', 'unknown import'));
      await setup();
      await submit();
      expect(text('import-apply-error')).toBe('This preview expired. Choose the file again.');
    });

    it('keeps the preview after an apply error', async () => {
      ipc.applyImport.mockRejectedValue(new IpcError('io', 'backup failed'));
      await setup();
      await submit();
      expect(text('import-apply-error')).toContain('Nothing was imported. Backup failed.');
      expect(byId<HTMLButtonElement>('import-submit')!.disabled).toBe(false);
    });

    it('keeps the backend count of a partial keychain failure', async () => {
      ipc.applyImport.mockRejectedValue(
        new IpcError(
          'keychain_unavailable',
          'Nothing was imported, but 2 secret values were already removed from the keychain.',
        ),
      );
      await setup();
      await submit();
      expect(text('import-apply-error')).toBe(
        'Nothing was imported, but 2 secret values were already removed from the keychain. Unlock or enable the system keychain, then try again.',
      );
    });

    it('explains an unavailable keychain', async () => {
      ipc.applyImport.mockRejectedValue(new IpcError('keychain_unavailable', 'locked'));
      await setup();
      await submit();
      expect(text('import-apply-error')).toBe(
        'The system keychain is not available. Nothing was imported.',
      );
    });
  });

  describe('undo', () => {
    async function applied(): Promise<void> {
      ipc.applyImport.mockResolvedValue(result({ secretValuesDeleted: 1 }));
      await setup();
      await submit();
      changed.mockClear();
    }

    it('restores the data and shows Import undone', async () => {
      ipc.undoImport.mockResolvedValue(undefined);
      await applied();
      byId('import-undo')!.click();
      await settle();
      expect(ipc.undoImport).toHaveBeenCalledWith('i1');
      expect(changed).toHaveBeenCalledWith(null);
      expect(text('import-undone')).toBe('Import undone');
      expect(byId('import-undo')).toBeNull();
      expect(byId('import-done')).not.toBeNull();
    });

    it('names the backup when the undo fails', async () => {
      ipc.undoImport.mockRejectedValue(new IpcError('conflict', 'data changed'));
      await applied();
      byId('import-undo')!.click();
      await settle();
      expect(fixture.nativeElement.textContent).toContain(
        'Could not undo the import. Your data before the import is in data-20261105-101200-before-import.json in the Carapace folder.',
      );
      expect(byId('import-done')).not.toBeNull();
    });

    it('closes with Done', async () => {
      await applied();
      byId('import-done')!.click();
      expect(complete).toHaveBeenCalled();
    });
  });

  describe('invalid file', () => {
    it.each([
      [
        'import_format',
        'the file is not a Carapace data file.',
        'This is not a Carapace data file',
        ['Choose a file made with Export in Carapace.'],
      ],
      [
        'import_version',
        'The file uses data format version 3; this version of Carapace reads format version 1.',
        'This file needs a newer Carapace',
        ['It was exported in data format 3. Update Carapace, then import it again.'],
      ],
      [
        'import_malformed',
        'The file is not valid JSON (line 4, column 12).',
        'This file is damaged',
        ['It is not valid JSON (line 4, column 12). Export it again.'],
      ],
      [
        'import_malformed',
        'The file is not UTF-8 text.',
        'This file is damaged',
        ['It is not UTF-8 text. Export it again.'],
      ],
      [
        'import_invalid',
        'host “api-1”: port must be between 1 and 65535.\ncollection “Backend” is its own parent.',
        'This file has invalid data',
        [
          'Host “api-1”: port must be between 1 and 65535.',
          'Collection “Backend” is its own parent.',
        ],
      ],
      [
        'import_secret_value',
        'secret variable “db_pw” has a value. Carapace never imports secret values.',
        'This file contains a secret value',
        [
          'Secret variable “db_pw” has a value. Carapace never imports secret values.',
          'Remove it from the file and set it in Variables instead.',
        ],
      ],
      [
        'too_large',
        'the file is larger than 8 MiB.',
        'This file is too large',
        ['Carapace data files are at most 8 MB.'],
      ],
      [
        'permission_denied',
        'cannot open the file',
        'The file could not be read',
        ['Cannot open the file. Check the permissions of the file or folder.'],
      ],
      [
        'invalid_input',
        'the file is on a network drive.',
        'The file could not be read',
        ['The file is on a network drive. Choose a file on a drive of this computer.'],
      ],
      [
        'not_found',
        'file not found',
        'The file could not be read',
        ['File not found. It may have been deleted or moved. Refresh and try again.'],
      ],
      [
        'io',
        'read failed',
        'The file could not be read',
        ['Read failed. Check that the disk is available and not full, then try again.'],
      ],
    ])('shows %s: %s', async (code, message, title, lines) => {
      await setup({
        kind: 'error',
        error: new IpcError(code as never, `file “notes.json”: ${message}`),
      });
      expect(text('import-file')).toBe('notes.json');
      expect(text('import-error')).toContain(title);
      const shown = [...byId('import-error')!.querySelectorAll('.line')].map((l) =>
        l.textContent!.trim(),
      );
      expect(shown).toEqual(lines);
      expect(text('import-error')).not.toContain('file “notes.json”');
      expect(byId('import-submit')).toBeNull();
    });

    it('shows no file name when the backend gives none', async () => {
      await setup({ kind: 'error', error: new IpcError('io', 'read failed') });
      expect(byId('import-file')).toBeNull();
    });

    it('chooses another file and shows its preview', async () => {
      pick.mockResolvedValueOnce(null).mockResolvedValueOnce(preview({ importId: 'i2' }));
      await setup({ kind: 'error', error: new IpcError('import_format', 'bad') });
      byId('import-choose-another')!.click();
      await settle();
      expect(byId('import-error')).not.toBeNull();
      byId('import-choose-another')!.click();
      await settle();
      expect(byId('import-error')).toBeNull();
      expect(text('import-file')).toBe('carapace-payments-2026-11-05.json');
      fixture.destroy();
      expect(ipc.cancelImport).toHaveBeenCalledWith('i2');
    });

    it('shows the next file error, and toasts a busy picker', async () => {
      pick
        .mockRejectedValueOnce(new IpcError('too_large', 'big'))
        .mockRejectedValueOnce(new IpcError('busy', 'picker open'));
      await setup({ kind: 'error', error: new IpcError('import_format', 'bad') });
      byId('import-choose-another')!.click();
      await settle();
      expect(text('import-error')).toContain('This file is too large');
      byId('import-choose-another')!.click();
      await settle();
      expect(alerts.open).toHaveBeenCalledWith(
        'Another file dialog is open. Close it first.',
        expect.anything(),
      );
      expect(text('import-error')).toContain('This file is too large');
    });
  });
});
