import { TestBed } from '@angular/core/testing';
import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { HostTestService, type HostTestRequest } from './host-test';
import { IpcError } from './ipc-error';
import { SshService } from './ssh';
import type { ConnectEvent, HostKeyPrompt } from './ssh.models';

const request: HostTestRequest = {
  host: {
    name: '',
    hostname: '${host}',
    port: '22',
    username: 'deploy',
    auth: { kind: 'agent' },
  },
  projectId: 'p1',
  hostId: null,
};
const prompt: HostKeyPrompt = {
  kind: 'hostKeyPrompt',
  requestId: 'r1',
  status: 'unknown',
  hostname: 'web.example',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
};
const result = {
  address: 'deploy@web.example:22',
  authKind: 'agent',
  secretSource: null,
  durationMs: 12,
};

describe('HostTestService', () => {
  let service: HostTestService;
  let calls: { cmd: string; args: Record<string, unknown> }[];
  let onTest: (channel: Channel<ConnectEvent>) => unknown;
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r));

  beforeEach(() => {
    calls = [];
    onTest = () => result;
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (cmd === 'test_host') {
        return onTest(a['onEvent'] as Channel<ConnectEvent>);
      }
      return null;
    });
    service = TestBed.inject(HostTestService);
  });

  afterEach(() => clearMocks());

  it('sends the draft, the scope, the test id and the credential', async () => {
    const credential = { secret: 's3cret', remember: false as const };
    await expect(
      service.test({ ...request, hostId: 'h1' }, 't1', () => Promise.resolve(false), credential),
    ).resolves.toEqual(result);
    expect(calls[0].cmd).toBe('test_host');
    expect(calls[0].args).toMatchObject({
      host: request.host,
      projectId: 'p1',
      hostId: 'h1',
      testId: 't1',
      credential,
    });
  });

  it('never shows a tested host as connecting or connected', async () => {
    const ssh = TestBed.inject(SshService);
    onTest = (channel) =>
      new Promise((resolve) => {
        channel.onmessage({ kind: 'status', state: 'connecting' });
        channel.onmessage({ kind: 'status', state: 'authenticating' });
        setTimeout(() => {
          channel.onmessage({ kind: 'status', state: 'connected' });
          resolve(result);
        });
      });
    await service.test({ ...request, hostId: 'h1' }, 't1', () => Promise.resolve(true), null);
    await flush();
    expect(ssh.states()).toEqual({});
    expect(ssh.stateOf('h1')).toBe('idle');
    expect(calls.map((c) => c.cmd)).toEqual(['test_host']);
  });

  it('sends a null credential when none was typed', async () => {
    await service.test(request, 't1', () => Promise.resolve(false), null);
    expect(calls[0].args['credential']).toBeNull();
  });

  it('answers a host key prompt through answer_host_key', async () => {
    const decide = vi.fn(() => Promise.resolve(true));
    onTest = (channel) =>
      new Promise((resolve) => {
        channel.onmessage(prompt);
        setTimeout(() => resolve(result), 10);
      });
    await service.test(request, 't1', decide, null);
    await flush();
    expect(decide).toHaveBeenCalledWith(prompt);
    expect(calls.find((c) => c.cmd === 'answer_host_key')?.args).toEqual({
      requestId: 'r1',
      accept: true,
    });
  });

  it('rejects the key when deciding throws', async () => {
    onTest = (channel) =>
      new Promise((resolve) => {
        channel.onmessage(prompt);
        setTimeout(() => resolve(result), 10);
      });
    await service.test(request, 't1', () => Promise.reject(new Error('closed')), null);
    await flush();
    expect(calls.find((c) => c.cmd === 'answer_host_key')?.args['accept']).toBe(false);
  });

  it('ignores a changed key event: the command fails on its own', async () => {
    const decide = vi.fn(() => Promise.resolve(true));
    onTest = (channel) => {
      channel.onmessage({
        kind: 'hostKeyChanged',
        hostname: 'web.example',
        port: 22,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:new',
        knownFingerprints: ['SHA256:old'],
      });
      throw { code: 'host_key_changed', message: 'the host key has changed' };
    };
    const error = await service.test(request, 't1', decide, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe('host_key_changed');
    expect(decide).not.toHaveBeenCalled();
    expect(calls.map((c) => c.cmd)).toEqual(['test_host']);
  });

  it('maps a cancelled test to its code', async () => {
    onTest = () => {
      throw { code: 'cancelled', message: 'the test was cancelled' };
    };
    const error = await service
      .test(request, 't1', () => Promise.resolve(false), null)
      .catch((e: unknown) => e);
    expect((error as IpcError).code).toBe('cancelled');
  });

  it('cancels by test id', async () => {
    await service.cancel('t1');
    expect(calls).toEqual([{ cmd: 'cancel_host_test', args: { testId: 't1' } }]);
  });
});
