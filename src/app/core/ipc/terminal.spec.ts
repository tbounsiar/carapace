import { TestBed } from '@angular/core/testing';
import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { IpcError } from './ipc-error';
import {
  BUSY_RETRIES,
  chunkUtf8,
  MAX_WRITE_BYTES,
  TerminalIpc,
  type TerminalEvent,
  type TerminalWireEvent,
} from './terminal';

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('TerminalIpc', () => {
  let ipc: TerminalIpc;
  let calls: { cmd: string; args: Record<string, unknown> }[];
  let onCall: (cmd: string, args: Record<string, unknown>) => unknown;

  beforeEach(() => {
    calls = [];
    onCall = (cmd) => (cmd === 'open_terminal' ? 't1' : null);
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      return onCall(cmd, a);
    });
    ipc = TestBed.inject(TerminalIpc);
  });

  afterEach(() => {
    clearMocks();
    vi.useRealTimers();
  });

  it('opens with the connection, size and a channel, and decodes data events from base64', async () => {
    const events: TerminalEvent[] = [];
    onCall = (cmd, args) => {
      const channel = args['onEvent'] as Channel<TerminalWireEvent>;
      channel.onmessage({ kind: 'data', data: btoa('hi\r\n\x1b[0m') });
      channel.onmessage({ kind: 'exit', code: 0 });
      channel.onmessage({ kind: 'closed', reason: 'exited' });
      return 't1';
    };
    const id = await ipc.open('h1', 80, 24, (event) => events.push(event));
    expect(id).toBe('t1');
    expect(calls[0].cmd).toBe('open_terminal');
    expect(calls[0].args).toMatchObject({ connectionId: 'h1', cols: 80, rows: 24 });
    const data = events[0] as Extract<TerminalEvent, { kind: 'data' }>;
    expect(Array.from(data.bytes)).toEqual([104, 105, 13, 10, 27, 91, 48, 109]);
    expect(events.slice(1)).toEqual([
      { kind: 'exit', code: 0 },
      { kind: 'closed', reason: 'exited' },
    ]);
  });

  it('keeps raw bytes that are not valid UTF-8 on their own', async () => {
    let received: Uint8Array | null = null;
    onCall = (_cmd, args) => {
      (args['onEvent'] as Channel<TerminalWireEvent>).onmessage({ kind: 'data', data: '4pw=' });
      return 't1';
    };
    await ipc.open('h1', 80, 24, (event) => {
      if (event.kind === 'data') received = event.bytes;
    });
    expect(Array.from(received!)).toEqual([0xe2, 0x9c]);
  });

  it('sends write, resize and close arguments', async () => {
    await ipc.write('t1', 'ls\r');
    await ipc.resize('t1', 120, 40);
    await ipc.close('t1');
    expect(calls).toEqual([
      { cmd: 'write_terminal', args: { terminalId: 't1', data: 'ls\r' } },
      { cmd: 'resize_terminal', args: { terminalId: 't1', cols: 120, rows: 40 } },
      { cmd: 'close_terminal', args: { terminalId: 't1' } },
    ]);
  });

  it('splits large writes into ordered chunks of at most 64 KiB of UTF-8', async () => {
    const data = 'a'.repeat(MAX_WRITE_BYTES - 1) + 'é' + 'b'.repeat(10) + '😀'.repeat(20000);
    await ipc.write('t1', data);
    const sent = calls.map((c) => c.args['data'] as string);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join('')).toBe(data);
    for (const chunk of sent) {
      expect(bytes(chunk)).toBeLessThanOrEqual(MAX_WRITE_BYTES);
    }
    expect(sent[0]).toBe('a'.repeat(MAX_WRITE_BYTES - 1));
  });

  it('never splits a code point', () => {
    const chunks = chunkUtf8('😀😀😀', 5);
    expect(chunks).toEqual(['😀', '😀', '😀']);
    expect(chunkUtf8('')).toEqual([]);
  });

  it('retries the same chunk while the input queue is busy', async () => {
    vi.useFakeTimers();
    let busy = 2;
    onCall = (cmd) => {
      if (cmd === 'write_terminal' && busy > 0) {
        busy--;
        throw { code: 'busy', message: 'Terminal input queue is full' };
      }
      return null;
    };
    const done = ipc.write('t1', 'x');
    await vi.runAllTimersAsync();
    await done;
    expect(calls.map((c) => c.args['data'])).toEqual(['x', 'x', 'x']);
  });

  it('gives up after a few busy retries', async () => {
    vi.useFakeTimers();
    onCall = () => {
      throw { code: 'busy', message: 'Terminal input queue is full' };
    };
    const done = ipc.resize('t1', 80, 24).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await done;
    expect(err).toBeInstanceOf(IpcError);
    expect(err).toMatchObject({ code: 'busy' });
    expect(calls).toHaveLength(BUSY_RETRIES + 1);
  });

  it('does not retry other errors', async () => {
    onCall = () => {
      throw { code: 'not_found', message: 'Terminal not found' };
    };
    const err = await ipc.write('t1', 'x').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'not_found' });
    expect(calls).toHaveLength(1);
  });
});
