import { Service } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { IpcError, invokeCommand } from './ipc-error';

export type TerminalClosedReason = 'exited' | 'closed' | 'connectionLost';

export type TerminalWireEvent =
  | { kind: 'data'; data: string }
  | { kind: 'exit'; code: number | null }
  | { kind: 'closed'; reason: TerminalClosedReason };

export type TerminalEvent =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'exit'; code: number | null }
  | { kind: 'closed'; reason: TerminalClosedReason };

export const MAX_WRITE_BYTES = 64 * 1024;
export const BUSY_RETRY_DELAY_MS = 50;
export const BUSY_RETRIES = 5;

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Splits on code point boundaries so each chunk is at most `max` bytes of UTF-8. */
export function chunkUtf8(data: string, max = MAX_WRITE_BYTES): string[] {
  const chunks: string[] = [];
  let current = '';
  let size = 0;
  for (const char of data) {
    const length = utf8Length(char.codePointAt(0) ?? 0);
    if (size + length > max) {
      chunks.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += length;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function retryBusy<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof IpcError && err.code === 'busy') || attempt >= BUSY_RETRIES) {
        throw err;
      }
      await delay(BUSY_RETRY_DELAY_MS);
    }
  }
}

@Service()
export class TerminalIpc {
  open(
    connectionId: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<string> {
    const channel = new Channel<TerminalWireEvent>();
    channel.onmessage = (event) => {
      onEvent(event.kind === 'data' ? { kind: 'data', bytes: decodeBase64(event.data) } : event);
    };
    return invokeCommand<string>('open_terminal', { connectionId, cols, rows, onEvent: channel });
  }

  /** Writes in order, chunked to the backend limit; a full input queue (`busy`) is retried. */
  async write(terminalId: string, data: string): Promise<void> {
    for (const chunk of chunkUtf8(data)) {
      await retryBusy(() => invokeCommand<null>('write_terminal', { terminalId, data: chunk }));
    }
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    await retryBusy(() => invokeCommand<null>('resize_terminal', { terminalId, cols, rows }));
  }

  async close(terminalId: string): Promise<void> {
    await invokeCommand<null>('close_terminal', { terminalId });
  }
}
