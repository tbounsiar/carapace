import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import type { CommandErrorCode, IpcErrorCode } from './config.models';

const KNOWN_CODES: readonly string[] = [
  'not_found',
  'invalid_input',
  'conflict',
  'io',
  'corrupt_config',
  'host_key_rejected',
  'auth_failed',
  'unsupported',
  'timeout',
  'network',
  'host_key_changed',
  'host_key_revoked',
  'secret_required',
  'invalid_passphrase',
  'keychain_unavailable',
  'not_connected',
  'busy',
  'permission_denied',
  'already_exists',
  'not_empty',
  'too_large',
  'missing_variables',
  'cancelled',
  'not_text',
  'partial_write',
  'large_file',
  'sensitive',
  'blocked_type',
  'app_not_found',
  'app_not_editor',
  'app_failed',
  'host_changed',
  'not_regular_file',
  'not_uploaded',
  'import_format',
  'import_version',
  'import_malformed',
  'import_invalid',
  'import_secret_value',
];

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

function toIpcError(raw: unknown): IpcError {
  if (raw instanceof IpcError) {
    return raw;
  }
  if (typeof raw === 'object' && raw !== null) {
    const { code, message } = raw as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && typeof message === 'string' && KNOWN_CODES.includes(code)) {
      return new IpcError(code as CommandErrorCode, message);
    }
  }
  return new IpcError('unknown', 'Unexpected error');
}

export async function invokeCommand<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toIpcError(err);
  }
}
