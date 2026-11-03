import { TestBed } from '@angular/core/testing';
import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { type ConnectionEvent, ConnectionEvents } from './connection-events';
import { SshService } from './ssh';

describe('ConnectionEvents', () => {
  let channel: Channel<ConnectionEvent> | null;
  let fail: boolean;
  let calls: number;

  beforeEach(() => {
    channel = null;
    fail = false;
    calls = 0;
    mockIPC((cmd, args) => {
      if (cmd === 'subscribe_connections') {
        calls++;
        channel = (args as Record<string, unknown>)['onEvent'] as Channel<ConnectionEvent>;
        return fail
          ? Promise.reject({ code: 'unknown', message: 'no' })
          : [{ connectionId: 'h7', reason: 'user' }];
      }
      return null;
    });
  });

  afterEach(() => clearMocks());

  it('marks a connection ended with its reason', async () => {
    const events = TestBed.inject(ConnectionEvents);
    expect(await events.start()).toBe(true);
    await events.start();
    expect(calls).toBe(1);
    channel?.onmessage({ kind: 'connectionEnded', connectionId: 'h1', reason: 'lost' });
    const ssh = TestBed.inject(SshService);
    expect(ssh.endReasons()['h7']).toBe('user');
    expect(ssh.stateOf('h1')).toBe('idle');
    expect(ssh.endReasons()['h1']).toBe('lost');
  });

  it('resolves false without a stream and allows a later start', async () => {
    fail = true;
    const events = TestBed.inject(ConnectionEvents);
    expect(await events.start()).toBe(false);
    fail = false;
    expect(await events.start()).toBe(true);
    expect(calls).toBe(2);
  });
});
