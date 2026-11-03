import { TestBed } from '@angular/core/testing';
import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { connectionTarget } from './connection';
import { IpcError } from './ipc-error';
import { SshService, type ConnectHandlers } from './ssh';
import type { ConnectEvent, HostKeyChanged, HostKeyPrompt } from './ssh.models';

const prompt: HostKeyPrompt = {
  kind: 'hostKeyPrompt',
  requestId: 'r1',
  status: 'unknown',
  hostname: 'web.example',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:abc',
};

const target = connectionTarget('p1', 'h1');
const info = { connectionId: 'h1', hostId: 'h1', state: 'connected' };

describe('SshService', () => {
  let service: SshService;
  let calls: { cmd: string; args: Record<string, unknown> }[];
  let onConnect: (channel: Channel<ConnectEvent>) => unknown;

  const handlers = (
    decide: ConnectHandlers['decide'] = () => Promise.resolve(false),
    changed: ConnectHandlers['changed'] = () => undefined,
  ): ConnectHandlers => ({ decide, changed });
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r));

  beforeEach(() => {
    calls = [];
    onConnect = () => info;
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      if (cmd === 'connect_host') {
        return onConnect(a['onEvent'] as Channel<ConnectEvent>);
      }
      if (cmd === 'list_connections') {
        return [{ connectionId: 'h9', hostId: 'h9', state: 'connected' }];
      }
      return null;
    });
    service = TestBed.inject(SshService);
  });

  afterEach(() => clearMocks());

  it('records why a connection ended and clears it on the next connect', async () => {
    await service.connect(target, handlers());
    service.ended('h1', 'lost');
    expect(service.stateOf('h1')).toBe('idle');
    expect(service.endReasons()['h1']).toBe('lost');
    await service.connect(target, handlers());
    expect(service.endReasons()['h1']).toBeUndefined();
    await service.disconnect('h1');
    expect(service.endReasons()['h1']).toBe('user');
  });

  it('is idle by default', () => {
    expect(service.stateOf('h1')).toBe('idle');
  });

  it('keeps separate states per host', async () => {
    await service.connect(target, handlers());
    expect(service.stateOf('h1')).toBe('connected');
    expect(service.stateOf('h2')).toBe('idle');
    onConnect = () => {
      throw { code: 'network', message: 'Connection refused' };
    };
    await service.connect(connectionTarget('p1', 'h2'), handlers()).catch(() => null);
    expect(service.stateOf('h2')).toBe('error');
    expect(service.stateOf('h1')).toBe('connected');
  });

  it('follows status events and ends connected', async () => {
    const seen: string[] = [];
    onConnect = (channel) => {
      channel.onmessage({ kind: 'status', state: 'connecting' });
      seen.push(service.stateOf('h1'));
      channel.onmessage({ kind: 'status', state: 'authenticating' });
      seen.push(service.stateOf('h1'));
      return info;
    };
    const result = await service.connect(target, handlers());
    expect(seen).toEqual(['connecting', 'authenticating']);
    expect(result).toEqual(info);
    expect(service.stateOf('h1')).toBe('connected');
    expect(calls[0].cmd).toBe('connect_host');
    expect(calls[0].args).toMatchObject({ hostId: 'h1' });
    expect(calls[0].args).not.toHaveProperty('projectId');
  });

  it('sends no credential by default', async () => {
    await service.connect(target, handlers());
    expect(calls[0].args['credential']).toBeNull();
  });

  it('sends the credential with connect_host', async () => {
    await service.connect(target, handlers(), { secret: 'pw', remember: true });
    expect(calls[0].args['credential']).toEqual({ secret: 'pw', remember: true });
  });

  it('sends the user decision for a host key prompt', async () => {
    const decide = vi.fn(() => Promise.resolve(true));
    onConnect = async (channel) => {
      channel.onmessage(prompt);
      expect(service.stateOf('h1')).toBe('awaitingHostKey');
      await flush();
      return info;
    };
    await service.connect(target, handlers(decide));
    expect(decide).toHaveBeenCalledWith(prompt);
    expect(calls.find((c) => c.cmd === 'answer_host_key')?.args).toEqual({
      requestId: 'r1',
      accept: true,
    });
  });

  it('rejects when the decider throws', async () => {
    onConnect = async (channel) => {
      channel.onmessage(prompt);
      await flush();
      throw { code: 'host_key_rejected', message: 'Host key rejected' };
    };
    const err = await service
      .connect(
        target,
        handlers(() => Promise.reject(new Error('boom'))),
      )
      .catch((e: unknown) => e);
    expect(calls.find((c) => c.cmd === 'answer_host_key')?.args['accept']).toBe(false);
    expect(err).toMatchObject({ code: 'host_key_rejected' });
    expect(service.stateOf('h1')).toBe('error');
  });

  it('maps backend errors to IpcError and sets the error state', async () => {
    onConnect = () => {
      throw { code: 'auth_failed', message: 'Authentication failed' };
    };
    const err = await service.connect(target, handlers()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect(err).toMatchObject({ code: 'auth_failed', message: 'Authentication failed' });
    expect(service.stateOf('h1')).toBe('error');
  });

  it('sends answerHostKey arguments', async () => {
    await service.answerHostKey('r2', false);
    expect(calls[0]).toEqual({
      cmd: 'answer_host_key',
      args: { requestId: 'r2', accept: false },
    });
  });

  it('disconnects and returns to idle', async () => {
    await service.connect(target, handlers());
    await service.disconnect('h1');
    expect(calls.at(-1)).toEqual({ cmd: 'disconnect_host', args: { connectionId: 'h1' } });
    expect(service.stateOf('h1')).toBe('idle');
  });

  it('loads existing connections into state', async () => {
    const list = await service.loadConnections();
    expect(list.map((c) => c.connectionId)).toEqual(['h9']);
    expect(service.stateOf('h9')).toBe('connected');
  });

  it('forwards a changed key event and sends replace_host_key arguments', async () => {
    const event: HostKeyChanged = {
      kind: 'hostKeyChanged',
      hostname: 'web.example',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:new',
      knownFingerprints: ['SHA256:old'],
    };
    const changed = vi.fn();
    onConnect = (channel) => {
      channel.onmessage(event);
      throw { code: 'host_key_changed', message: 'Host key changed' };
    };
    const err = await service
      .connect(target, handlers(undefined, changed))
      .catch((e: unknown) => e);
    expect(changed).toHaveBeenCalledWith(event);
    expect(err).toMatchObject({ code: 'host_key_changed' });
    await service.replaceHostKey('h1', 'SHA256:new');
    expect(calls.at(-1)).toEqual({
      cmd: 'replace_host_key',
      args: { connectionId: 'h1', fingerprint: 'SHA256:new' },
    });
  });
});
