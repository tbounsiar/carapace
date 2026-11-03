import type { HostTestResult } from '../../core/ipc/host-test';
import type { IpcError } from '../../core/ipc/ipc-error';
import { errorText, sentence } from '../project-tree/save-error';
import type { HostTestDraft, HostTestOutcome, SecretOrigin } from './host-tester';

/** A piece of copy; `mono` for addresses, paths and references. */
export interface Part {
  readonly text: string;
  readonly mono?: boolean;
}

export type HostTestState = 'testing' | 'success' | 'failure' | 'cancelled';

export interface HostTestView {
  readonly state: HostTestState;
  readonly code: string | null;
  readonly title: readonly Part[];
  readonly detail: readonly Part[];
}

const text = (value: string): Part => ({ text: value });
const mono = (value: string): Part => ({ text: value, mono: true });

export function testingView(draft: HostTestDraft): HostTestView {
  return {
    state: 'testing',
    code: null,
    title: [text('Testing '), mono(draft.address), text('...')],
    detail: [],
  };
}

export const CANCELLED_VIEW: HostTestView = {
  state: 'cancelled',
  code: null,
  title: [text('Test cancelled.')],
  detail: [],
};

/** Null for an aborted test: the values it was testing are gone, nothing is shown. */
export function outcomeView(outcome: HostTestOutcome, draft: HostTestDraft): HostTestView | null {
  switch (outcome.kind) {
    case 'aborted':
      return null;
    case 'cancelled':
      return CANCELLED_VIEW;
    case 'success':
      return {
        state: 'success',
        code: null,
        title: [text('Connected as '), mono(outcome.result.address)],
        detail: [...authParts(outcome.result, draft), text(` · ${duration(outcome.durationMs)}`)],
      };
    case 'failure':
      return failureView(outcome.error, outcome.origin, draft);
  }
}

/** "N ms" under one second, else "N.N s". */
export function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function reference(draft: HostTestDraft): string {
  const auth = draft.host.auth;
  return (
    (auth.kind === 'password' ? auth.password : auth.kind === 'key' ? auth.passphrase : '') ?? ''
  );
}

function authParts(result: HostTestResult, draft: HostTestDraft): Part[] {
  const source = result.secretSource;
  if (result.authKind === 'agent') {
    return [text('SSH agent')];
  }
  if (result.authKind === 'password') {
    if (source === 'typed') {
      return [text('Password (typed for this test)')];
    }
    if (source === 'variable') {
      return [text('Password from '), mono(reference(draft))];
    }
    return [text(source ? 'Password saved in the keychain' : 'Password')];
  }
  if (source === 'typed') {
    return [text('Private key file, passphrase typed for this test')];
  }
  if (source === 'variable') {
    return [text('Private key file, passphrase from '), mono(reference(draft))];
  }
  return [text(source ? 'Private key file, saved passphrase' : 'Private key file')];
}

function split(address: string): { user: string; hostPort: string } {
  const at = address.lastIndexOf('@');
  return { user: address.slice(0, Math.max(at, 0)), hostPort: address.slice(at + 1) };
}

function origin(
  secret: 'password' | 'passphrase',
  from: SecretOrigin,
  draft: HostTestDraft,
): Part[] {
  if (from === 'variable') {
    return [text(`The ${secret} came from `), mono(reference(draft)), text('. ')];
  }
  return from === 'stored' ? [text(`The ${secret} came from the keychain. `)] : [];
}

function failure(code: string, title: Part[], detail: Part[]): HostTestView {
  return { state: 'failure', code, title, detail };
}

function failureView(err: IpcError, from: SecretOrigin, draft: HostTestDraft): HostTestView {
  const { user, hostPort } = split(draft.address);
  const auth = draft.host.auth.kind;
  const detail = err.message.trim() ? `${sentence(err.message)} ` : '';
  switch (err.code) {
    case 'network':
      return failure(
        err.code,
        [text('Could not reach '), mono(hostPort)],
        [text(`${detail}Check the hostname, the port and your network.`)],
      );
    case 'timeout':
      return failure(
        err.code,
        [text('No answer from '), mono(hostPort)],
        [
          text(
            'The server did not respond within 15 seconds. Check the hostname, the port, a VPN or a firewall.',
          ),
        ],
      );
    case 'auth_failed':
      if (auth === 'password') {
        return failure(
          err.code,
          [text('The server rejected the password')],
          [
            ...origin('password', from, draft),
            text('Check the username, then the password or the secret variable it uses.'),
          ],
        );
      }
      if (auth === 'key') {
        return failure(
          err.code,
          [text('The server refused the key')],
          [
            text('Check that its public key is in '),
            mono('~/.ssh/authorized_keys'),
            text(' of '),
            mono(user),
            text(' on the server, or pick another key.'),
          ],
        );
      }
      return failure(
        err.code,
        [text('The SSH agent offered no accepted key')],
        [
          text(
            `${detail}Check that the agent is running and holds a key authorized on the server.`,
          ),
        ],
      );
    case 'invalid_passphrase':
      if (auth === 'key') {
        return failure(
          err.code,
          [text('Wrong passphrase for '), mono(draft.keyPath)],
          [
            ...origin('passphrase', from, draft),
            text('Check the secret variable, or choose “Ask when connecting” and type it.'),
          ],
        );
      }
      break;
    case 'host_key_rejected':
      return failure(
        err.code,
        [text('Host key not accepted')],
        [
          text(
            'Test again and accept the key if the fingerprint matches the one from the server administrator.',
          ),
        ],
      );
    case 'host_key_changed':
      return failure(
        err.code,
        [text('Host key has changed')],
        [
          text('The server presents a different key than the one stored for '),
          mono(hostPort),
          text(
            '. Confirm it with the server administrator; to replace it, save the host and connect.',
          ),
        ],
      );
    case 'host_key_revoked':
      return failure(
        err.code,
        [text('Host key is revoked')],
        [
          text('The key presented by '),
          mono(hostPort),
          text(' is marked as revoked in known_hosts. Contact the server administrator.'),
        ],
      );
    case 'invalid_input':
      if (auth === 'key') {
        return failure(
          err.code,
          [text('Key file not usable')],
          [text(`${detail}Check the key path.`)],
        );
      }
      break;
    case 'io':
    case 'not_found':
      if (/known_hosts/i.test(err.message)) {
        return failure(err.code, [text('Could not read known_hosts')], [text(detail.trim())]);
      }
      if (auth === 'key') {
        return failure(
          err.code,
          [text('Could not read '), mono(draft.keyPath)],
          [text(`${detail}Check the key path, or pick a registered key.`)],
        );
      }
      break;
    case 'keychain_unavailable':
      return failure(
        err.code,
        [text('System keychain unavailable')],
        [text('Unlock or enable it, or choose “Ask when connecting”.')],
      );
    case 'missing_variables':
      return failure(
        err.code,
        [text('Missing variables')],
        [text(`${detail}Define them in the global or project variables.`)],
      );
    case 'busy':
      return failure(
        err.code,
        [text('Too many tests are running')],
        [text('Wait for one to finish, then test again.')],
      );
  }
  return failure(err.code, [text('Test failed')], [text(errorText(err))]);
}
