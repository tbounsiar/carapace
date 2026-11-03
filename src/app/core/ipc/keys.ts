import { Service } from '@angular/core';
import { invokeCommand } from './ipc-error';

export type KeyAlgorithm = 'ed25519' | 'rsa';

export type KeyType = 'ed25519' | 'rsa4096';

export interface KeyEntry {
  id: string;
  name: string;
  /** Absolute path of the private key. */
  path: string;
  /** Generated into the app home; external keys are only registered. */
  managed: boolean;
  algorithm: KeyAlgorithm;
  bits: number | null;
  /** OpenSSH public key line. */
  publicKey: string;
  /** `SHA256:...` */
  fingerprint: string;
  comment: string;
  encrypted: boolean;
}

export interface KeyView extends KeyEntry {
  hasPassphrase: boolean;
  warning: string | null;
}

/** The passphrase is sent once and never returned. */
export interface GenerateKeyRequest {
  name: string;
  fileName: string;
  algorithm: KeyType;
  comment: string;
  passphrase: string | null;
  rememberPassphrase: boolean;
}

export interface ImportKeyRequest {
  name: string;
  path: string;
  passphrase: string | null;
  rememberPassphrase: boolean;
}

export interface DeployResult {
  /** False when authorized_keys already held the key. */
  added: boolean;
  /** The key is only present on lines with options; nothing was written. */
  restricted: boolean;
}

@Service()
export class KeyIpc {
  list(): Promise<KeyView[]> {
    return invokeCommand<KeyView[]>('list_keys');
  }

  generate(request: GenerateKeyRequest): Promise<KeyView> {
    return invokeCommand<KeyView>('generate_key', { ...request });
  }

  import(request: ImportKeyRequest): Promise<KeyView> {
    return invokeCommand<KeyView>('import_key', { ...request });
  }

  rename(keyId: string, name: string): Promise<KeyView> {
    return invokeCommand<KeyView>('rename_key', { keyId, name });
  }

  async delete(keyId: string, deleteFiles: boolean): Promise<void> {
    await invokeCommand<null>('delete_key', { keyId, deleteFiles });
  }

  async forgetPassphrase(keyId: string): Promise<void> {
    await invokeCommand<null>('forget_key_passphrase', { keyId });
  }

  deploy(connectionId: string, keyId: string): Promise<DeployResult> {
    return invokeCommand<DeployResult>('deploy_public_key', { connectionId, keyId });
  }

  /** Absolute path of the directory holding generated keys. */
  keysDir(): Promise<string> {
    return invokeCommand<string>('keys_dir');
  }
}

export function keyTypeLabel(key: Pick<KeyEntry, 'algorithm' | 'bits'>): string {
  return key.algorithm === 'ed25519' ? 'Ed25519' : `RSA ${key.bits ?? 4096}`;
}
