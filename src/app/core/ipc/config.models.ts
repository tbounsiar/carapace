/** A string with `${name}` variable references; `$$` is a literal `$`. */
export type Template = string;

export type VariableKind = 'plain' | 'secret';

/** `value` is null for a secret: its value never leaves the keychain, `hasValue` tells whether one is set. */
export interface VariableView {
  name: string;
  kind: VariableKind;
  value: string | null;
  hasValue: boolean;
}

/** `secretValue` is a newly typed value; null or absent keeps the stored one. */
export interface VariableInput {
  name: string;
  kind: VariableKind;
  value?: string | null;
  secretValue?: string | null;
}

export type VariableScope =
  | { kind: 'global' }
  | { kind: 'project'; projectId: string }
  | { kind: 'environment'; projectId: string; environmentId: string };

/** Secret fields are null (saved connection secret or prompt) or a single `${name}` reference. */
export type AuthMethod =
  | { kind: 'password'; password: Template | null }
  | { kind: 'key'; keyPath: Template; passphrase: Template | null }
  | { kind: 'agent' };

export interface HostInput {
  name: string;
  hostname: Template;
  port: Template;
  username: Template;
  auth: AuthMethod;
}

export interface Host extends HostInput {
  id: string;
}

export interface Environment {
  id: string;
  name: string;
  variables: VariableView[];
}

export interface Project {
  id: string;
  name: string;
  variables: VariableView[];
  environments: Environment[];
  hosts: Host[];
  activeEnvironmentId: string | null;
}

export interface ConfigView {
  variables: VariableView[];
  projects: Project[];
}

/** Plain fields after template resolution, null when they can't be resolved; never secret values. */
export interface ResolvedHost {
  hostname: string | null;
  port: number | string | null;
  username: string | null;
  keyPath: string | null;
  missing: string[];
  errors: string[];
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
  | 'keychain_unavailable'
  | 'not_connected'
  | 'busy'
  | 'permission_denied'
  | 'already_exists'
  | 'not_empty'
  | 'too_large'
  | 'missing_variables';

export type IpcErrorCode = CommandErrorCode | 'unknown';

export interface CommandError {
  code: CommandErrorCode;
  message: string;
}
