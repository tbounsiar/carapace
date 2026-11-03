import { TestBed } from '@angular/core/testing';
import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { IpcError } from './ipc-error';
import { isFinished, TransferIpc, type TransferEvent, type TransferView } from './transfers';

const view: TransferView = {
  id: 'j1',
  connectionId: 'h1',
  direction: 'upload',
  source: 'C:\\data\\a.txt',
  targetDir: '/srv',
  name: 'a.txt',
  state: 'running',
  totalBytes: 10,
  doneBytes: 5,
  totalFiles: 1,
  doneFiles: 0,
  skipped: 0,
  error: null,
};

describe('TransferIpc', () => {
  let ipc: TransferIpc;
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
    ipc = TestBed.inject(TransferIpc);
  });

  afterEach(() => clearMocks());

  it('subscribes with a channel, returns the current list and forwards events', async () => {
    const events: TransferEvent[] = [];
    onCall = (_cmd, args) => {
      const channel = args['onEvent'] as Channel<TransferEvent>;
      channel.onmessage({ kind: 'updated', transfer: view });
      channel.onmessage({ kind: 'removed', jobIds: ['j0'] });
      return [view];
    };
    const list = await ipc.subscribe((e) => events.push(e));
    expect(calls[0].cmd).toBe('subscribe_transfers');
    expect(list).toEqual([view]);
    expect(events).toEqual([
      { kind: 'updated', transfer: view },
      { kind: 'removed', jobIds: ['j0'] },
    ]);
  });

  it('enqueues with flat arguments and returns the job ids', async () => {
    onCall = () => ['j1', 'j2'];
    const ids = await ipc.enqueue({
      connectionId: 'h1',
      direction: 'download',
      sources: ['/srv/a', '/srv/b'],
      targetDir: 'C:\\data',
      conflict: 'ask',
    });
    expect(ids).toEqual(['j1', 'j2']);
    expect(calls[0]).toEqual({
      cmd: 'enqueue_transfers',
      args: {
        connectionId: 'h1',
        direction: 'download',
        sources: ['/srv/a', '/srv/b'],
        targetDir: 'C:\\data',
        conflict: 'ask',
      },
    });
  });

  it('sends cancel, conflict answers and clear', async () => {
    await ipc.cancel('j1');
    await ipc.answerConflict('j1', 3, 'rename', true);
    await ipc.clearFinished();
    expect(calls).toEqual([
      { cmd: 'cancel_transfer', args: { jobId: 'j1' } },
      {
        cmd: 'answer_conflict',
        args: { jobId: 'j1', conflictId: 3, decision: 'rename', applyToAll: true },
      },
      { cmd: 'clear_finished_transfers', args: {} },
    ]);
  });

  it('maps errors', async () => {
    onCall = () => {
      throw { code: 'too_large', message: 'Too many queued transfers' };
    };
    const err = await ipc
      .enqueue({
        connectionId: 'h1',
        direction: 'upload',
        sources: ['a'],
        targetDir: '/',
        conflict: 'ask',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).code).toBe('too_large');
  });

  it('knows the finished states', () => {
    expect(['done', 'failed', 'cancelled'].every((s) => isFinished(s as never))).toBe(true);
    expect(isFinished('waitingConflict')).toBe(false);
  });
});
