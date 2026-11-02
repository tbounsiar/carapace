import { Service } from '@angular/core';
import { invokeCommand } from './ipc-error';

export type SecretKind = 'password' | 'passphrase';

/** Keychain access by opaque `(hostId, kind)` reference; no command ever returns a secret value. */
@Service()
export class SecretsService {
  async set(hostId: string, kind: SecretKind, value: string): Promise<void> {
    await invokeCommand<null>('set_host_secret', { hostId, kind, value });
  }

  async delete(hostId: string, kind: SecretKind): Promise<void> {
    await invokeCommand<null>('delete_host_secret', { hostId, kind });
  }

  has(hostId: string, kind: SecretKind): Promise<boolean> {
    return invokeCommand<boolean>('has_host_secret', { hostId, kind });
  }
}
