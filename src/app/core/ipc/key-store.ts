import { inject, Service, signal } from '@angular/core';
import { IpcError } from './ipc-error';
import {
  type DeployResult,
  type GenerateKeyRequest,
  type ImportKeyRequest,
  KeyIpc,
  type KeyView,
} from './keys';

@Service()
export class KeyStore {
  private readonly ipc = inject(KeyIpc);
  private readonly _keys = signal<KeyView[]>([]);
  private readonly _loaded = signal(false);
  private readonly _keysDir = signal<string | null>(null);
  private pending: Promise<void> | null = null;
  private pendingDir: Promise<void> | null = null;

  readonly keys = this._keys.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  /** Null until `loadKeysDir` succeeds. */
  readonly keysDir = this._keysDir.asReadonly();

  async load(): Promise<void> {
    this._keys.set(await this.ipc.list());
    this._loaded.set(true);
  }

  /** Loads once; a failed load can be retried. */
  ensureLoaded(): Promise<void> {
    if (this._loaded()) {
      return Promise.resolve();
    }
    this.pending ??= this.load().finally(() => (this.pending = null));
    return this.pending;
  }

  /** Loads once; a failure leaves it null and allows a later retry. */
  loadKeysDir(): Promise<void> {
    if (this._keysDir() !== null) {
      return Promise.resolve();
    }
    this.pendingDir ??= this.ipc
      .keysDir()
      .then((dir) => this._keysDir.set(dir))
      .finally(() => (this.pendingDir = null));
    return this.pendingDir;
  }

  generate(request: GenerateKeyRequest): Promise<KeyView> {
    return this.add(this.ipc.generate(request));
  }

  import(request: ImportKeyRequest): Promise<KeyView> {
    return this.add(this.ipc.import(request));
  }

  async rename(keyId: string, name: string): Promise<KeyView> {
    const key = await this.ipc.rename(keyId, name);
    this.replace(key);
    return key;
  }

  async delete(keyId: string, deleteFiles: boolean): Promise<void> {
    await this.ipc.delete(keyId, deleteFiles);
    this._keys.update((list) => list.filter((k) => k.id !== keyId));
  }

  async forgetPassphrase(keyId: string): Promise<void> {
    await this.ipc.forgetPassphrase(keyId);
    this._keys.update((list) =>
      list.map((k) => (k.id === keyId ? { ...k, hasPassphrase: false } : k)),
    );
  }

  deploy(connectionId: string, keyId: string): Promise<DeployResult> {
    return this.ipc.deploy(connectionId, keyId);
  }

  private async add(request: Promise<KeyView>): Promise<KeyView> {
    try {
      const key = await request;
      this._keys.update((list) => [...list, key]);
      return key;
    } catch (err) {
      // The key is registered even when remembering its passphrase failed.
      if (err instanceof IpcError && err.code === 'keychain_unavailable') {
        await this.load().catch(() => undefined);
      }
      throw err;
    }
  }

  private replace(key: KeyView): void {
    this._keys.update((list) => list.map((k) => (k.id === key.id ? key : k)));
  }
}
