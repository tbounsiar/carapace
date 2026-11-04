import { TestBed } from '@angular/core/testing';
import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { type EditedEvent, ExternalEditsIpc } from './external-edits';
import { editedFile } from './external-edits.fixture';
import { IpcError } from './ipc-error';

describe('ExternalEditsIpc', () => {
  let ipc: ExternalEditsIpc;
  let calls: { cmd: string; args: Record<string, unknown> }[];
  let onCall: (cmd: string, args: Record<string, unknown>) => unknown;
  const file = editedFile('e1', 'h1', '/etc/nginx.conf');

  beforeEach(() => {
    calls = [];
    onCall = () => null;
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      return onCall(cmd, a);
    });
    ipc = TestBed.inject(ExternalEditsIpc);
  });

  afterEach(() => clearMocks());

  it('opens with the listing size and both confirmations off by default', async () => {
    onCall = () => file;
    await expect(
      ipc.open({ connectionId: 'h1', path: '/etc/nginx.conf', size: 12 }),
    ).resolves.toEqual(file);
    expect(calls[0]).toEqual({
      cmd: 'open_external',
      args: {
        connectionId: 'h1',
        path: '/etc/nginx.conf',
        size: 12,
        confirmLarge: false,
        confirmSensitive: false,
      },
    });
    await ipc.open({ connectionId: 'h1', path: '/a', confirmLarge: true, confirmSensitive: true });
    expect(calls[1].args).toMatchObject({ size: null, confirmLarge: true, confirmSensitive: true });
  });

  it('maps the new error codes to typed errors', async () => {
    for (const code of [
      'large_file',
      'sensitive',
      'blocked_type',
      'app_not_found',
      'not_uploaded',
    ]) {
      onCall = () => {
        throw { code, message: 'x' };
      };
      const err = await ipc.open({ connectionId: 'h1', path: '/a' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IpcError);
      expect((err as IpcError).code).toBe(code);
    }
  });

  it('subscribes with a channel and forwards updated and removed events', async () => {
    const events: EditedEvent[] = [];
    onCall = (_cmd, args) => {
      const channel = args['onEvent'] as Channel<EditedEvent>;
      channel.onmessage({ kind: 'updated', file });
      channel.onmessage({ kind: 'removed', id: 'e0' });
      return [file];
    };
    await expect(ipc.subscribe((e) => events.push(e))).resolves.toEqual([file]);
    expect(calls[0].cmd).toBe('subscribe_edited');
    expect(events).toEqual([
      { kind: 'updated', file },
      { kind: 'removed', id: 'e0' },
    ]);
  });

  it('sends the exact arguments of each command', async () => {
    onCall = (cmd) => (cmd === 'stop_all_editing' ? 2 : cmd === 'has_unsynced' ? true : file);
    await ipc.uploadNow('e1');
    await ipc.resolveConflict('e1', 'useServer');
    await ipc.stop('e1', false);
    await expect(ipc.stopAll(true)).resolves.toBe(2);
    await ipc.discardRecovered('e1');
    await ipc.reveal('e1');
    await expect(ipc.hasUnsynced()).resolves.toBe(true);
    onCall = () => [];
    await ipc.affected({ kind: 'collection', id: 'c1' });
    await ipc.list();
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['upload_now', { id: 'e1' }],
      ['resolve_conflict', { id: 'e1', choice: 'useServer', confirmLarge: false }],
      ['stop_editing', { id: 'e1', force: false }],
      ['stop_all_editing', { force: true }],
      ['discard_recovered', { id: 'e1' }],
      ['reveal', { id: 'e1' }],
      ['has_unsynced', {}],
      ['edited_affected', { target: { kind: 'collection', id: 'c1' } }],
      ['list_edited', {}],
    ]);
  });

  it('reads and writes the editor setting, and picks the app', async () => {
    const setting = { mode: 'custom' as const, appPath: '/usr/bin/code', noticeSeen: true };
    onCall = (cmd) => (cmd === 'pick_external_editor' ? '/usr/bin/vim' : setting);
    await expect(ipc.getEditor()).resolves.toEqual(setting);
    await ipc.setEditor(setting);
    await expect(ipc.pickEditor(null)).resolves.toBe('/usr/bin/vim');
    expect(calls[1]).toEqual({ cmd: 'set_external_editor', args: setting });
    expect(calls[2]).toEqual({ cmd: 'pick_external_editor', args: { current: null } });
  });

  it('answers null when another picker is open, and rethrows other failures', async () => {
    onCall = () => {
      throw { code: 'busy', message: 'a picker is open' };
    };
    await expect(ipc.pickEditor('/usr/bin/a')).resolves.toBeNull();
    onCall = () => {
      throw { code: 'io', message: 'broken' };
    };
    await expect(ipc.pickEditor(null)).rejects.toBeInstanceOf(IpcError);
  });
});
