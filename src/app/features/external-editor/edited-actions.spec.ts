import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { fakeConfig, host } from '../../core/ipc/config.fixture';
import { EditedFiles } from '../../core/ipc/edited-files';
import { ExternalEditsIpc } from '../../core/ipc/external-edits';
import { editedFile } from '../../core/ipc/external-edits.fixture';
import { IpcError } from '../../core/ipc/ipc-error';
import { SshService } from '../../core/ipc/ssh';
import { HostConnector } from '../host-connection/host-connector';
import { HostLauncher } from '../host-connection/host-launcher';
import { builtInBlocker, EditedActions } from './edited-actions';

@Component({ template: '' })
class Blank {}

describe('EditedActions', () => {
  let answers: unknown[];
  let state: string;
  const conflict = editedFile('e1', 'h1', '/etc/nginx.conf', {
    state: 'conflict',
    conflict: 'changed',
    notUploaded: true,
    needsAttention: true,
  });
  const synced = editedFile('e2', 'h1', '/srv/app.env');
  const ipc = {
    uploadNow: vi.fn(() => Promise.resolve(synced)),
    resolveConflict: vi.fn(() => Promise.resolve({ ...conflict, state: 'synced' })),
    stop: vi.fn(() => Promise.resolve()),
    stopAll: vi.fn(() => Promise.resolve(2)),
    list: vi.fn(() => Promise.resolve([])),
    discardRecovered: vi.fn(() => Promise.resolve()),
    reveal: vi.fn(() => Promise.resolve()),
  };
  const dialogs = { open: vi.fn(() => of(answers.shift())) };
  const alerts = { open: vi.fn(() => of(undefined)) };
  const connector = { connect: vi.fn(() => Promise.resolve()) };
  const launcher = {
    openFile: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve(true)),
  };

  beforeAll(async () => {
    await import('../../shared/destructive-confirm/destructive-confirm');
    await import('../editor/editor-choice-dialog/editor-choice-dialog');
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    answers = [];
    state = 'connected';
    const config = fakeConfig();
    config.nodes.set([host('h1', 'vps')]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ExternalEditsIpc, useValue: ipc },
        { provide: ConfigService, useValue: config },
        { provide: SshService, useValue: { stateOf: () => state } },
        { provide: HostConnector, useValue: connector },
        { provide: HostLauncher, useValue: launcher },
        { provide: TuiDialogService, useValue: dialogs },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    });
    TestBed.inject(EditedFiles).reset([conflict, synced]);
  });

  const actions = () => TestBed.inject(EditedActions);
  const store = () => TestBed.inject(EditedFiles);
  const dialog = (i = 0) =>
    dialogs.open.mock.calls[i] as unknown as [
      unknown,
      { label: string; data: { kind?: string; content?: string; yes?: string } },
    ];

  it('resolves a conflict with the external variant of the dialog', async () => {
    answers = ['overwrite'];
    await actions().resolve(conflict);
    expect(dialog()[1]).toMatchObject({
      label: 'File changed on the server',
      data: { kind: 'externalChanged', name: 'nginx.conf', host: 'vps' },
    });
    expect(ipc.resolveConflict).toHaveBeenCalledWith('e1', 'overwrite');
    expect(store().find('e1')?.state).toBe('synced');
    answers = ['useServer'];
    await actions().resolve(conflict);
    expect(ipc.resolveConflict).toHaveBeenLastCalledWith('e1', 'useServer');
  });

  it('confirms a large download before using the server version', async () => {
    ipc.resolveConflict.mockRejectedValueOnce(new IpcError('large_file', 'x is 31457280 bytes'));
    answers = ['useServer', true];
    await actions().resolve({ ...conflict, size: 31457280 });
    expect(dialog(1)[1].label).toBe('Download 30 MiB?');
    expect(ipc.resolveConflict).toHaveBeenLastCalledWith('e1', 'useServer', true);
  });

  it('reports a server version the system would run as a blocked type', async () => {
    ipc.resolveConflict.mockRejectedValueOnce(new IpcError('blocked_type', 'x'));
    answers = ['useServer'];
    await actions().resolve(conflict);
    expect(alerts.open).toHaveBeenCalledWith(
      'nginx.conf would be run, not opened, by your system. Choose an editor app in Settings to edit .conf files.',
      expect.objectContaining({ label: 'nginx.conf not updated', appearance: 'negative' }),
    );
  });

  it('keeps the file held on Keep my copy, and offers Stop editing when it was deleted', async () => {
    answers = ['cancel'];
    await actions().resolve(conflict);
    expect(ipc.resolveConflict).not.toHaveBeenCalled();
    const deleted = { ...conflict, conflict: 'deleted' as const };
    answers = ['stop', true];
    await actions().resolve(deleted);
    expect(dialog(1)[1].data.kind).toBe('externalDeleted');
    expect(dialog(2)[1].label).toBe('Stop editing nginx.conf?');
    expect(ipc.stop).toHaveBeenCalledWith('e1', true);
    expect(store().find('e1')).toBeNull();
  });

  it('uploads now and reopens the dialog when the server is still different', async () => {
    ipc.uploadNow.mockResolvedValueOnce(conflict);
    answers = ['cancel'];
    await actions().upload(conflict);
    expect(ipc.uploadNow).toHaveBeenCalledWith('e1');
    expect(dialogs.open).toHaveBeenCalledOnce();
  });

  it('connects the host before uploading, and gives up when the connect fails', async () => {
    state = 'idle';
    await actions().upload(synced);
    expect(connector.connect).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'h1' }));
    expect(ipc.uploadNow).not.toHaveBeenCalled();
  });

  it('stops a synced file without asking, a modified one after the confirm', async () => {
    await expect(actions().stop(synced)).resolves.toBe(true);
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(ipc.stop).toHaveBeenCalledWith('e2', false);
    answers = [false];
    await expect(actions().stop(conflict)).resolves.toBe(false);
    expect(dialog()[1].data).toMatchObject({
      content: 'Your changes were not uploaded to vps and will be deleted.',
      yes: 'Stop and delete changes',
    });
    expect(ipc.stop).toHaveBeenCalledOnce();
  });

  it('asks when a save landed after the list was drawn (not_uploaded), then forces', async () => {
    ipc.stop.mockRejectedValueOnce(new IpcError('not_uploaded', 'changes'));
    answers = [true];
    await expect(actions().stop(synced)).resolves.toBe(true);
    expect(ipc.stop).toHaveBeenLastCalledWith('e2', true);
  });

  it('stops all with the names not uploaded in the confirm', async () => {
    answers = [true];
    await actions().stopAll();
    expect(dialog()[1]).toMatchObject({
      label: 'Stop editing 2 files?',
      data: {
        content: 'Their local copies are deleted. Not uploaded: nginx.conf.',
        yes: 'Stop all',
      },
    });
    expect(ipc.stopAll).toHaveBeenCalledWith(true);
    expect(store().count()).toBe(0);
  });

  it('discards a recovered file after its confirm', async () => {
    const recovered = editedFile('e3', 'h1', '/a.sh', { state: 'recovered', notUploaded: true });
    answers = [true];
    await expect(actions().discard(recovered)).resolves.toBe(true);
    expect(dialog()[1]).toMatchObject({
      label: 'Discard your changes to a.sh?',
      data: { content: 'They were never uploaded to vps.', yes: 'Discard' },
    });
    expect(ipc.discardRecovered).toHaveBeenCalledWith('e3');
  });

  it('opens the built-in editor only for an uploaded file small enough', async () => {
    expect(builtInBlocker(conflict)).toBe('Upload or discard your changes first');
    expect(builtInBlocker({ ...synced, size: 6 * 1024 * 1024 })).toBe(
      'Too large to edit (max 5 MiB)',
    );
    await actions().openBuiltIn(conflict);
    expect(launcher.openFile).not.toHaveBeenCalled();
    await actions().openBuiltIn(synced);
    expect(launcher.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'h1' }),
      '/srv/app.env',
      10,
    );
  });

  it('reviews: the page, a focus request on the row, and the dialog of a conflict', async () => {
    answers = ['cancel'];
    await actions().review('e1');
    expect(TestBed.inject(Router).url).toBe('/edited-files');
    expect(store().focusRequest()).toEqual({ id: 'e1' });
    expect(dialogs.open).toHaveBeenCalledOnce();
  });

  it('reports a failed reveal', async () => {
    ipc.reveal.mockRejectedValueOnce(new IpcError('io', 'the local copy could not be read'));
    await actions().reveal(synced);
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('The local copy could not be read.'),
      expect.objectContaining({ label: 'Folder not opened' }),
    );
  });
});
