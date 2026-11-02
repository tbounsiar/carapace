import { Service } from '@angular/core';
import { invokeCommand } from './ipc-error';

export type SecretKind = 'password' | 'passphrase';

/** No command ever returns a secret value; the frontend can only drop what the prompt remembered. */
@Service()
export class SecretsService {
  async forgetSaved(hostId: string, environmentId: string | null): Promise<void> {
    await invokeCommand<null>('forget_saved_secrets', { hostId, environmentId });
  }
}
