import type { AuthMethod } from '../core/ipc/config.models';

export const AUTH_LABELS: Record<AuthMethod['kind'], string> = {
  password: 'Password',
  key: 'Private key file',
  agent: 'SSH agent',
};
