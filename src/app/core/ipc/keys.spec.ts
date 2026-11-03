import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { IpcError } from './ipc-error';
import { KeyIpc, keyTypeLabel } from './keys';
import { KEY } from './keys.fixture';

describe('KeyIpc', () => {
  let ipc: KeyIpc;
  let calls: { cmd: string; args: Record<string, unknown> }[];
  let onCall: (cmd: string, args: Record<string, unknown>) => unknown;

  beforeEach(() => {
    calls = [];
    onCall = () => null;
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      return onCall(cmd, a);
    });
    ipc = TestBed.inject(KeyIpc);
  });

  afterEach(() => clearMocks());

  it('lists keys', async () => {
    onCall = () => [KEY];
    expect(await ipc.list()).toEqual([KEY]);
    expect(calls).toEqual([{ cmd: 'list_keys', args: {} }]);
  });

  it('generates and imports with flat arguments', async () => {
    onCall = () => KEY;
    await ipc.generate({
      name: 'id_ed25519',
      fileName: 'id_ed25519',
      algorithm: 'ed25519',
      comment: 'carapace',
      passphrase: 'pw',
      rememberPassphrase: false,
    });
    await ipc.import({
      name: 'work',
      path: '~/.ssh/id_rsa',
      passphrase: null,
      rememberPassphrase: false,
    });
    expect(calls).toEqual([
      {
        cmd: 'generate_key',
        args: {
          name: 'id_ed25519',
          fileName: 'id_ed25519',
          algorithm: 'ed25519',
          comment: 'carapace',
          passphrase: 'pw',
          rememberPassphrase: false,
        },
      },
      {
        cmd: 'import_key',
        args: { name: 'work', path: '~/.ssh/id_rsa', passphrase: null, rememberPassphrase: false },
      },
    ]);
  });

  it('renames, deletes, forgets and deploys', async () => {
    onCall = (cmd) =>
      cmd === 'deploy_public_key'
        ? { added: true, restricted: false }
        : cmd === 'rename_key'
          ? KEY
          : null;
    await ipc.rename('k1', 'main');
    await ipc.delete('k1', true);
    await ipc.forgetPassphrase('k1');
    expect(await ipc.deploy('h1@e1', 'k1')).toEqual({ added: true, restricted: false });
    expect(calls).toEqual([
      { cmd: 'rename_key', args: { keyId: 'k1', name: 'main' } },
      { cmd: 'delete_key', args: { keyId: 'k1', deleteFiles: true } },
      { cmd: 'forget_key_passphrase', args: { keyId: 'k1' } },
      { cmd: 'deploy_public_key', args: { connectionId: 'h1@e1', keyId: 'k1' } },
    ]);
  });

  it('asks for the keys dir', async () => {
    onCall = () => 'C:\\Users\\me\\.carapace\\keys';
    expect(await ipc.keysDir()).toBe('C:\\Users\\me\\.carapace\\keys');
    expect(calls).toEqual([{ cmd: 'keys_dir', args: {} }]);
  });

  it('maps errors', async () => {
    onCall = () => {
      throw { code: 'invalid_passphrase', message: 'Wrong passphrase' };
    };
    const err = await ipc
      .import({ name: 'a', path: '/k', passphrase: 'x', rememberPassphrase: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).code).toBe('invalid_passphrase');
  });

  it('labels key types', () => {
    expect(keyTypeLabel({ algorithm: 'ed25519', bits: null })).toBe('Ed25519');
    expect(keyTypeLabel({ algorithm: 'rsa', bits: 4096 })).toBe('RSA 4096');
  });
});
