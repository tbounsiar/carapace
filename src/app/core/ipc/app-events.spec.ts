import { TestBed } from '@angular/core/testing';
import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { type AppEvent, AppEvents } from './app-events';

describe('AppEvents', () => {
  let calls: { cmd: string; args: Record<string, unknown> }[];

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      return null;
    });
  });

  afterEach(() => clearMocks());

  it('sets the guard, subscribes and quits', async () => {
    const events = TestBed.inject(AppEvents);
    const received: AppEvent[] = [];
    await events.setQuitGuard(true);
    await events.subscribe((e) => received.push(e));
    (calls[1].args['onEvent'] as Channel<AppEvent>).onmessage({ kind: 'quitRequested' });
    await events.quit();
    expect(calls.map((c) => c.cmd)).toEqual(['set_quit_guard', 'subscribe_app_events', 'quit_app']);
    expect(calls[0].args).toEqual({ active: true });
    expect(received).toEqual([{ kind: 'quitRequested' }]);
  });
});
