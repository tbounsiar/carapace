import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { DataTransferIpc } from './data-transfer';
import { IpcError } from './ipc-error';

describe('DataTransferIpc', () => {
  let ipc: DataTransferIpc;
  let calls: { cmd: string; args: Record<string, unknown> }[];
  let onCall: (cmd: string, args: Record<string, unknown>) => unknown;

  beforeEach(() => {
    calls = [];
    onCall = () => null;
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      return onCall(cmd, a);
    });
    ipc = TestBed.inject(DataTransferIpc);
  });

  afterEach(() => clearMocks());

  it('exports a scope and returns the result, or null when the dialog was cancelled', async () => {
    const result = {
      fileName: 'carapace-all-2026-11-05.json',
      counts: { projects: 1, collections: 0, hosts: 2, variables: 3, secretVariables: 1, keys: 0 },
    };
    onCall = () => result;
    expect(await ipc.exportData({ kind: 'project', projectId: 'p1' }, true)).toEqual(result);
    onCall = () => null;
    expect(await ipc.exportData({ kind: 'all' }, false)).toBeNull();
    expect(calls).toEqual([
      {
        cmd: 'export_data',
        args: { scope: { kind: 'project', projectId: 'p1' }, includeShared: true },
      },
      { cmd: 'export_data', args: { scope: { kind: 'all' }, includeShared: false } },
    ]);
  });

  it('previews, refreshes, applies, undoes and cancels by import id', async () => {
    await ipc.previewImport();
    await ipc.refreshImport('i1');
    await ipc.applyImport('i1', 'duplicate');
    await ipc.undoImport('i1');
    await ipc.cancelImport('i1');
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['preview_import', {}],
      ['refresh_import', { importId: 'i1' }],
      ['apply_import', { importId: 'i1', strategy: 'duplicate' }],
      ['undo_import', { importId: 'i1' }],
      ['cancel_import', { importId: 'i1' }],
    ]);
  });

  it.each([
    'import_format',
    'import_version',
    'import_malformed',
    'import_invalid',
    'import_secret_value',
  ])('maps the %s error code', async (code) => {
    onCall = () => {
      throw { code, message: 'bad file' };
    };
    const err = await ipc.previewImport().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).code).toBe(code);
  });
});
