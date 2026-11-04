import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { host } from '../../core/ipc/config.fixture';
import { EditedFiles } from '../../core/ipc/edited-files';
import { ExternalEditsIpc } from '../../core/ipc/external-edits';
import { editedFile } from '../../core/ipc/external-edits.fixture';
import { IpcError } from '../../core/ipc/ipc-error';
import { Workspace } from '../workspace/workspace';
import { ExternalOpener } from './external-opener';

@Component({ template: '' })
class Blank {}

describe('ExternalOpener', () => {
  const vps = host('h1', 'vps');
  const file = editedFile('e1', 'h1', '/etc/nginx.conf');
  let answers: unknown[];
  let failures: unknown[];
  let noticeSeen: boolean;
  const ipc = {
    getEditor: vi.fn(() => Promise.resolve({ mode: 'system', appPath: null, noticeSeen })),
    setEditor: vi.fn((s: unknown) => Promise.resolve(s)),
    open: vi.fn(() => {
      const next = failures.shift();
      return next ? Promise.reject(next) : Promise.resolve(file);
    }),
  };
  const dialogs = { open: vi.fn(() => of(answers.shift())) };
  const alerts = { open: vi.fn(() => of(undefined)) };
  const store = { findByPath: vi.fn(() => null), upsert: vi.fn() };

  beforeAll(async () => {
    await import('../../shared/destructive-confirm/destructive-confirm');
    await import('./external-notice-dialog/external-notice-dialog');
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    answers = [];
    failures = [];
    noticeSeen = true;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: ExternalEditsIpc, useValue: ipc },
        { provide: EditedFiles, useValue: store },
        { provide: TuiDialogService, useValue: dialogs },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    });
  });

  const opener = () => TestBed.inject(ExternalOpener);
  const labels = () =>
    (dialogs.open.mock.calls as unknown as [unknown, { label: string }][]).map((c) => c[1].label);
  const alertOf = (i = 0) =>
    alerts.open.mock.calls[i] as unknown as [unknown, { label: string; data?: { text: string } }];

  it('opens with the listing size and keeps the file in the store', async () => {
    await expect(opener().open(vps, '/etc/nginx.conf', 120)).resolves.toBe(true);
    expect(ipc.open).toHaveBeenCalledWith({
      connectionId: 'h1',
      path: '/etc/nginx.conf',
      size: 120,
      confirmLarge: false,
      confirmSensitive: false,
    });
    expect(store.upsert).toHaveBeenCalledWith(file);
    expect(dialogs.open).not.toHaveBeenCalled();
  });

  it('shows the first-time notice, saving "Don’t show this again" only on Continue', async () => {
    noticeSeen = false;
    answers = [{ dontShow: true }];
    await expect(opener().open(vps, '/a', 1)).resolves.toBe(true);
    expect(labels()).toEqual(['Before you edit outside Carapace']);
    expect(ipc.setEditor).toHaveBeenCalledWith({ mode: 'system', appPath: null, noticeSeen: true });
    answers = [undefined];
    await expect(opener().open(vps, '/a', 1)).resolves.toBe(false);
    expect(ipc.open).toHaveBeenCalledOnce();
  });

  it('skips the notice for a file already edited (a relaunch)', async () => {
    noticeSeen = false;
    store.findByPath.mockReturnValueOnce(file as never);
    await opener().open(vps, '/etc/nginx.conf', 1);
    expect(dialogs.open).not.toHaveBeenCalled();
  });

  it('asks before a large download, then calls again with confirmLarge', async () => {
    failures = [new IpcError('large_file', 'big.iso is 125829120 bytes; confirm to download it')];
    answers = [true];
    await expect(opener().open(vps, '/big.iso', 125829120)).resolves.toBe(true);
    expect(labels()).toEqual(['Download 120 MiB to edit it?']);
    expect(ipc.open).toHaveBeenLastCalledWith(expect.objectContaining({ confirmLarge: true }));
  });

  it('stops when the large download is cancelled; the size comes from the message if needed', async () => {
    failures = [new IpcError('large_file', 'big.iso is 31457280 bytes; confirm to download it')];
    answers = [false];
    await expect(opener().open(vps, '/big.iso', null)).resolves.toBe(false);
    expect(labels()).toEqual(['Download 30 MiB to edit it?']);
    expect(ipc.open).toHaveBeenCalledOnce();
  });

  it('asks before copying a sensitive file, then keeps both confirmations', async () => {
    failures = [
      new IpcError('sensitive', 'id_rsa may hold secrets'),
      new IpcError('large_file', 'x is 31457280 bytes'),
    ];
    answers = [true, true];
    await expect(opener().open(vps, '/home/u/id_rsa', 31457280)).resolves.toBe(true);
    const [, sensitive] = dialogs.open.mock.calls[0] as unknown as [
      unknown,
      { label: string; data: { yesTestId: string; warning: boolean; content: string } },
    ];
    expect(sensitive.label).toBe('Copy a file that may hold secrets?');
    expect(sensitive.data).toMatchObject({ yesTestId: 'ext-sensitive-confirm', warning: true });
    expect(sensitive.data.content).toContain('id_rsa may hold keys, passwords or tokens.');
    expect(ipc.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmLarge: true, confirmSensitive: true }),
    );
  });

  it('refuses a blocked type with a Settings action', async () => {
    failures = [new IpcError('blocked_type', 'run.ps1 would be run, not opened, by your system')];
    await expect(opener().open(vps, '/srv/run.ps1', 1)).resolves.toBe(false);
    const [, options] = alertOf();
    expect(options.label).toBe('File not opened');
    expect(options.data?.text).toBe(
      'run.ps1 would be run, not opened, by your system. Choose an editor app in Settings to edit .ps1 files.',
    );
    const action = options.data as unknown as { action: string; run: () => void };
    expect(action.action).toBe('Settings');
    action.run();
    await new Promise((r) => setTimeout(r));
    expect(TestBed.inject(Router).url).toBe('/settings');
  });

  it('names the missing app and words the other refusals', async () => {
    failures = [new IpcError('app_not_found', 'the editor app was not found: code.exe')];
    await opener().open(vps, '/a.txt', 1);
    expect(alertOf().at(1)).toMatchObject({
      data: { text: 'The editor app was not found: code.exe. Choose it again in Settings.' },
    });
    failures = [new IpcError('app_not_editor', 'cmd.exe runs or forwards files')];
    await opener().open(vps, '/a.txt', 1);
    expect(alertOf(1)[1]).toMatchObject({
      data: {
        text: 'The editor app runs files instead of editing them. Choose an editor in Settings.',
        action: 'Settings',
      },
    });
    failures = [new IpcError('permission_denied', 'denied')];
    await opener().open(vps, '/etc/shadow', 1);
    expect(alertOf(2)[0]).toBe("You don't have permission to read shadow on vps.");
    failures = [new IpcError('app_failed', 'x')];
    await opener().open(vps, '/a.txt', 1);
    expect(alertOf(3)[0]).toBe('The editor app could not be started.');
  });

  it('refuses over 1 GiB and while the built-in tab of the file has unsaved changes', async () => {
    await expect(opener().open(vps, '/disk.img', 2 * 1024 ** 3)).resolves.toBe(false);
    expect(alertOf()[0]).toBe('disk.img is too large to edit (2.0 GiB, max 1 GiB).');
    TestBed.inject(Workspace).add({
      key: 'edit:h1:/etc/nginx.conf',
      kind: 'edit',
      hostId: 'h1',
      label: 'nginx.conf',
      path: '/etc/nginx.conf',
      status: signal({ kind: 'connected' as const, word: 'Connected' }),
      modified: signal(true),
    });
    await expect(opener().open(vps, '/etc/nginx.conf', 1)).resolves.toBe(false);
    expect(alertOf(1)[0]).toBe('Save or close nginx.conf in Carapace first.');
    expect(ipc.open).not.toHaveBeenCalled();
  });
});
