import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { Observable, of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { fakeConfig, host, project } from '../../core/ipc/config.fixture';
import { DataTransferIpc } from '../../core/ipc/data-transfer';
import { EditedFiles } from '../../core/ipc/edited-files';
import { IpcError } from '../../core/ipc/ipc-error';
import { KeyStore } from '../../core/ipc/key-store';
import { CurrentScope, type ScopeRoute } from '../../shared/current-scope';
import { Workspace } from '../workspace/workspace';
import { DataTransferActions } from './data-transfer-actions';
import type { ExportDialogData } from './export-dialog/export-dialog';
import type { ImportDialogData } from './import-dialog/import-dialog';
import { plan, preview } from './import.fixture';

describe('DataTransferActions', () => {
  let actions: DataTransferActions;
  let config: ReturnType<typeof fakeConfig>;
  let dialogResult: unknown;
  let respond: ((options: { data: unknown }) => Observable<unknown>) | null;
  let opened: { options: { label: string; data: unknown; closable: Observable<boolean> } }[];
  const ipc = { previewImport: vi.fn(), exportData: vi.fn() };
  const alerts = { open: vi.fn(() => of(undefined)) };
  const keys = { loaded: signal(true), load: vi.fn(() => Promise.resolve()) };
  const scope = {
    hostId: signal<string | null>(null),
    projectId: signal<string | null>(null),
    route: signal<ScopeRoute>({ kind: 'home' }),
  };
  const tabs = signal([
    { id: 't1', hostId: 'h9', label: 'nginx.conf', modified: signal(true) },
    { id: 't2', hostId: 'h1', label: 'Terminal 1', modified: signal(false) },
  ]);
  const workspace = { tabs, drop: vi.fn() };
  const edited = {
    files: signal([{ id: 'e1', hostId: 'h9', name: 'app.yml', notUploaded: true }]),
    remove: vi.fn(),
  };

  beforeAll(async () => {
    await import('./export-dialog/export-dialog');
    await import('./import-dialog/import-dialog');
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    opened = [];
    dialogResult = undefined;
    respond = null;
    config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set([host('h1', 'api', 'p1')]);
    scope.hostId.set(null);
    scope.projectId.set(null);
    scope.route.set({ kind: 'home' });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: DataTransferIpc, useValue: ipc },
        { provide: ConfigService, useValue: config },
        { provide: KeyStore, useValue: keys },
        { provide: TuiNotificationService, useValue: alerts },
        {
          provide: TuiDialogService,
          useValue: {
            open: (_: unknown, options: (typeof opened)[number]['options']) => {
              opened.push({ options });
              return respond ? respond(options) : of(dialogResult);
            },
          },
        },
        { provide: CurrentScope, useValue: scope },
        { provide: Workspace, useValue: workspace },
        { provide: EditedFiles, useValue: edited },
      ],
    });
    actions = TestBed.inject(DataTransferActions);
  });

  it('opens the export dialog with the preset and toasts the saved file', async () => {
    dialogResult = {
      fileName: 'carapace-payments-2026-11-05.json',
      counts: { projects: 1, collections: 2, hosts: 4, variables: 3, secretVariables: 1, keys: 0 },
    };
    await actions.exportData({ kind: 'project', projectId: 'p1' });
    expect(opened[0].options.label).toBe('Export data');
    const data = opened[0].options.data as ExportDialogData;
    expect(data.preset).toEqual({ kind: 'project', projectId: 'p1' });
    expect(alerts.open).toHaveBeenCalledWith('1 project · 2 collections · 4 hosts · 3 variables', {
      label: 'Exported to carapace-payments-2026-11-05.json',
      appearance: 'positive',
    });
  });

  it('cannot close the export dialog while it writes', async () => {
    await actions.exportData();
    const data = opened[0].options.data as ExportDialogData;
    const closable = (): Promise<boolean> =>
      new Promise((r) => opened[0].options.closable.subscribe(r));
    expect(await closable()).toBe(true);
    data.busy.set(true);
    expect(await closable()).toBe(false);
    expect(alerts.open).not.toHaveBeenCalled();
  });

  it('does nothing when the import picker is cancelled', async () => {
    ipc.previewImport.mockResolvedValue(null);
    const run = actions.importData();
    expect(actions.importing()).toBe(true);
    await run;
    expect(actions.importing()).toBe(false);
    expect(opened).toEqual([]);
  });

  it('toasts when another picker is open', async () => {
    ipc.previewImport.mockRejectedValue(new IpcError('busy', 'picker open'));
    await actions.importData();
    expect(alerts.open).toHaveBeenCalledWith('Another file dialog is open. Close it first.', {
      appearance: 'warning',
    });
    expect(opened).toEqual([]);
  });

  it('opens the import dialog on the preview or on the file error', async () => {
    ipc.previewImport.mockResolvedValueOnce(preview());
    await actions.importData();
    expect(opened[0].options.label).toBe('Import data');
    expect((opened[0].options.data as ImportDialogData).start).toEqual({
      kind: 'preview',
      preview: preview(),
    });
    const error = new IpcError('import_format', 'bad');
    ipc.previewImport.mockRejectedValueOnce(error);
    await actions.importData();
    expect((opened[1].options.data as ImportDialogData).start).toEqual({ kind: 'error', error });
  });

  it('lists the tabs and edited files a plan removes', async () => {
    ipc.previewImport.mockResolvedValue(preview());
    await actions.importData();
    const data = opened[0].options.data as ImportDialogData;
    expect(data.workspaceLines(plan({ removedHostIds: ['h9'] }))).toBe(
      ' 1 open tab will be closed. Unsaved changes in nginx.conf will be lost. 1 file open in an external editor will stop syncing. Changes not uploaded in app.yml will be lost.',
    );
    expect(data.workspaceLines(plan())).toBe('');
  });

  it('reloads the data and the keys after a change', async () => {
    const load = vi.spyOn(config, 'load');
    ipc.previewImport.mockResolvedValue(preview());
    await actions.importData();
    await (opened[0].options.data as ImportDialogData).changed(null);
    expect(load).toHaveBeenCalled();
    expect(keys.load).toHaveBeenCalled();
  });

  it('notifies a failed reload', async () => {
    vi.spyOn(config, 'load').mockRejectedValue(new IpcError('io', 'read failed'));
    ipc.previewImport.mockResolvedValue(preview());
    await actions.importData();
    await (opened[0].options.data as ImportDialogData).changed(null);
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Read failed.'),
      expect.objectContaining({ label: 'Data not reloaded' }),
    );
  });

  it('leaves the page and tabs of removed hosts after the dialog', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    scope.hostId.set('h9');
    scope.projectId.set('p1');
    ipc.previewImport.mockResolvedValue(preview());
    respond = (options) =>
      new Observable((subscriber) => {
        void (options.data as ImportDialogData)
          .changed(plan({ removedHostIds: ['h9'] }))
          .then(() => subscriber.complete());
      });
    await actions.importData();
    expect(navigate).toHaveBeenCalledWith(['/projects', 'p1']);
    expect(edited.remove).toHaveBeenCalledWith(['e1']);
    expect(workspace.drop).toHaveBeenCalledWith(['t1']);
  });

  it('goes Home when the open project is gone, then opens the chosen variables page', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    scope.route.set({ kind: 'project', projectId: 'gone', variables: false });
    dialogResult = ['/variables'];
    ipc.previewImport.mockResolvedValue(preview());
    await actions.importData();
    expect(navigate.mock.calls).toEqual([[['/']], [['/variables']]]);
    expect(workspace.drop).not.toHaveBeenCalled();
  });
});
