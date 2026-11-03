import { Service } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { invokeCommand } from './ipc-error';

export type TransferDirection = 'upload' | 'download';

export type TransferState =
  'queued' | 'running' | 'waitingConflict' | 'done' | 'failed' | 'cancelled';

export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename';

export type ConflictDecision = Exclude<ConflictPolicy, 'ask'>;

export interface TransferView {
  id: string;
  connectionId: string;
  direction: TransferDirection;
  source: string;
  targetDir: string;
  /** Basename of `source`. */
  name: string;
  state: TransferState;
  totalBytes: number | null;
  doneBytes: number;
  totalFiles: number | null;
  doneFiles: number;
  skipped: number;
  error: { code: string; message: string } | null;
}

export interface TransferConflict {
  kind: 'conflict';
  jobId: string;
  /** Sequence number of this conflict within its job; an answer must echo it. */
  conflictId: number;
  /** Destination path. */
  path: string;
  existingSize: number | null;
  /** Unix seconds. */
  existingModified: number | null;
  incomingSize: number | null;
  /** Unix seconds. */
  incomingModified: number | null;
}

export type TransferEvent =
  | { kind: 'updated'; transfer: TransferView }
  | TransferConflict
  | { kind: 'removed'; jobIds: string[] };

export interface TransferRequest {
  connectionId: string;
  direction: TransferDirection;
  sources: string[];
  targetDir: string;
  conflict: ConflictPolicy;
}

export const FINISHED_STATES: readonly TransferState[] = ['done', 'failed', 'cancelled'];

export function isFinished(state: TransferState): boolean {
  return FINISHED_STATES.includes(state);
}

@Service()
export class TransferIpc {
  /** Replaces any previous subscription; returns the current jobs. */
  subscribe(onEvent: (event: TransferEvent) => void): Promise<TransferView[]> {
    const channel = new Channel<TransferEvent>();
    channel.onmessage = onEvent;
    return invokeCommand<TransferView[]>('subscribe_transfers', { onEvent: channel });
  }

  /** One job id per source, in order. */
  enqueue(request: TransferRequest): Promise<string[]> {
    return invokeCommand<string[]>('enqueue_transfers', { ...request });
  }

  async cancel(jobId: string): Promise<void> {
    await invokeCommand<null>('cancel_transfer', { jobId });
  }

  async answerConflict(
    jobId: string,
    conflictId: number,
    decision: ConflictDecision,
    applyToAll: boolean,
  ): Promise<void> {
    await invokeCommand<null>('answer_conflict', { jobId, conflictId, decision, applyToAll });
  }

  async clearFinished(): Promise<void> {
    await invokeCommand<null>('clear_finished_transfers');
  }
}
