export type AuthMethod =
  { kind: 'password' } | { kind: 'key'; keyPath: string } | { kind: 'agent' };

export interface HostInput {
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
}

export interface Host extends HostInput {
  id: string;
}

export interface Environment {
  id: string;
  name: string;
  hosts: Host[];
}

export interface Project {
  id: string;
  name: string;
  environments: Environment[];
}

export type CommandErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'io'
  | 'corrupt_config'
  | 'host_key_rejected'
  | 'auth_failed'
  | 'unsupported'
  | 'timeout'
  | 'network'
  | 'host_key_changed'
  | 'host_key_revoked'
  | 'secret_required'
  | 'invalid_passphrase'
  | 'keychain_unavailable';

export type IpcErrorCode = CommandErrorCode | 'unknown';

export interface CommandError {
  code: CommandErrorCode;
  message: string;
}
