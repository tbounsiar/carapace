import { TestBed } from '@angular/core/testing';
import { IpcError } from './ipc-error';
import { KeyStore } from './key-store';
import { KeyIpc } from './keys';
import { KEY, key } from './keys.fixture';

describe('KeyStore', () => {
  const ipc = {
    list: vi.fn(),
    generate: vi.fn(),
    import: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(() => Promise.resolve()),
    forgetPassphrase: vi.fn(() => Promise.resolve()),
    deploy: vi.fn(() => Promise.resolve({ added: true, restricted: false })),
    keysDir: vi.fn(),
  };
  let store: KeyStore;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [{ provide: KeyIpc, useValue: ipc }] });
    store = TestBed.inject(KeyStore);
  });

  it('loads the list', async () => {
    ipc.list.mockResolvedValue([KEY]);
    await store.load();
    expect(store.keys()).toEqual([KEY]);
    expect(store.loaded()).toBe(true);
  });

  it('loads once with ensureLoaded and retries after a failure', async () => {
    ipc.list.mockRejectedValueOnce(new IpcError('io', 'boom')).mockResolvedValue([KEY]);
    await expect(store.ensureLoaded()).rejects.toBeInstanceOf(IpcError);
    expect(store.loaded()).toBe(false);
    await Promise.all([store.ensureLoaded(), store.ensureLoaded()]);
    await store.ensureLoaded();
    expect(ipc.list).toHaveBeenCalledTimes(2);
    expect(store.keys()).toEqual([KEY]);
  });

  it('appends generated and imported keys', async () => {
    const other = key({ id: 'k2', name: 'work', managed: false });
    ipc.generate.mockResolvedValue(KEY);
    ipc.import.mockResolvedValue(other);
    await store.generate({
      name: KEY.name,
      fileName: KEY.name,
      algorithm: 'ed25519',
      comment: 'carapace',
      passphrase: null,
      rememberPassphrase: false,
    });
    await store.import({ name: 'work', path: '/k', passphrase: null, rememberPassphrase: false });
    expect(store.keys()).toEqual([KEY, other]);
  });

  it('renames, forgets the passphrase and deletes', async () => {
    ipc.list.mockResolvedValue([key({ hasPassphrase: true })]);
    await store.load();
    ipc.rename.mockResolvedValue(key({ name: 'main', hasPassphrase: true }));
    await store.rename('k1', 'main');
    expect(store.keys()[0].name).toBe('main');
    await store.forgetPassphrase('k1');
    expect(store.keys()[0].hasPassphrase).toBe(false);
    await store.delete('k1', true);
    expect(ipc.delete).toHaveBeenCalledWith('k1', true);
    expect(store.keys()).toEqual([]);
  });

  it('reloads the list when the key was added but its passphrase not remembered', async () => {
    ipc.import.mockRejectedValueOnce(new IpcError('keychain_unavailable', 'No keychain'));
    ipc.list.mockResolvedValue([KEY]);
    const request = { name: 'k', path: '/k', passphrase: 'x', rememberPassphrase: true };
    await expect(store.import(request)).rejects.toBeInstanceOf(IpcError);
    expect(store.keys()).toEqual([KEY]);
    ipc.import.mockRejectedValueOnce(new IpcError('invalid_input', 'bad'));
    await expect(store.import(request)).rejects.toBeInstanceOf(IpcError);
    expect(ipc.list).toHaveBeenCalledTimes(1);
  });

  it('keeps the list on a failed delete', async () => {
    ipc.list.mockResolvedValue([KEY]);
    await store.load();
    ipc.delete.mockRejectedValueOnce(new IpcError('io', 'boom'));
    await expect(store.delete('k1', false)).rejects.toBeInstanceOf(IpcError);
    expect(store.keys()).toEqual([KEY]);
  });

  it('loads the keys dir once and retries after a failure', async () => {
    expect(store.keysDir()).toBeNull();
    ipc.keysDir
      .mockRejectedValueOnce(new IpcError('io', 'boom'))
      .mockResolvedValue('/home/me/.carapace/keys');
    await expect(store.loadKeysDir()).rejects.toBeInstanceOf(IpcError);
    expect(store.keysDir()).toBeNull();
    await Promise.all([store.loadKeysDir(), store.loadKeysDir()]);
    await store.loadKeysDir();
    expect(ipc.keysDir).toHaveBeenCalledTimes(2);
    expect(store.keysDir()).toBe('/home/me/.carapace/keys');
  });

  it('deploys through the ipc', async () => {
    expect(await store.deploy('h1', 'k1')).toEqual({ added: true, restricted: false });
    expect(ipc.deploy).toHaveBeenCalledWith('h1', 'k1');
  });
});
