import { TestBed } from '@angular/core/testing';
import { TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { IpcError } from '../../core/ipc/ipc-error';
import {
  TransferIpc,
  type TransferConflict,
  type TransferEvent,
  type TransferView,
} from '../../core/ipc/transfers';
import type { ConflictAnswer } from './conflict-dialog/conflict-dialog';
import { ConflictPrompter } from './conflict-prompter';
import { dirKey, FAILURE_WINDOW_MS, TransferQueue } from './transfer-queue';

function job(id: string, patch: Partial<TransferView> = {}): TransferView {
  return {
    id,
    connectionId: 'h1@e1',
    direction: 'upload',
    source: `C:\\data\\${id}.txt`,
    targetDir: '/srv',
    name: `${id}.txt`,
    state: 'queued',
    totalBytes: null,
    doneBytes: 0,
    totalFiles: null,
    doneFiles: 0,
    skipped: 0,
    error: null,
    ...patch,
  };
}

const conflict = (jobId: string, path = '/srv/a.txt', conflictId = 1): TransferConflict => ({
  kind: 'conflict',
  jobId,
  conflictId,
  path,
  existingSize: 1,
  existingModified: null,
  incomingSize: 2,
  incomingModified: null,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('TransferQueue', () => {
  let queue: TransferQueue;
  let emit: (event: TransferEvent) => void;
  let snapshot: () => Promise<TransferView[]>;
  const ipc = {
    subscribe: vi.fn((onEvent: (event: TransferEvent) => void) => {
      emit = onEvent;
      return snapshot();
    }),
    enqueue: vi.fn(() => Promise.resolve(['j1'])),
    cancel: vi.fn(() => Promise.resolve()),
    answerConflict: vi.fn(() => Promise.resolve()),
    clearFinished: vi.fn(() => Promise.resolve()),
  };
  const prompter = {
    ask: vi.fn<(name: string, c: TransferConflict) => Promise<ConflictAnswer>>(() =>
      Promise.resolve({ decision: 'rename', applyToAll: false }),
    ),
  };
  const alerts = { open: vi.fn(() => of(undefined)) };

  beforeEach(() => {
    vi.clearAllMocks();
    snapshot = () => Promise.resolve([]);
    TestBed.configureTestingModule({
      providers: [
        { provide: TransferIpc, useValue: ipc },
        { provide: ConflictPrompter, useValue: prompter },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    });
    queue = TestBed.inject(TransferQueue);
  });

  afterEach(() => vi.useRealTimers());

  it('starts from the subscription snapshot, once', async () => {
    snapshot = () => Promise.resolve([job('j1'), job('j2', { state: 'done' })]);
    await queue.start();
    await queue.start();
    expect(ipc.subscribe).toHaveBeenCalledTimes(1);
    expect(queue.transfers().map((t) => t.id)).toEqual(['j1', 'j2']);
    expect(queue.hasFinished()).toBe(true);
  });

  it('notifies and allows a retry when the subscription fails', async () => {
    snapshot = () => Promise.reject(new IpcError('io', 'boom'));
    await queue.start();
    expect(alerts.open).toHaveBeenCalledWith(
      'boom',
      expect.objectContaining({ label: 'Transfers unavailable' }),
    );
    snapshot = () => Promise.resolve([]);
    await queue.start();
    expect(ipc.subscribe).toHaveBeenCalledTimes(2);
  });

  it('applies updated and removed events', async () => {
    await queue.start();
    emit({ kind: 'updated', transfer: job('j1', { state: 'running', doneBytes: 5 }) });
    emit({ kind: 'updated', transfer: job('j2') });
    emit({ kind: 'updated', transfer: job('j1', { state: 'running', doneBytes: 9 }) });
    expect(queue.transfers().map((t) => [t.id, t.doneBytes])).toEqual([
      ['j1', 9],
      ['j2', 0],
    ]);
    emit({ kind: 'removed', jobIds: ['j1'] });
    expect(queue.transfers().map((t) => t.id)).toEqual(['j2']);
    expect(queue.forConnection('h1@e1').length).toBe(1);
    expect(queue.forConnection('h1@none')).toEqual([]);
  });

  it('merges events that arrive before the snapshot', async () => {
    let resolve!: (list: TransferView[]) => void;
    snapshot = () => new Promise((r) => (resolve = r));
    const started = queue.start();
    emit({ kind: 'updated', transfer: job('j1', { state: 'done' }) });
    emit({ kind: 'updated', transfer: job('j3') });
    emit({ kind: 'removed', jobIds: ['j2'] });
    resolve([job('j1', { state: 'running' }), job('j2')]);
    await started;
    expect(queue.transfers().map((t) => [t.id, t.state])).toEqual([
      ['j1', 'done'],
      ['j3', 'queued'],
    ]);
  });

  it('bumps the target directory revision once when a job finishes', async () => {
    await queue.start();
    emit({ kind: 'updated', transfer: job('j1', { state: 'running' }) });
    expect(queue.revisions().size).toBe(0);
    emit({ kind: 'updated', transfer: job('j1', { state: 'done' }) });
    emit({ kind: 'updated', transfer: job('j1', { state: 'done' }) });
    emit({
      kind: 'updated',
      transfer: job('j2', { direction: 'download', targetDir: 'C:\\in', state: 'cancelled' }),
    });
    expect(queue.revisions().get(dirKey('h1@e1', 'remote', '/srv'))).toBe(1);
    expect(queue.revisions().get(dirKey('other', 'local', 'C:\\in'))).toBe(1);
  });

  it('enqueues with the ask policy by default and notifies a refusal', async () => {
    await queue.enqueue('h1@e1', 'upload', ['C:\\a', 'C:\\b'], '/srv');
    expect(ipc.enqueue).toHaveBeenCalledWith({
      connectionId: 'h1@e1',
      direction: 'upload',
      sources: ['C:\\a', 'C:\\b'],
      targetDir: '/srv',
      conflict: 'ask',
    });
    ipc.enqueue.mockRejectedValueOnce(new IpcError('not_connected', 'Not connected'));
    await queue.enqueue('h1@e1', 'upload', ['C:\\a'], '/srv');
    expect(alerts.open).toHaveBeenCalledWith(
      'Not connected',
      expect.objectContaining({ label: 'Transfer not started' }),
    );
    await queue.enqueue('h1@e1', 'upload', [], '/srv');
    expect(ipc.enqueue).toHaveBeenCalledTimes(2);
  });

  it('cancels and clears, ignoring jobs that are already gone', async () => {
    ipc.cancel.mockRejectedValueOnce(new IpcError('not_found', 'gone'));
    await queue.cancel('j1');
    await queue.clearFinished();
    expect(ipc.cancel).toHaveBeenCalledWith('j1');
    expect(ipc.clearFinished).toHaveBeenCalled();
    expect(alerts.open).not.toHaveBeenCalled();
  });

  it('asks about conflicts one at a time and sends the answer with applyToAll', async () => {
    await queue.start();
    emit({ kind: 'updated', transfer: job('j1', { state: 'waitingConflict' }) });
    let answerFirst!: (a: ConflictAnswer) => void;
    prompter.ask.mockImplementationOnce(() => new Promise((r) => (answerFirst = r)));
    prompter.ask.mockResolvedValueOnce({ decision: 'skip', applyToAll: false });
    emit(conflict('j1', '/srv/dir/a.txt', 4));
    emit(conflict('j2', '/srv/b.txt'));
    await flush();
    expect(prompter.ask).toHaveBeenCalledTimes(1);
    expect(prompter.ask).toHaveBeenCalledWith('a.txt', expect.objectContaining({ jobId: 'j1' }));

    answerFirst({ decision: 'overwrite', applyToAll: true });
    await flush();
    expect(ipc.answerConflict).toHaveBeenNthCalledWith(1, 'j1', 4, 'overwrite', true);
    expect(prompter.ask).toHaveBeenCalledTimes(2);
    await flush();
    expect(ipc.answerConflict).toHaveBeenNthCalledWith(2, 'j2', 1, 'skip', false);
  });

  it('does not ask about a job that already finished', async () => {
    await queue.start();
    emit({ kind: 'updated', transfer: job('j1', { state: 'cancelled' }) });
    emit(conflict('j1'));
    await flush();
    expect(prompter.ask).not.toHaveBeenCalled();
  });

  it('notifies each failure, or one grouped notification for many', async () => {
    vi.useFakeTimers();
    await queue.start();
    emit({
      kind: 'updated',
      transfer: job('j1', { state: 'failed', error: { code: 'io', message: 'Disk full' } }),
    });
    vi.advanceTimersByTime(FAILURE_WINDOW_MS);
    expect(alerts.open).toHaveBeenCalledTimes(1);
    expect(alerts.open).toHaveBeenCalledWith(
      'j1.txt: Disk full',
      expect.objectContaining({ label: 'Transfer failed' }),
    );

    alerts.open.mockClear();
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      emit({
        kind: 'updated',
        transfer: job(id, {
          state: 'failed',
          error: { code: 'not_connected', message: 'Not connected' },
        }),
      });
    }
    expect(alerts.open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FAILURE_WINDOW_MS);
    expect(alerts.open).toHaveBeenCalledTimes(1);
    expect(alerts.open).toHaveBeenCalledWith(
      'a.txt, b.txt, c.txt and 2 more. Not connected',
      expect.objectContaining({ label: '5 transfers failed' }),
    );
  });

  it('does not notify failures from the snapshot or repeated failed updates', async () => {
    vi.useFakeTimers();
    snapshot = () => Promise.resolve([job('j1', { state: 'failed' })]);
    await queue.start();
    emit({ kind: 'updated', transfer: job('j1', { state: 'failed' }) });
    vi.advanceTimersByTime(FAILURE_WINDOW_MS);
    expect(alerts.open).not.toHaveBeenCalled();
  });
});
