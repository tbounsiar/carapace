import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { IpcError } from './ipc-error';
import { SecretsService } from './secrets';

describe('SecretsService', () => {
  let service: SecretsService;
  let calls: { cmd: string; args: unknown }[];
  let reply: (cmd: string) => unknown;

  beforeEach(() => {
    calls = [];
    reply = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return reply(cmd);
    });
    service = TestBed.inject(SecretsService);
  });

  afterEach(() => clearMocks());

  it('sends set_host_secret arguments', async () => {
    await service.set('h1', 'password', 'pw');
    expect(calls).toEqual([
      { cmd: 'set_host_secret', args: { hostId: 'h1', kind: 'password', value: 'pw' } },
    ]);
  });

  it('sends delete_host_secret arguments', async () => {
    await service.delete('h1', 'passphrase');
    expect(calls).toEqual([
      { cmd: 'delete_host_secret', args: { hostId: 'h1', kind: 'passphrase' } },
    ]);
  });

  it('returns the has_host_secret answer', async () => {
    reply = () => true;
    await expect(service.has('h1', 'password')).resolves.toBe(true);
    expect(calls).toEqual([{ cmd: 'has_host_secret', args: { hostId: 'h1', kind: 'password' } }]);
  });

  it('maps keychain errors to IpcError', async () => {
    reply = () => {
      throw { code: 'keychain_unavailable', message: 'Keychain unavailable' };
    };
    const err = await service.set('h1', 'password', 'pw').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect(err).toMatchObject({ code: 'keychain_unavailable' });
  });
});
