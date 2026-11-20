import { TestBed } from '@angular/core/testing';
import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { IpcError } from './ipc-error';
import { type UpdateEvent, type UpdateProgress, type UpdateState, UpdatesIpc } from './updates';

const STATE: UpdateState = {
  current: '0.2.0',
  autoCheck: true,
  skippedVersion: null,
  lastCheck: null,
  available: null,
  downloaded: false,
  installKind: 'inPlace',
};

describe('UpdatesIpc', () => {
  let calls: { cmd: string; args: Record<string, unknown> }[];
  let answer: (cmd: string) => unknown;

  beforeEach(() => {
    calls = [];
    answer = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      return answer(cmd);
    });
  });

  afterEach(() => clearMocks());

  it('sends every command with camelCase arguments', async () => {
    const ipc = TestBed.inject(UpdatesIpc);
    answer = (cmd) =>
      cmd === 'check_update' ? { version: '0.3.0', date: null } : cmd.includes('_') ? STATE : null;
    expect(await ipc.state()).toEqual(STATE);
    await ipc.setAutoCheck(false);
    expect(await ipc.check()).toEqual({ version: '0.3.0', date: null });
    await ipc.skip('0.3.0');
    answer = () => null;
    await ipc.cancelDownload();
    await ipc.apply(true);
    await ipc.openReleaseNotes('0.3.0');
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['update_state', {}],
      ['set_update_auto_check', { enabled: false }],
      ['check_update', {}],
      ['skip_update', { version: '0.3.0' }],
      ['cancel_update_download', {}],
      ['apply_update', { confirmed: true }],
      ['open_release_notes', { version: '0.3.0' }],
    ]);
  });

  it('streams update events and download progress through channels', async () => {
    const ipc = TestBed.inject(UpdatesIpc);
    const events: UpdateEvent[] = [];
    const progress: UpdateProgress[] = [];
    await ipc.subscribe((e) => events.push(e));
    await ipc.download((p) => progress.push(p));
    (calls[0].args['onEvent'] as Channel<UpdateEvent>).onmessage({
      kind: 'available',
      info: { version: '0.3.0', date: '2026-11-20T10:00:00Z' },
    });
    (calls[1].args['onProgress'] as Channel<UpdateProgress>).onmessage({
      downloaded: 10,
      total: null,
    });
    expect(calls.map((c) => c.cmd)).toEqual(['subscribe_updates', 'download_update']);
    expect(events).toEqual([
      { kind: 'available', info: { version: '0.3.0', date: '2026-11-20T10:00:00Z' } },
    ]);
    expect(progress).toEqual([{ downloaded: 10, total: null }]);
  });

  it('maps the update error codes', async () => {
    const ipc = TestBed.inject(UpdatesIpc);
    for (const code of [
      'update_unavailable',
      'signature_invalid',
      'install_failed',
      'nothing_downloaded',
      'restart_required',
    ]) {
      mockIPC(() => Promise.reject({ code, message: 'x' }));
      await expect(ipc.apply(true)).rejects.toEqual(expect.objectContaining({ code }));
      await expect(ipc.apply(true)).rejects.toBeInstanceOf(IpcError);
    }
  });
});
