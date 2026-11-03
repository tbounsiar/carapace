import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { IpcError } from './ipc-error';
import { SecretsService } from './secrets';

describe('SecretsService', () => {
  let service: SecretsService;
  let calls: { cmd: string; args: unknown }[];
  let reply: () => unknown;

  beforeEach(() => {
    calls = [];
    reply = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return reply();
    });
    service = TestBed.inject(SecretsService);
  });

  afterEach(() => clearMocks());

  it('forgets the saved secrets of one host', async () => {
    await service.forgetSaved('h1');
    expect(calls).toEqual([{ cmd: 'forget_saved_secrets', args: { hostId: 'h1' } }]);
  });

  it('maps keychain errors to IpcError', async () => {
    reply = () => {
      throw { code: 'keychain_unavailable', message: 'Keychain unavailable' };
    };
    const err = await service.forgetSaved('h1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect(err).toMatchObject({ code: 'keychain_unavailable' });
  });
});
