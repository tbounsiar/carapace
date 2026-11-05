import type { AuthMethod } from '../core/ipc/config.models';
import { uiText } from './ui-text';

export function authLabel(kind: AuthMethod['kind']): string {
  return uiText(`common.auth.${kind}`);
}

/** Read in the active language at each access. */
export const AUTH_LABELS: Readonly<Record<AuthMethod['kind'], string>> = {
  get password() {
    return authLabel('password');
  },
  get key() {
    return authLabel('key');
  },
  get agent() {
    return authLabel('agent');
  },
};
